import crypto from "crypto";
import { FastifyInstance } from "fastify";
import {
  ActorRole,
  CaseState,
  Channel,
  EventType,
  IdentifierType,
  Patient,
  StaffRole,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { normalizeCurp, normalizePersonName, normalizePhone } from "../lib/crypto";
import { requireStaffRole } from "../middleware/rbac";
import { findClinicById, findStudyByCode } from "../data/catalog";
import { processCallAudioAndSummarize } from "../core/callSummaryService";
import { recordAndPublishEvent } from "../core/eventBus";
import { findPatientByIdentifier, resolveOrCreatePatient } from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { publishSignedGatewayOutbound } from "../queues/whatsappQueue";

const createCallCenterCaseSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    nombres: z.string().min(2).optional(),
    apellidoPaterno: z.string().min(2).optional(),
    apellidoMaterno: z.string().optional(),
    telefono: z.string().min(10).optional(),
    curp: z.string().length(18).optional(),
    studyCode: z.string().min(2),
    clinicId: z.string().min(2),
    preferredDate: z.string().min(8).optional(),
    preferredTime: z.string().min(4).optional(),
    paymentMethod: z.enum(["online", "oxxo", "clinic"]).default("online"),
    advisorNotes: z.string().optional(),
  })
  .refine((d) => Boolean(d.patientId || d.telefono || d.curp || (d.nombres && d.apellidoPaterno)), {
    message: "Selecciona un usuario existente o captura los datos básicos del paciente para crear la cita.",
  });

const assignSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

