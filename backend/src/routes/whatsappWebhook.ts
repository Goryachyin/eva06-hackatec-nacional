import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { redis } from "../lib/redis";
import { normalizePhone, verifyMetaSignature } from "../lib/crypto";
import {
  getSimulatedChatHistory,
  processWhatsAppInbound,
  whatsappInboundQueue,
} from "../queues/whatsappQueue";

const WAMID_KEY = (wamid: string) => `wamid:${wamid}`;

const simulateSchema = z.object({
  fromPhone: z.string().min(10),
  text: z.string().min(1),
  wamid: z.string().optional(),
});

/**
 * Control de idempotencia atomico en Redis:
 * SET wamid:<id> 1 NX EX 86400 -> retorna true solo la primera vez.
 */
async function claimWamid(wamid: string): Promise<boolean> {
  const res = await redis.set(WAMID_KEY(wamid), "1", "EX", env.WAMID_TTL_SECONDS, "NX");
  return res === "OK";
}

export async function whatsappRoutes(app: FastifyInstance) {
  /**
   * 1. Verificacion inicial del Webhook en Meta for Developers (GET /webhooks/whatsapp)
   */
  app.get(
    "/webhooks/whatsapp",
    {
      schema: {
        tags: ["Canal 2: WhatsApp Cloud API"],
        summary: "Endpoint GET de verificación de Webhook para Meta for Developers",
        querystring: {
          type: "object",
          properties: {
            "hub.mode": { type: "string" },
            "hub.verify_token": { type: "string" },
            "hub.challenge": { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;
      const mode = q["hub.mode"];
      const token = q["hub.verify_token"];
      const challenge = q["hub.challenge"];

      if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
        request.log.info("[WhatsApp Webhook] Verificación GET exitosa con Meta.");
        return reply.status(200).type("text/plain").send(challenge);
      }

      request.log.warn("[WhatsApp Webhook] Intento de verificación GET rechazado.");
      return reply.status(403).send("Forbidden");
    }
  );

  /**
   * 2. Recepcion segura de mensajes de Meta WhatsApp Cloud API (POST /webhooks/whatsapp)
   *    - Valida firma criptografica X-Hub-Signature-256 sobre rawBody (HMAC-SHA256)
   *    - Aplica idempotencia por wamid mediante Redis SETNX + TTL 24h
   *    - Encola job en BullMQ (reintentos + DLQ) y responde HTTP 200 OK en <200ms
   */
  app.post(
    "/webhooks/whatsapp",
    {
      config: {
        rawBody: true,
      },
      schema: {
        tags: ["Canal 2: WhatsApp Cloud API"],
        summary: "Recibe eventos reales de Meta con validación HMAC-SHA256, idempotencia wamid y BullMQ",
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const rawBody = (request as unknown as { rawBody?: string | Buffer }).rawBody;

      // Seguridad obligatoria: verificar HMAC-SHA256 sobre rawBody
      if (!env.META_APP_SECRET) {
        request.log.error("[WhatsApp Webhook] META_APP_SECRET no configurado en .env");
        return reply.status(500).send({
          error: "MISCONFIGURED_WEBHOOK",
          message: "META_APP_SECRET es obligatorio para validar X-Hub-Signature-256.",
        });
      }

      const validSig = verifyMetaSignature(rawBody, signature, env.META_APP_SECRET);
      if (!validSig) {
        request.log.warn("[WhatsApp Webhook] Firma X-Hub-Signature-256 inválida o ausente.");
        return reply.status(401).send({
          error: "INVALID_SIGNATURE",
          message: "Firma criptográfica X-Hub-Signature-256 inválida.",
        });
      }

      const payload = request.body as {
        entry?: Array<{
          changes?: Array<{
            value?: {
              messages?: Array<{
                id?: string;
                from?: string;
                type?: string;
                text?: { body?: string };
              }>;
            };
          }>;
        }>;
      };

      const enqueued: string[] = [];
      const duplicates: string[] = [];

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const msg of change.value?.messages ?? []) {
            if (!msg.id || !msg.from) continue;

            const isFirstTime = await claimWamid(msg.id);
            if (!isFirstTime) {
              duplicates.push(msg.id);
              continue;
            }

            const textBody = msg.text?.body ?? `[Mensaje tipo ${msg.type ?? "desconocido"}]`;
            const correlationId = crypto.randomUUID();

            await whatsappInboundQueue.add("meta-message", {
              wamid: msg.id,
              fromPhone: normalizePhone(msg.from),
              metaRawFrom: msg.from,
              text: textBody,
              source: "meta",
              correlationId,
              receivedAt: new Date().toISOString(),
            });

            enqueued.push(msg.id);
          }
        }
      }

      // Respuesta inmediata (<200ms) requerida por Meta Cloud API
      return reply.status(200).send({
        status: "accepted",
        enqueuedCount: enqueued.length,
        duplicateCount: duplicates.length,
      });
    }
  );

  /**
   * 3. Dual Adapter — Simulador WhatsApp en Web (usa la misma idempotencia wamid y dominio)
   */
  app.post(
    "/api/channels/whatsapp/simulate",
    {
      schema: {
        tags: ["Canal 2: WhatsApp Cloud API"],
        summary: "Simulador Dual WhatsApp (ejecuta la misma lógica del Orquestador + idempotencia wamid)",
        body: {
          type: "object",
          required: ["fromPhone", "text"],
          properties: {
            fromPhone: { type: "string", examples: ["+526670000001"] },
            text: { type: "string", examples: ["Hola, quiero seguir con mi ultrasonido"] },
            wamid: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = simulateSchema.parse(request.body);
      const wamid = body.wamid ?? `sim_wamid_${crypto.randomUUID()}`;
      const isFirstTime = await claimWamid(wamid);

      if (!isFirstTime) {
        return reply.status(200).send({
          duplicate: true,
          wamid,
          message: "Mensaje duplicado ignorado por control de idempotencia (Redis SETNX).",
        });
      }

      const correlationId = crypto.randomUUID();
      const result = await processWhatsAppInbound({
        wamid,
        fromPhone: normalizePhone(body.fromPhone),
        text: body.text,
        source: "simulator",
        correlationId,
        receivedAt: new Date().toISOString(),
      });

      const history = await getSimulatedChatHistory(body.fromPhone);

      return reply.status(200).send({
        duplicate: false,
        wamid,
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
        tags: ["Canal 2: WhatsApp Cloud API"],
        summary: "Obtiene el historial de mensajes del simulador WhatsApp para un teléfono",
      },
    },
    async (request) => {
      const { phone } = request.params as { phone: string };
      const history = await getSimulatedChatHistory(phone);
      return { phone: normalizePhone(phone), history };
    }
  );
}
