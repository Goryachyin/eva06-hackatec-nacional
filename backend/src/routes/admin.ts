import { FastifyInstance, FastifyReply } from "fastify";
import { CaseState, EventType, IdentifierType, StaffRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { JOURNEY_PUBSUB_CHANNEL, redis, redisSubscriber } from "../lib/redis";
import { maskPatientName, normalizePhone } from "../lib/crypto";
import { findPatientByIdentifier } from "../core/identityService";
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
            requester: {
              select: { firstName: true, paternalLastName: true },
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
      const sanitizedCases = cases.map((c) => {
        const isThirdParty = Boolean(c.requesterPatientId) && c.requesterPatientId !== c.patientId;
        return {
          id: c.id,
          journeyId: c.journeyId,
          patientMasked: maskPatientName(c.patient.firstName, c.patient.paternalLastName),
          requesterMasked: c.requester
            ? maskPatientName(c.requester.firstName, c.requester.paternalLastName)
            : null,
          isThirdParty,
          relationshipLabel: c.relationshipLabel || (isThirdParty ? "Familiar" : "Titular"),
          identities: c.patient.identityLinks,
          currentState: c.currentState,
          currentChannel: c.currentChannel,
          version: c.version,
          eventsCount: c._count.journeyEvents,
          contextSummary: c.contextJson,
          updatedAt: c.updatedAt,
        };
      });

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
   * Consulta directa del estado de un usuario por telefono, CURP, correo, journey_id o nombre
   */
  app.get(
    "/api/admin/users/lookup",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Consulta el estado actual, historial de casos y timeline de un paciente (PII enmascarada)",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { q } = request.query as { q?: string };
      const query = (q ?? "").trim();
      if (!query) {
        return reply.status(400).send({
          error: "EMPTY_QUERY",
          message: "Ingresa un teléfono, CURP, correo electrónico, nombre o journey_id.",
        });
      }

      const matchedPatientIds = new Set<string>();

      // 1. Búsqueda exacta por UUID de journey_id o case_id
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query)) {
        const sc = await prisma.serviceCase.findFirst({
          where: { OR: [{ journeyId: query }, { id: query }, { patientId: query }] },
          select: { patientId: true },
        });
        if (sc) matchedPatientIds.add(sc.patientId);
      }

      // 2. Búsqueda por correo, CURP o teléfono usando Identity Resolution (hash HMAC)
      if (query.includes("@")) {
        const p = await findPatientByIdentifier(IdentifierType.EMAIL, query);
        if (p) matchedPatientIds.add(p.id);
      }
      if (/^[A-Za-z0-9]{18}$/.test(query)) {
        const p = await findPatientByIdentifier(IdentifierType.CURP, query.toUpperCase());
        if (p) matchedPatientIds.add(p.id);
      }
      if (query.replace(/\D/g, "").length >= 10) {
        const p = await findPatientByIdentifier(IdentifierType.PHONE, normalizePhone(query));
        if (p) matchedPatientIds.add(p.id);
      }

      // 3. Búsqueda complementaria por nombre / apellido / coincidencia parcial en patients
      const textMatches = await prisma.patient.findMany({
        where: {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { paternalLastName: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { phone: { contains: query } },
            { curp: { contains: query.toUpperCase() } },
          ],
        },
        select: { id: true },
        take: 10,
      });
      for (const m of textMatches) matchedPatientIds.add(m.id);

      if (matchedPatientIds.size === 0) {
        return { count: 0, results: [] };
      }

      const patients = await prisma.patient.findMany({
        where: { id: { in: Array.from(matchedPatientIds) } },
        include: {
          identityLinks: {
            select: { identifierType: true, identifierMasked: true, verified: true, verifiedAt: true },
          },
          serviceCases: {
            orderBy: { updatedAt: "desc" },
            include: {
              patient: { select: { firstName: true, paternalLastName: true } },
              requester: { select: { firstName: true, paternalLastName: true } },
              journeyEvents: {
                orderBy: { createdAt: "asc" },
                take: 40,
              },
            },
          },
          requestedCases: {
            orderBy: { updatedAt: "desc" },
            include: {
              patient: { select: { firstName: true, paternalLastName: true } },
              requester: { select: { firstName: true, paternalLastName: true } },
              journeyEvents: {
                orderBy: { createdAt: "asc" },
                take: 40,
              },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
      });

      const results = patients.map((p) => {
        const mergedMap = new Map<string, (typeof p.serviceCases)[number]>();
        for (const c of [...p.serviceCases, ...p.requestedCases]) {
          mergedMap.set(c.id, c);
        }
        const mergedCases = Array.from(mergedMap.values()).sort(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
        );

        return {
          patientId: p.id,
          patientMasked: maskPatientName(p.firstName, p.paternalLastName),
          hasAccount: Boolean(p.passwordHash),
          birthState: p.birthState,
          createdAt: p.createdAt,
          identities: p.identityLinks,
          cases: mergedCases.map((c) => {
            const isThirdParty = Boolean(c.requesterPatientId) && c.requesterPatientId !== c.patientId;
            return {
              id: c.id,
              journeyId: c.journeyId,
              currentState: c.currentState,
              currentChannel: c.currentChannel,
              version: c.version,
              isThirdParty,
              relationshipLabel: c.relationshipLabel || (isThirdParty ? "Familiar" : "Titular"),
              beneficiaryMasked: maskPatientName(c.patient.firstName, c.patient.paternalLastName),
              requesterMasked: c.requester
                ? maskPatientName(c.requester.firstName, c.requester.paternalLastName)
                : null,
              contextSummary: c.contextJson,
              updatedAt: c.updatedAt,
              events: c.journeyEvents,
            };
          }),
        };
      });

      return { count: results.length, results };
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
      const patterns = ["otp:challenge:*", "sim:wa:chat:*", "wamid:*", "wa:active_case:*"];
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        for (const key of keys) {
          await redis.del(key);
        }
      }
      await redis.del("demo:otp:outbox");
      await redis.del("gw:wa:outbound:pending");

      return {
        status: "reset_ok",
        message: "Demo reiniciado limpiamente. Usuarios staff y paciente Ana preservados.",
      };
    }
  );
}