const confirmSchema = z.object({
  expectedVersion: z.number().int().positive(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  paymentMethod: z.enum(["online", "oxxo", "clinic"]).optional(),
  advisorNotes: z.string().optional(),
});

const updateCallCenterCaseSchema = z.object({
  expectedVersion: z.number().int().positive(),
  studyCode: z.string().min(2).optional(),
  clinicId: z.string().min(2).optional(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  paymentMethod: z.enum(["online", "oxxo", "clinic"]).optional(),
  advisorNotes: z.string().optional(),
  action: z.enum(["save", "pause", "reopen"]).default("save"),
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
              email: true,
              curp: true,
              birthDate: true,
              gender: true,
              birthState: true,
            },
          },
          assignedAdvisor: {
            select: { id: true, fullName: true, email: true },
          },
          journeyEvents: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      });

      const normalizedCases = cases.map((c) => ({
        ...c,
        journeyEvents: [...c.journeyEvents].reverse(),
      }));

      return { count: normalizedCases.length, cases: normalizedCases };
    }
  );

  /**
   * Crea una nueva cita desde Call Center para un usuario existente (sin alterar su cuenta)
   * o para un paciente nuevo que llama por teléfono.
   */
  app.post(
    "/api/call-center/cases",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Crea una nueva cita desde Call Center sin modificar cuentas existentes",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const body = createCallCenterCaseSchema.parse(request.body);
      const advisor = request.staffUser!;

      const study = findStudyByCode(body.studyCode);
      if (!study) {
        return reply.status(400).send({ error: "INVALID_STUDY", message: "Estudio no encontrado en catálogo." });
      }
      const clinic = findClinicById(body.clinicId);
      if (!clinic) {
        return reply.status(400).send({ error: "INVALID_CLINIC", message: "Clínica no encontrada en catálogo." });
      }

      // 1. Asociar usuario existente SIN modificar su cuenta; solo crear expediente si no existe
      let patient: Patient | null = null;
      if (body.patientId) {
        patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
        if (!patient) {
          return reply.status(404).send({ error: "PATIENT_NOT_FOUND", message: "Usuario no encontrado." });
        }
      }
      if (!patient && body.curp) {
        const cleanCurp = normalizeCurp(body.curp);
        if (cleanCurp) {
          patient = await findPatientByIdentifier(IdentifierType.CURP, cleanCurp);
        }
      }
      if (!patient && body.telefono) {
        patient = await findPatientByIdentifier(IdentifierType.PHONE, normalizePhone(body.telefono));
      }
      if (!patient) {
        patient = await resolveOrCreatePatient({
          firstName: normalizePersonName(body.nombres),
          paternalLastName: normalizePersonName(body.apellidoPaterno),
          maternalLastName: normalizePersonName(body.apellidoMaterno),
          phone: body.telefono ? normalizePhone(body.telefono) : undefined,
          curp: normalizeCurp(body.curp),
        });
      }

      const correlationId = crypto.randomUUID();
      const created = await prisma.serviceCase.create({
        data: {
          patientId: patient.id,
          requesterPatientId: patient.id,
          relationshipLabel: "Titular",
          thirdPartyConsent: false,
          currentState: CaseState.INICIADO,
          currentChannel: Channel.CALL_CENTER,
          assignedAdvisorId: advisor.sub,
          contextJson: { otp_verified_channels: ["CALL_CENTER"] },
        },
      });

      await recordAndPublishEvent({
        caseId: created.id,
        patientId: patient.id,
        journeyId: created.journeyId,
        correlationId,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.SESSION_STARTED,
        prevState: null,
        nextState: CaseState.INICIADO,
        payload: {
          via: "call_center_create_case",
          advisorId: advisor.sub,
          advisorName: advisor.fullName,
        },
      });

      const slotDate = body.preferredDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const slotTime = body.preferredTime || "09:30";

      const { updatedCase } = await transitionServiceCase({
        caseId: created.id,
        expectedVersion: created.version,
        nextState: CaseState.EN_ATENCION_ASESOR,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType: EventType.ADVISOR_ASSIGNED,
        correlationId,
        assignedAdvisorId: advisor.sub,
        contextPatch: {
          study: {
            code: study.code,
            name: study.name,
            price: study.price,
            prep: study.prep,
          },
          clinic: {
            id: clinic.id,
            name: clinic.name,
            city: clinic.city,
            address: clinic.address,
          },
          preferred_slot: { date: slotDate, time: slotTime },
          payment_method: body.paymentMethod,
        },
        eventPayload: {
          via: "call_center_create_case",
          advisorId: advisor.sub,
          advisorName: advisor.fullName,
          studyCode: study.code,
          clinicId: clinic.id,
          preferredDate: slotDate,
          preferredTime: slotTime,
          advisorNotes: body.advisorNotes?.trim() || null,
        },
      });

      return reply.status(201).send({ case: updatedCase, patientId: patient.id, correlationId });
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
          ...(body.paymentMethod ? { payment_method: body.paymentMethod } : {}),
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
   * Modifica exclusivamente datos de la cita (estudio, clínica, fecha/hora, pago, pausa/reapertura).
   * Call Center NO puede modificar datos de la cuenta ni identidad del paciente (reservado a Admin/Paciente).
   */
  app.patch(
    "/api/call-center/cases/:caseId",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Call Center (Rol Asesor)"],
        summary: "Modifica únicamente los datos de una cita (abierta o confirmada) sin alterar la cuenta del paciente",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = updateCallCenterCaseSchema.parse(request.body);
      const advisor = request.staffUser!;

      const existing = await prisma.serviceCase.findUnique({
        where: { id: caseId },
        include: {
          patient: { select: { phone: true } },
          requester: { select: { phone: true } },
        },
      });
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
        const nextDate = body.preferredDate || prevCtx.preferred_slot?.date || new Date().toISOString().slice(0, 10);
        const nextTime = body.preferredTime || prevCtx.preferred_slot?.time || "09:30";
        contextPatch.preferred_slot = { date: nextDate, time: nextTime };
        changes.preferredSlot = contextPatch.preferred_slot;
      }

      if (body.paymentMethod) {
        contextPatch.payment_method = body.paymentMethod;
        changes.paymentMethod = body.paymentMethod;
      }

      const isConfirmed = existing.currentState === CaseState.CITA_CONFIRMADA;
      const effectiveStudy = contextPatch.study ?? prevCtx.study;
      const effectiveClinic = contextPatch.clinic ?? prevCtx.clinic;

      if (isConfirmed && prevCtx.appointment_folio) {
        contextPatch.qr_payload = `SALUDDIGNA|${prevCtx.appointment_folio}|${effectiveStudy?.code ?? "EST"}|${effectiveClinic?.id ?? "CLN"}`;
      }

      let nextState: CaseState;
      let eventType: EventType = EventType.CONTEXT_REHYDRATED;

      if (isConfirmed) {
        nextState = CaseState.CITA_CONFIRMADA;
      } else if (body.action === "pause") {
        nextState = CaseState.PAUSADO_PENDIENTE;
        eventType = EventType.FLOW_INTERRUPTED;
      } else if (body.action === "reopen") {
        nextState = CaseState.EN_ATENCION_ASESOR;
      } else {
        nextState =
          existing.currentState === CaseState.INICIADO
            ? effectiveClinic
              ? CaseState.CLINICA_ELEGIDA
              : effectiveStudy
              ? CaseState.COTIZANDO
              : CaseState.EN_ATENCION_ASESOR
            : CaseState.EN_ATENCION_ASESOR;
      }

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: existing.id,
        expectedVersion: body.expectedVersion,
        nextState,
        channel: Channel.CALL_CENTER,
        actorRole: ActorRole.ADVISOR,
        eventType,
        assignedAdvisorId: advisor.sub,
        contextPatch,
        eventPayload: {
          via: "call_center_appointment_edit",
          editedConfirmedAppointment: isConfirmed,
          advisorName: advisor.fullName,
          advisorNotes: body.advisorNotes?.trim() || null,
          changes,
        },
      });

      if (isConfirmed && Object.keys(changes).length > 0) {
        const notifyPhone = existing.requester?.phone ?? existing.patient.phone;
        const updatedCtx = (updatedCase.contextJson ?? {}) as CaseContextJson;
        if (notifyPhone) {
          await publishSignedGatewayOutbound({
            toPhone: notifyPhone,
            text:
              `✏️ Tu cita confirmada (${updatedCtx.appointment_folio ?? "Folio activo"}) fue actualizada por Call Center (${advisor.fullName}):\n` +
              `• Estudio: ${updatedCtx.study?.name ?? "Estudio"}\n` +
              `• Clínica: ${updatedCtx.clinic?.name ?? "Clínica"}\n` +
              (updatedCtx.preferred_slot
                ? `• Horario: ${updatedCtx.preferred_slot.date} a las ${updatedCtx.preferred_slot.time}`
                : ""),
            correlationId,
          }).catch(() => {});
        }
      }

      return { case: updatedCase, correlationId };
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
