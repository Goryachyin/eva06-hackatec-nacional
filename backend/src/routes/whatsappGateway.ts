import crypto from "crypto";
import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { redis, redisSubscriber, WHATSAPP_OUTBOUND_PUBSUB_CHANNEL } from "../lib/redis";
import {
  normalizePhone,
  signGatewayPayload,
  verifyGatewaySignature,
} from "../lib/crypto";
import {
  drainPendingGatewayOutbound,
  getSimulatedChatHistory,
  processWhatsAppInbound,
  whatsappInboundQueue,
} from "../queues/whatsappQueue";

const MSG_ID_KEY = (messageId: string) => `wamid:${messageId}`;

const gatewayInboundSchema = z.object({
  messageId: z.string().min(4),
  fromPhone: z.string().min(10),
  remoteJid: z.string().optional(),
  text: z.string().min(1),
  receivedAt: z.string().optional(),
});

const simulateSchema = z.object({
  fromPhone: z.string().min(10),
  text: z.string().min(1),
  wamid: z.string().optional(),
});

// Gateways Baileys locales conectados por SSE autenticado
const gatewaySseClients = new Set<FastifyReply>();
let outboundPubSubReady = false;

async function ensureOutboundBridge() {
  if (outboundPubSubReady) return;
  outboundPubSubReady = true;

  await redisSubscriber.subscribe(WHATSAPP_OUTBOUND_PUBSUB_CHANNEL);
  redisSubscriber.on("message", (channel, message) => {
    if (channel !== WHATSAPP_OUTBOUND_PUBSUB_CHANNEL) return;
    const frame = `event: outbound_message\ndata: ${message}\n\n`;
    for (const client of gatewaySseClients) {
      try {
        client.raw.write(frame);
      } catch {
        gatewaySseClients.delete(client);
      }
    }
  });
}

async function claimMessageId(messageId: string): Promise<boolean> {
  const res = await redis.set(MSG_ID_KEY(messageId), "1", "EX", env.WAMID_TTL_SECONDS, "NX");
  return res === "OK";
}

