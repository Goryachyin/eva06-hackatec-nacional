import { FastifyInstance, FastifyReply } from "fastify";
import { CaseState, EventType, StaffRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { JOURNEY_PUBSUB_CHANNEL, redis, redisSubscriber } from "../lib/redis";
import { maskPatientName } from "../lib/crypto";
import { requireStaffRole } from "../middleware/rbac";
import { whatsappDlqQueue, whatsappInboundQueue } from "../queues/whatsappQueue";

// Clientes SSE conectados a esta instancia Fastify (difusion alimentada por Redis Pub/Sub)
const sseClients = new Set<FastifyReply>();
let pubSubInitialized = false;

async function ensurePubSubBridge() {
  if (pubSubInitialized) return;
  pubSubInitialized = true;

  await redisSubscriber.subscribe(JOURNEY_PUBSUB_CHANNEL);
  redisSubscriber.on("message", (channel, message) => {
    if (channel !== JOURNEY_PUBSUB_CHANNEL) return;
    const frame = `event: journey_event\ndata: ${message}\n\n`;
    for (const client of sseClients) {
      try {
        client.raw.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  });
}

export async function adminRoutes(app: FastifyInstance) {
  await ensurePubSubBridge();

  const adminGuard = requireStaffRole([StaffRole.ADMIN]);
  const staffGuard = requireStaffRole([StaffRole.ASESOR, StaffRole.ADMIN]);

  /**
   * Tablero Admin (KPIs, casos con PII enmascarada y metricas BullMQ/DLQ)
   */
  app.get(
    "/api/admin/overview",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "KPIs del Patient Journey en vivo, casos con PII enmascarada y estado de colas BullMQ/DLQ",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const [
        cases,
        totalEvents,
        recoveredCount,
        otpFailedCount,
        confirmedCount,
        inboundCounts,
        dlqCounts,
      ] = await Promise.all([
        prisma.serviceCase.findMany({
          orderBy: { updatedAt: "desc" },
          take: 50,
          include: {
            patient: {
              select: {
                firstName: true,
                paternalLastName: true,
                identityLinks: {
                  select: { identifierType: true, identifierMasked: true, verified: true },
                },
              },
            },
            _count: { select: { journeyEvents: true } },
          },
        }),
        prisma.journeyEvent.count(),
        prisma.journeyEvent.count({ where: { eventType: EventType.CONTEXT_REHYDRATED } }),
        prisma.journeyEvent.count({ where: { eventType: EventType.OTP_VALIDATION_FAILED } }),
        prisma.serviceCase.count({ where: { currentState: CaseState.CITA_CONFIRMADA } }),
        whatsappInboundQueue.getJobCounts("waiting", "active", "completed", "failed"),
        whatsappDlqQueue.getJobCounts("waiting", "failed"),
      ]);

      // Enmascaramiento estricto PII para monitoreo Admin
      const sanitizedCases = cases.map((c) => ({
        id: c.id,
        journeyId: c.journeyId,
        patientMasked: maskPatientName(c.patient.firstName, c.patient.paternalLastName),
        identities: c.patient.identityLinks,
        currentState: c.currentState,
        currentChannel: c.currentChannel,
        version: c.version,
        eventsCount: c._count.journeyEvents,
        contextSummary: c.contextJson,
        updatedAt: c.updatedAt,
      }));

      return {
        kpis: {
          totalCases: cases.length,
          confirmedAppointments: confirmedCount,
          recoveredAbandonedFlows: recoveredCount,
          otpFailedAttemptsAudited: otpFailedCount,
          totalEventsRecorded: totalEvents,
          activeSseSubscribers: sseClients.size,
        },
        queues: {
          whatsappInbound: inboundCounts,
          whatsappDlq: dlqCounts,
        },
        cases: sanitizedCases,
      };
    }
  );

  /**
   * Linea de tiempo cronologica completa con correlation_id
   */
  app.get(
    "/api/admin/cases/:caseId/timeline",
    {
      preHandler: staffGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Obtiene la línea de tiempo inmutable y correlacionada (journey_events) de un caso",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { caseId } = request.params as { caseId: string };
      const events = await prisma.journeyEvent.findMany({
        where: { caseId },
        orderBy: { createdAt: "asc" },
      });
      return { caseId, count: events.length, events };
    }
  );

  /**
   * Stream en tiempo real Server-Sent Events (SSE) respaldado por Redis Pub/Sub (100% Stateless)
   */
  app.get(
    "/api/stream/events",
    {
      preHandler: staffGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Stream SSE en tiempo real respaldado por Redis Pub/Sub (aceptar JWT en header o ?token=)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({
          status: "subscribed",
          channel: JOURNEY_PUBSUB_CHANNEL,
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      sseClients.add(reply);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          sseClients.delete(reply);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(reply);
      });

      return reply;
    }
  );

  /**
   * Boton Reset Demo para la presentacion ante el jurado
   */
  app.post(
    "/api/admin/reset-demo",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Limpia casos, eventos y estado temporal Redis manteniendo usuarios staff y paciente Ana",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      await prisma.journeyEvent.deleteMany({});
      await prisma.serviceCase.deleteMany({});

      // Limpiar llaves efimeras de demo en Redis (del individual para compatibilidad con Cluster Mode)
      const patterns = ["otp:challenge:*", "sim:wa:chat:*", "wamid:*"];
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        for (const key of keys) {
          await redis.del(key);
        }
      }
      await redis.del("demo:otp:outbox");

      return {
        status: "reset_ok",
        message: "Demo reiniciado limpiamente. Usuarios staff y paciente Ana preservados.",
      };
    }
  );
}
