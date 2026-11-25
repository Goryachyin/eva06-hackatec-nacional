import crypto from "crypto";
import bcrypt from "bcryptjs";
import { FastifyInstance, FastifyReply } from "fastify";
import {
  ActorRole,
  CaseState,
  Channel,
  EventType,
  Gender,
  IdentifierType,
  StaffRole,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { JOURNEY_PUBSUB_CHANNEL, redis, redisSubscriber } from "../lib/redis";
import {
  maskPatientName,
  normalizeCurp,
  normalizeEmail,
  normalizePersonName,
  normalizePhone,
  normalizePlaceName,
  stripAccents,
} from "../lib/crypto";
import { findClinicById, findStudyByCode } from "../data/catalog";
import { findPatientByIdentifier, upsertIdentityLink } from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { requireStaffRole } from "../middleware/rbac";
import { whatsappDlqQueue, whatsappInboundQueue } from "../queues/whatsappQueue";

const adminUpdateCaseSchema = z.object({
  expectedVersion: z.number().int().positive(),
  studyCode: z.string().min(2).optional(),
  clinicId: z.string().min(2).optional(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  paymentMethod: z.enum(["online", "oxxo", "clinic"]).optional(),
  nextState: z.nativeEnum(CaseState).optional(),
  cancelled: z.boolean().optional(),
  adminNotes: z.string().optional(),
});

const adminUpdateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  paternalLastName: z.string().min(1).optional(),
  maternalLastName: z.string().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  birthState: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  curp: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  newPassword: z.string().min(6).optional(),
});

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
          patientId: c.patientId,
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

      // 3. Búsqueda complementaria por nombre / apellido (normalizado sin acentos) / correo / teléfono / CURP
      const queryNoAccents = stripAccents(query);
      const textMatches = await prisma.patient.findMany({
        where: {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { firstName: { contains: queryNoAccents, mode: "insensitive" } },
            { paternalLastName: { contains: query, mode: "insensitive" } },
            { paternalLastName: { contains: queryNoAccents, mode: "insensitive" } },
            { maternalLastName: { contains: queryNoAccents, mode: "insensitive" } },
            { email: { contains: queryNoAccents.toLowerCase(), mode: "insensitive" } },
            { phone: { contains: query } },
            { curp: { contains: queryNoAccents.toUpperCase() } },
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
                orderBy: { createdAt: "desc" },
                take: 50,
              },
            },
          },
          requestedCases: {
            orderBy: { updatedAt: "desc" },
            include: {
              patient: { select: { firstName: true, paternalLastName: true } },
              requester: { select: { firstName: true, paternalLastName: true } },
              journeyEvents: {
                orderBy: { createdAt: "desc" },
                take: 50,
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
          firstName: p.firstName,
          paternalLastName: p.paternalLastName,
          maternalLastName: p.maternalLastName,
          birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
          gender: p.gender,
          birthState: p.birthState,
          country: p.country,
          curp: p.curp,
          phone: p.phone,
          email: p.email,
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
              events: [...c.journeyEvents].reverse(),
            };
          }),
        };
      });

      return { count: results.length, results };
    }
  );

  /**
   * Modificación de cita desde Administrador (estudio, clínica, horario, pago, estado o anulación)
   */
  app.patch(
    "/api/admin/cases/:caseId",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Modifica una cita (abierta o confirmada) y sincroniza todos los canales vía SSE",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = adminUpdateCaseSchema.parse(request.body);
      const adminUser = request.staffUser!;

      const existing = await prisma.serviceCase.findUnique({ where: { id: caseId } });
      if (!existing) {
        return reply.status(404).send({ error: "CASE_NOT_FOUND", message: "Cita no encontrada." });
      }

      const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;
      const contextPatch: Partial<CaseContextJson> = {};
      const changes: Record<string, unknown> = {};

      if (body.studyCode) {
        const st = findStudyByCode(body.studyCode);
        if (!st) {
          return reply.status(400).send({ error: "INVALID_STUDY", message: "Estudio no encontrado en catálogo." });
        }
        contextPatch.study = { code: st.code, name: st.name, price: st.price, prep: st.prep };
        changes.studyCode = st.code;
      }

      if (body.clinicId) {
        const cl = findClinicById(body.clinicId);
        if (!cl) {
          return reply.status(400).send({ error: "INVALID_CLINIC", message: "Clínica no encontrada en catálogo." });
        }
        contextPatch.clinic = { id: cl.id, name: cl.name, city: cl.city, address: cl.address };
        changes.clinicId = cl.id;
      }

      if (body.preferredDate || body.preferredTime) {
        contextPatch.preferred_slot = {
          date: body.preferredDate || prevCtx.preferred_slot?.date || new Date().toISOString().slice(0, 10),
          time: body.preferredTime || prevCtx.preferred_slot?.time || "09:30",
        };
        changes.preferredSlot = contextPatch.preferred_slot;
      }

      if (body.paymentMethod) {
        contextPatch.payment_method = body.paymentMethod;
        changes.paymentMethod = body.paymentMethod;
      }

      if (body.cancelled !== undefined) {
        contextPatch.cancelled = body.cancelled;
        contextPatch.cancelled_reason = body.cancelled
          ? body.adminNotes?.trim() || "ANULADA_POR_ADMINISTRADOR"
          : undefined;
        changes.cancelled = body.cancelled;
      }

      const targetState = body.cancelled
        ? CaseState.PAUSADO_PENDIENTE
        : body.nextState ?? existing.currentState;

      const effectiveStudy = contextPatch.study ?? prevCtx.study;
      const effectiveClinic = contextPatch.clinic ?? prevCtx.clinic;

      if (targetState === CaseState.CITA_CONFIRMADA) {
        const folio = prevCtx.appointment_folio || `SD-2026-${crypto.randomInt(1000, 9999)}`;
        contextPatch.appointment_folio = folio;
        contextPatch.qr_payload = `SALUDDIGNA|${folio}|${effectiveStudy?.code ?? "EST"}|${effectiveClinic?.id ?? "CLN"}`;
        contextPatch.cancelled = false;
      }

      const eventType =
        targetState === CaseState.CITA_CONFIRMADA && existing.currentState !== CaseState.CITA_CONFIRMADA
          ? EventType.APPOINTMENT_CONFIRMED
          : body.cancelled
          ? EventType.FLOW_INTERRUPTED
          : EventType.CONTEXT_REHYDRATED;

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: existing.id,
        expectedVersion: body.expectedVersion,
        nextState: targetState,
        channel: Channel.SYSTEM,
        actorRole: ActorRole.ADMIN,
        eventType,
        contextPatch,
        eventPayload: {
          via: "admin_case_edit",
          adminName: adminUser.fullName,
          adminNotes: body.adminNotes?.trim() || null,
          changes,
        },
      });

      return { case: updatedCase, correlationId };
    }
  );

  /**
   * Modificación de cuenta y perfil de paciente desde Administrador (con normalización canónica)
   */
  app.patch(
    "/api/admin/users/:patientId",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["Rol Administrador (Observabilidad)"],
        summary: "Actualiza datos de la cuenta de un paciente (normalizados sin acentos/mayúsculas) y refresca sus expedientes",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { patientId } = request.params as { patientId: string };
      const body = adminUpdateUserSchema.parse(request.body);
      const adminUser = request.staffUser!;

      const existing = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!existing) {
        return reply.status(404).send({ error: "PATIENT_NOT_FOUND", message: "Paciente no encontrado." });
      }

      const updateData: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (body.firstName !== undefined) {
        const norm = normalizePersonName(body.firstName);
        if (norm) {
          updateData.firstName = norm;
          updatedFields.push("firstName");
        }
      }
      if (body.paternalLastName !== undefined) {
        const norm = normalizePersonName(body.paternalLastName);
        if (norm) {
          updateData.paternalLastName = norm;
          updatedFields.push("paternalLastName");
        }
      }
      if (body.maternalLastName !== undefined) {
        updateData.maternalLastName = body.maternalLastName
          ? normalizePersonName(body.maternalLastName) ?? null
          : null;
        updatedFields.push("maternalLastName");
      }
      if (body.birthDate !== undefined) {
        if (!body.birthDate) {
          updateData.birthDate = null;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(body.birthDate)) {
          updateData.birthDate = new Date(body.birthDate);
        }
        updatedFields.push("birthDate");
      }
      if (body.gender !== undefined) {
        updateData.gender = body.gender ?? null;
        updatedFields.push("gender");
      }
      if (body.birthState !== undefined) {
        updateData.birthState = body.birthState ? normalizePlaceName(body.birthState) ?? null : null;
        updatedFields.push("birthState");
      }
      if (body.country !== undefined) {
        updateData.country = body.country ? normalizePlaceName(body.country) ?? "MEXICO" : "MEXICO";
        updatedFields.push("country");
      }

      let nextEmail: string | null | undefined = undefined;
      if (body.email !== undefined) {
        if (!body.email || !body.email.trim()) {
          nextEmail = null;
        } else {
          const normEmail = normalizeEmail(body.email);
          if (!normEmail) {
            return reply.status(400).send({ error: "INVALID_EMAIL", message: "Correo electrónico inválido." });
          }
          const collision = await prisma.patient.findFirst({
            where: { email: { equals: normEmail, mode: "insensitive" }, id: { not: existing.id } },
          });
          if (collision) {
            return reply.status(409).send({
              error: "EMAIL_ALREADY_IN_USE",
              message: "Ese correo electrónico ya pertenece a otra cuenta de paciente.",
            });
          }
          nextEmail = normEmail;
        }
        updateData.email = nextEmail;
        updatedFields.push("email");
      }

      let nextCurp: string | null | undefined = undefined;
      if (body.curp !== undefined) {
        if (!body.curp || !body.curp.trim()) {
          nextCurp = null;
        } else {
          const normCurp = normalizeCurp(body.curp);
          if (!normCurp || normCurp.length !== 18) {
            return reply.status(400).send({
              error: "INVALID_CURP",
              message: "La CURP debe tener exactamente 18 caracteres.",
            });
          }
          const collision = await prisma.patient.findFirst({
            where: { curp: normCurp, id: { not: existing.id } },
          });
          if (collision) {
            return reply.status(409).send({
              error: "CURP_ALREADY_IN_USE",
              message: "Esa CURP ya pertenece a otro expediente.",
            });
          }
          nextCurp = normCurp;
        }
        updateData.curp = nextCurp;
        updatedFields.push("curp");
      }

      let nextPhone: string | null | undefined = undefined;
      if (body.phone !== undefined) {
        if (!body.phone || !body.phone.trim()) {
          nextPhone = null;
        } else {
          if (body.phone.replace(/\D/g, "").length < 10) {
            return reply.status(400).send({
              error: "INVALID_PHONE",
              message: "El teléfono debe contener al menos 10 dígitos.",
            });
          }
          nextPhone = normalizePhone(body.phone);
        }
        updateData.phone = nextPhone;
        updatedFields.push("phone");
      }

      if (body.newPassword) {
        updateData.passwordHash = await bcrypt.hash(body.newPassword, 10);
        updatedFields.push("password");
      }

      const updatedPatient = await prisma.patient.update({
        where: { id: existing.id },
        data: updateData,
      });

      if (nextPhone) {
        await upsertIdentityLink(updatedPatient.id, IdentifierType.PHONE, nextPhone, true);
      }
      if (nextEmail) {
        await upsertIdentityLink(updatedPatient.id, IdentifierType.EMAIL, nextEmail, true);
      }
      if (nextCurp) {
        await upsertIdentityLink(updatedPatient.id, IdentifierType.CURP, nextCurp, true);
      }

      // Refrescar resumen handoff y SSE en los expedientes recientes de este paciente
      const recentCases = await prisma.serviceCase.findMany({
        where: { OR: [{ patientId: updatedPatient.id }, { requesterPatientId: updatedPatient.id }] },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });

      for (const sc of recentCases) {
        await transitionServiceCase({
          caseId: sc.id,
          expectedVersion: sc.version,
          nextState: sc.currentState,
          channel: Channel.SYSTEM,
          actorRole: ActorRole.ADMIN,
          eventType: EventType.IDENTITY_LINKED,
          eventPayload: {
            via: "admin_user_account_edit",
            adminName: adminUser.fullName,
            updatedFields,
          },
        }).catch(() => {});
      }

      return {
        patient: {
          patientId: updatedPatient.id,
          patientMasked: maskPatientName(updatedPatient.firstName, updatedPatient.paternalLastName),
          hasAccount: Boolean(updatedPatient.passwordHash),
          firstName: updatedPatient.firstName,
          paternalLastName: updatedPatient.paternalLastName,
          maternalLastName: updatedPatient.maternalLastName,
          birthDate: updatedPatient.birthDate ? updatedPatient.birthDate.toISOString().slice(0, 10) : null,
          gender: updatedPatient.gender,
          birthState: updatedPatient.birthState,
          country: updatedPatient.country,
          curp: updatedPatient.curp,
          phone: updatedPatient.phone,
          email: updatedPatient.email,
        },
        updatedFields,
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
