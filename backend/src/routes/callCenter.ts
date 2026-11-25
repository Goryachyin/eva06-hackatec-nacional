import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { ActorRole, CaseState, Channel, EventType, StaffRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireStaffRole } from "../middleware/rbac";
import { findClinicById, findStudyByCode } from "../data/catalog";
import { processCallAudioAndSummarize } from "../core/callSummaryService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { publishSignedGatewayOutbound } from "../queues/whatsappQueue";

const assignSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

const confirmSchema = z.object({
  expectedVersion: z.number().int().positive(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  advisorNotes: z.string().optional(),
});

const processCallSchema = z
  .object({
    callId: z.string().optional(),
    source: z.enum(["webrtc_call", "audio_upload", "transcript_text"]).default("webrtc_call"),
    audioBase64: z.string().optional(),
    mimeType: z.string().optional(),
    transcriptText: z.string().optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
    applyExtractedEntities: z.boolean().default(false),
  })
  .refine((d) => Boolean(d.audioBase64 || d.transcriptText?.trim()), {
    message: "Debes enviar audio grabado o texto de transcripción para procesar la llamada.",
  });

export async function callCenterRoutes(app: FastifyInstance) {
  const advisorGuard = requireStaffRole([StaffRole.ASESOR, StaffRole.ADMIN]);

  /**
   * Bandeja del Asesor de Call Center (Screen-Pop + Resumen Handoff deterministico)
   */
  app.get(
    "/api/call-center/queue",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Lista los casos activos con contexto acumulado, Resumen Handoff y últimos eventos",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const cases = await prisma.serviceCase.findMany({
        orderBy: { updatedAt: "desc" },
        take: 30,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              paternalLastName: true,
              maternalLastName: true,
              phone: true,
              curp: true,
              birthState: true,
            },
          },
          assignedAdvisor: {
            select: { id: true, fullName: true, email: true },
          },
          journeyEvents: {
            orderBy: { createdAt: "asc" },
            take: 25,
          },
        },
      });

      return { count: cases.length, cases };
    }
  );

  /**
   * Asigna asesor y dispara Screen-Pop SSE -> ADVISOR_ASSIGNED (EN_ATENCION_ASESOR)
   */
  app.post(
    "/api/call-center/cases/:caseId/assign",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Asigna el caso al asesor autenticado y dispara evento ADVISOR_ASSIGNED",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { caseId } = request.params as { caseId: string };
      const body = assignSchema.parse(request.body);
      const advisor = request.staffUser!;

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId,
        expectedVersion: body.expectedVersion,
        nextState: CaseState.EN_ATENCION_ASESOR,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.ADVISOR_ASSIGNED,
        assignedAdvisorId: advisor.sub,
        eventPayload: {
          advisorId: advisor.sub,
          advisorName: advisor.fullName,
        },
      });

      return { case: updatedCase, correlationId };
    }
  );

  /**
   * Confirma cita en 1 clic -> APPOINTMENT_CONFIRMED (CITA_CONFIRMADA)
   */
  app.post(
    "/api/call-center/cases/:caseId/confirm",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Confirma la cita del paciente en 1 clic, genera folio y QR para clínica",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { caseId } = request.params as { caseId: string };
      const body = confirmSchema.parse(request.body);
      const advisor = request.staffUser!;

      const existing = await prisma.serviceCase.findUniqueOrThrow({
        where: { id: caseId },
        include: {
          patient: { select: { phone: true } },
          requester: { select: { phone: true } },
        },
      });
      const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;

      const folio = `SD-2026-${crypto.randomInt(1000, 9999)}`;
      const qrPayload = `SALUDDIGNA|${folio}|${prevCtx.study?.code ?? "EST"}|${prevCtx.clinic?.id ?? "CLN"}`;

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId,
        expectedVersion: body.expectedVersion,
        nextState: CaseState.CITA_CONFIRMADA,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.APPOINTMENT_CONFIRMED,
        assignedAdvisorId: advisor.sub,
        contextPatch: {
          appointment_folio: folio,
          qr_payload: qrPayload,
          ...(body.preferredDate && body.preferredTime
            ? { preferred_slot: { date: body.preferredDate, time: body.preferredTime } }
            : {}),
        },
        eventPayload: {
          folio,
          advisorName: advisor.fullName,
          advisorNotes: body.advisorNotes ?? null,
        },
      });

      // Notificacion proactiva firmada al Gateway WhatsApp Baileys
      const notifyPhone = existing.requester?.phone ?? existing.patient.phone;
      if (notifyPhone) {
        await publishSignedGatewayOutbound({
          toPhone: notifyPhone,
          text:
            `✅ Tu cita fue confirmada por nuestro Call Center (${advisor.fullName}):\n` +
            `• Folio: ${folio}\n` +
            `• Estudio: ${prevCtx.study?.name ?? "Estudio"}\n` +
            `• Clínica: ${prevCtx.clinic?.name ?? "Clínica"}\n` +
            `• Preparación: ${prevCtx.study?.prep ?? "Presentarse 15 min antes."}`,
          correlationId,
        });
      }

      return { case: updatedCase, folio, qrPayload, correlationId };
    }
  );

  /**
   * Procesa el audio o transcripción de una llamada WebRTC con OpenAI (STT + Resumen estructurado)
   * e integra el resumen al contexto omnicanal (Call Center, Bot WhatsApp, Mi Cuenta Web y Admin).
   */
  app.post(
    "/api/call-center/cases/:caseId/calls/process",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Transcribe y resume una llamada con OpenAI e integra el resultado al contexto omnicanal",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = processCallSchema.parse(request.body);
      const advisor = request.staffUser!;

      const existing = await prisma.serviceCase.findUnique({ where: { id: caseId } });
      if (!existing) {
        return reply.status(404).send({ error: "CASE_NOT_FOUND", message: "Expediente no encontrado." });
      }

      const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;

      const callSummary = await processCallAudioAndSummarize({
        callId: body.callId,
        advisorName: advisor.fullName,
        source: body.source,
        audioBase64: body.audioBase64,
        mimeType: body.mimeType,
        transcriptText: body.transcriptText,
        durationSeconds: body.durationSeconds,
        currentCtx: prevCtx,
      });

      const prevSummaries = Array.isArray(prevCtx.call_summaries) ? prevCtx.call_summaries : [];
      const mergedQuestions = Array.from(
        new Set([...(prevCtx.open_questions ?? []), ...callSummary.openQuestions])
      );

      const contextPatch: Partial<CaseContextJson> = {
        call_summaries: [callSummary, ...prevSummaries].slice(0, 15),
        latest_call_summary: callSummary.summary,
        ...(mergedQuestions.length > 0 ? { open_questions: mergedQuestions } : {}),
      };

      if (body.applyExtractedEntities) {
        const ent = callSummary.extractedEntities;
        if (ent.studyCode) {
          const st = findStudyByCode(ent.studyCode);
          if (st) {
            contextPatch.study = {
              code: st.code,
              name: st.name,
              price: st.price,
              prep: st.prep,
            };
          }
        }
        if (ent.clinicId) {
          const cl = findClinicById(ent.clinicId);
          if (cl) {
            contextPatch.clinic = {
              id: cl.id,
              name: cl.name,
              city: cl.city,
              address: cl.address,
            };
          }
        }
        if (ent.preferredDate || ent.preferredTime) {
          contextPatch.preferred_slot = {
            date: ent.preferredDate || prevCtx.preferred_slot?.date || new Date().toISOString().slice(0, 10),
            time: ent.preferredTime || prevCtx.preferred_slot?.time || "09:30",
          };
        }
        if (ent.paymentMethod) {
          contextPatch.payment_method = ent.paymentMethod;
        }
      }

      // Re-leer versión más reciente tras la llamada a OpenAI para evitar falsos conflictos
      const freshCase = await prisma.serviceCase.findUniqueOrThrow({ where: { id: caseId } });
      const nextState =
        freshCase.currentState === CaseState.CITA_CONFIRMADA
          ? CaseState.CITA_CONFIRMADA
          : CaseState.EN_ATENCION_ASESOR;

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: freshCase.id,
        expectedVersion: freshCase.version,
        nextState,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.CONTEXT_REHYDRATED,
        assignedAdvisorId: advisor.sub,
        contextPatch,
        eventPayload: {
          via: "call_ai_summary",
          callSummaryId: callSummary.id,
          source: callSummary.source,
          durationSeconds: callSummary.durationSeconds ?? null,
          patientSafeSummary: callSummary.patientSafeSummary,
          summary: callSummary.summary,
          agreements: callSummary.agreements,
          aiProcessed: callSummary.aiProcessed,
          appliedEntities: body.applyExtractedEntities,
        },
      });

      return { case: updatedCase, callSummary, correlationId };
    }
  );

  /**
   * Aplica al expediente las entidades extraídas (estudio, clínica, horario, pago) de un resumen de llamada
   */
  app.post(
    "/api/call-center/cases/:caseId/calls/:summaryId/apply",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Aplica las entidades detectadas en el resumen IA de una llamada al expediente activo",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { caseId, summaryId } = request.params as { caseId: string; summaryId: string };
      const advisor = request.staffUser!;

      const existing = await prisma.serviceCase.findUnique({ where: { id: caseId } });
      if (!existing) {
        return reply.status(404).send({ error: "CASE_NOT_FOUND", message: "Expediente no encontrado." });
      }
      if (existing.currentState === CaseState.CITA_CONFIRMADA) {
        return reply.status(400).send({
          error: "ALREADY_CONFIRMED",
          message: "La cita ya está confirmada y no puede modificarse.",
        });
      }

      const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;
      const summary = (prevCtx.call_summaries ?? []).find((s) => s.id === summaryId);
      if (!summary) {
        return reply.status(404).send({ error: "SUMMARY_NOT_FOUND", message: "Resumen de llamada no encontrado." });
      }

      const contextPatch: Partial<CaseContextJson> = {};
      const ent = summary.extractedEntities;
      if (ent.studyCode) {
        const st = findStudyByCode(ent.studyCode);
        if (st) {
          contextPatch.study = { code: st.code, name: st.name, price: st.price, prep: st.prep };
        }
      }
      if (ent.clinicId) {
        const cl = findClinicById(ent.clinicId);
        if (cl) {
          contextPatch.clinic = { id: cl.id, name: cl.name, city: cl.city, address: cl.address };
        }
      }
      if (ent.preferredDate || ent.preferredTime) {
        contextPatch.preferred_slot = {
          date: ent.preferredDate || prevCtx.preferred_slot?.date || new Date().toISOString().slice(0, 10),
          time: ent.preferredTime || prevCtx.preferred_slot?.time || "09:30",
        };
      }
      if (ent.paymentMethod) {
        contextPatch.payment_method = ent.paymentMethod;
      }

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: existing.id,
        expectedVersion: existing.version,
        nextState: CaseState.EN_ATENCION_ASESOR,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.CONTEXT_REHYDRATED,
        assignedAdvisorId: advisor.sub,
        contextPatch,
        eventPayload: {
          via: "call_summary_entities_applied",
          callSummaryId: summaryId,
          applied: ent,
        },
      });

      return { case: updatedCase, correlationId };
    }
  );
}