export async function whatsappGatewayRoutes(app: FastifyInstance) {
  await ensureOutboundBridge();

  /**
   * 1. Ingesta firmada extremo a extremo desde el Gateway Baileys Local (POST /api/gateways/whatsapp/inbound)
   *    - Verifica X-Gateway-Signature (HMAC-SHA256) + X-Gateway-Timestamp (ventana anti-replay)
   *    - Idempotencia atomica Redis SETNX por messageId (TTL 24h)
   *    - Encola job en BullMQ (whatsapp-inbound -> 3 reintentos + DLQ) y devuelve ACK firmado
   */
  app.post(
    "/api/gateways/whatsapp/inbound",
    {
      config: { rawBody: true },
      schema: {
        tags: ["Canal 2: Gateway WhatsApp (Baileys E2E)"],
        summary: "Recibe mensajes del Gateway Baileys local validando firma digital HMAC-SHA256 e idempotencia",
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-gateway-signature"] as string | undefined;
      const timestamp = request.headers["x-gateway-timestamp"] as string | undefined;
      const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

      const check = verifyGatewaySignature({
        rawBody,
        signatureHeader: signature,
        timestampHeader: timestamp,
        secret: env.WHATSAPP_GATEWAY_SECRET,
        maxSkewSeconds: env.GATEWAY_SIGNATURE_TTL_SECONDS,
      });

      if (!check.ok) {
        request.log.warn(`[WhatsApp Gateway] Firma rechazada: ${check.reason}`);
        return reply.status(401).send({
          error: "INVALID_GATEWAY_SIGNATURE",
          message: check.reason,
        });
      }

      const body = gatewayInboundSchema.parse(request.body);
      const isFirstTime = await claimMessageId(body.messageId);

      if (!isFirstTime) {
        return reply.status(200).send({
          status: "duplicate_ignored",
          duplicate: true,
          messageId: body.messageId,
        });
      }

      const correlationId = crypto.randomUUID();
      await whatsappInboundQueue.add("baileys-message", {
        messageId: body.messageId,
        fromPhone: normalizePhone(body.fromPhone),
        remoteJid: body.remoteJid,
        text: body.text,
        source: "baileys",
        correlationId,
        receivedAt: body.receivedAt ?? new Date().toISOString(),
      });

      const ackPayload = {
        status: "accepted",
        duplicate: false,
        messageId: body.messageId,
        correlationId,
      };
      const ackTs = String(Math.floor(Date.now() / 1000));
      const ackSig = signGatewayPayload(
        ackTs,
        JSON.stringify(ackPayload),
        env.WHATSAPP_GATEWAY_SECRET
      );

      return reply
        .status(202)
        .header("X-Orchestrator-Timestamp", ackTs)
        .header("X-Orchestrator-Signature", ackSig)
        .send(ackPayload);
    }
  );

  /**
   * 2. Stream SSE saliente autenticado (AWS Orquestador -> Gateway Baileys Local)
   *    Cada mensaje saliente va firmado con HMAC-SHA256 para verificacion extremo a extremo.
   */
  app.get(
    "/api/gateways/whatsapp/outbound/stream",
    {
      schema: {
        tags: ["Canal 2: Gateway WhatsApp (Baileys E2E)"],
        summary: "Stream SSE autenticado con firma HMAC-SHA256 para entregar respuestas al Gateway Baileys local",
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-gateway-signature"] as string | undefined;
      const timestamp = request.headers["x-gateway-timestamp"] as string | undefined;

      const check = verifyGatewaySignature({
        rawBody: "GET:/api/gateways/whatsapp/outbound/stream",
        signatureHeader: signature,
        timestampHeader: timestamp,
        secret: env.WHATSAPP_GATEWAY_SECRET,
        maxSkewSeconds: env.GATEWAY_SIGNATURE_TTL_SECONDS,
      });

      if (!check.ok) {
        return reply.status(401).send({
          error: "INVALID_GATEWAY_SIGNATURE",
          message: check.reason,
        });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({
          status: "gateway_connected",
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      gatewaySseClients.add(reply);

      // Entregar mensajes encolados mientras el gateway estuvo reconectando
      const pending = await drainPendingGatewayOutbound();
      for (const envMsg of pending) {
        reply.raw.write(`event: outbound_message\ndata: ${JSON.stringify(envMsg)}\n\n`);
      }

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          gatewaySseClients.delete(reply);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        gatewaySseClients.delete(reply);
      });

      return reply;
    }
  );

  /**
   * 3. Estado rapido del Gateway (cuantos nodos Baileys estan conectados en esta instancia)
   */
  app.get(
    "/api/gateways/whatsapp/status",
    {
      schema: {
        tags: ["Canal 2: Gateway WhatsApp (Baileys E2E)"],
        summary: "Reporta el estado de conexión del Gateway Baileys local con firma E2E",
      },
    },
    async () => {
      return {
        connectedGateways: gatewaySseClients.size,
        transport: "Baileys Local <-> Orquestador HTTPS/SSE + HMAC-SHA256 E2E",
      };
    }
  );

  /**
   * 4. Respaldo QA — Simulador WhatsApp (ejecuta la misma logica deterministica e idempotencia)
   */
  app.post(
    "/api/channels/whatsapp/simulate",
    {
      schema: {
        tags: ["Canal 2: Gateway WhatsApp (Baileys E2E)"],
        summary: "Simulador QA de respaldo (usa el mismo motor determinístico e idempotencia Redis)",
        body: {
          type: "object",
          required: ["fromPhone", "text"],
          properties: {
            fromPhone: { type: "string", examples: ["+526670000001"] },
            text: { type: "string", examples: ["Hola, quiero continuar con mi estudio"] },
            wamid: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = simulateSchema.parse(request.body);
      const messageId = body.wamid ?? `sim_msg_${crypto.randomUUID()}`;
      const isFirstTime = await claimMessageId(messageId);

      if (!isFirstTime) {
        return reply.status(200).send({
          duplicate: true,
          wamid: messageId,
          message: "Mensaje duplicado ignorado por control de idempotencia (Redis SETNX).",
        });
      }

      const correlationId = crypto.randomUUID();
      const result = await processWhatsAppInbound({
        messageId,
        fromPhone: normalizePhone(body.fromPhone),
        text: body.text,
        source: "simulator",
        correlationId,
        receivedAt: new Date().toISOString(),
      });

      const history = await getSimulatedChatHistory(body.fromPhone);

      return reply.status(200).send({
        duplicate: false,
        wamid: messageId,
        correlationId,
        reply: result.reply,
        history,
      });
    }
  );

  app.get(
    "/api/channels/whatsapp/history/:phone",
    {
      schema: {
        tags: ["Canal 2: Gateway WhatsApp (Baileys E2E)"],
        summary: "Obtiene el historial de mensajes del canal WhatsApp para un teléfono",
      },
    },
    async (request) => {
      const { phone } = request.params as { phone: string };
      const history = await getSimulatedChatHistory(phone);
      return { phone: normalizePhone(phone), history };
    }
  );
}
