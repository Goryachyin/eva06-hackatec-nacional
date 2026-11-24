import crypto from "crypto";
import { FastifyInstance } from "fastify";
import {
  ActorRole,
  CaseState,
  Channel,
  EventType,
  Gender,
  IdentifierType,
  RelationshipType,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { findClinicById, findStudyByCode } from "../data/catalog";
import {
  findPatientByIdentifier,
  resolveOrCreateBeneficiary,
  resolveOrCreatePatient,
} from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";
import { publishSignedGatewayOutbound } from "../queues/whatsappQueue";

const registerSchema = z.object({
  nombres: z.string().min(1).optional(),
  apellido_paterno: z.string().min(1).optional(),
  apellido_materno: z.string().optional(),
  fecha_nacimiento: z.string().optional(),
  genero: z.nativeEnum(Gender).optional(),
  estado_nacimiento: z.string().optional(),
  pais: z.string().default("MÉXICO"),
  curp: z.string().length(18).optional(),
  telefono: z.string().min(10).optional(),
  email: z.string().email().optional(),
  webSessionId: z.string().optional(),
});

const beneficiarySchema = z.object({
  nombres: z.string().min(2),
  apellido_paterno: z.string().min(2),
  apellido_materno: z.string().optional(),
  fecha_nacimiento: z.string().optional(),
  genero: z.nativeEnum(Gender).optional(),
  estado_nacimiento: z.string().optional(),
  pais: z.string().default("MÉXICO"),
  curp: z.string().length(18),
});

const quoteSchema = z.object({
  caseId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  webSessionId: z.string().optional(),
  telefono: z.string().min(10).optional(),
  curp: z.string().length(18).optional(),
  nombres: z.string().optional(),
  apellido_paterno: z.string().optional(),
  studyCode: z.string().min(2),
  clinicId: z.string().optional(),
  preferredSlot: z
    .object({
      date: z.string(),
      time: z.string(),
    })
    .optional(),
  // Soporte Multibeneficiario (Titular agenda para familiar/conocido)
  forThirdParty: z.boolean().optional(),
  relationship: z.nativeEnum(RelationshipType).optional(),
  thirdPartyConsent: z.boolean().optional(),
  beneficiary: beneficiarySchema.optional(),
});

const abandonSchema = z.object({
  caseId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().default("PATIENT_SAVED_DRAFT_TO_CONTINUE_LATER"),
});

const confirmWebSchema = z.object({
  expectedVersion: z.number().int().positive(),
  paymentMethod: z.enum(["online", "oxxo", "clinic"]).default("online"),
});

export async function webChannelRoutes(app: FastifyInstance) {
  app.post(
    "/api/channels/web/register",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Registra o enriquece al paciente titular (9 campos) y vincula sus identidades multicanal",
      },
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const webSessionId = body.webSessionId ?? `web_${crypto.randomUUID().slice(0, 12)}`;

      const patient = await resolveOrCreatePatient({
        firstName: body.nombres,
        paternalLastName: body.apellido_paterno,
        maternalLastName: body.apellido_materno,
        birthDate: body.fecha_nacimiento,
        gender: body.genero,
        birthState: body.estado_nacimiento,
        country: body.pais,
        curp: body.curp,
        phone: body.telefono,
        email: body.email,
        webSessionId,
      });

      return reply.status(201).send({
        patient,
        webSessionId,
      });
    }
  );

  /**
   * Cotizar estudio y seleccionar clinica en Sitio Web.
   * Soporta citas para el Titular o para un Beneficiario (familiar/conocido) con privacidad clinica.
   */
  app.post(
    "/api/channels/web/quote",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Cotiza estudio y clínica (para el titular o para un familiar/conocido con expediente separado)",
      },
    },
    async (request, reply) => {
      const body = quoteSchema.parse(request.body);
      const correlationId = crypto.randomUUID();

      const study = findStudyByCode(body.studyCode);
      if (!study) {
        return reply.status(400).send({
          error: "INVALID_STUDY",
          message: `Estudio no encontrado en catálogo: ${body.studyCode}`,
        });
      }

      const clinic = body.clinicId ? findClinicById(body.clinicId) : undefined;
      if (body.clinicId && !clinic) {
        return reply.status(400).send({
          error: "INVALID_CLINIC",
          message: `Clínica no encontrada en catálogo: ${body.clinicId}`,
        });
      }

      const webSessionId = body.webSessionId ?? `web_${crypto.randomUUID().slice(0, 12)}`;
      const holder = await resolveOrCreatePatient({
        firstName: body.nombres,
        paternalLastName: body.apellido_paterno,
        phone: body.telefono,
        curp: body.curp,
        webSessionId,
      });

      let targetPatient = holder;
      let relationshipLabel = "Titular";
      let isThirdParty = false;

      if (body.forThirdParty && body.beneficiary) {
        if (!body.thirdPartyConsent) {
          return reply.status(400).send({
            error: "CONSENT_REQUIRED",
            message:
              "Se requiere aceptar el consentimiento de privacidad para agendar a nombre de un familiar o conocido.",
          });
        }
        const resolved = await resolveOrCreateBeneficiary({
          holder,
          relationship: body.relationship ?? RelationshipType.FAMILIAR,
          consentAccepted: true,
          beneficiary: {
            firstName: body.beneficiary.nombres,
            paternalLastName: body.beneficiary.apellido_paterno,
            maternalLastName: body.beneficiary.apellido_materno,
            birthDate: body.beneficiary.fecha_nacimiento,
            gender: body.beneficiary.genero,
            birthState: body.beneficiary.estado_nacimiento,
            country: body.beneficiary.pais,
            curp: body.beneficiary.curp,
            phone: body.telefono,
          },
        });
        targetPatient = resolved.beneficiary;
        relationshipLabel = resolved.relationshipLabel;
        isThirdParty = targetPatient.id !== holder.id;
      }

      let serviceCase = body.caseId
        ? await prisma.serviceCase.findUnique({ where: { id: body.caseId } })
        : await prisma.serviceCase.findFirst({
            where: {
              patientId: targetPatient.id,
              requesterPatientId: holder.id,
              currentState: { not: CaseState.CITA_CONFIRMADA },
            },
            orderBy: { updatedAt: "desc" },
          });

      if (!serviceCase) {
        serviceCase = await prisma.serviceCase.create({
          data: {
            patientId: targetPatient.id,
            requesterPatientId: holder.id,
            relationshipLabel,
            thirdPartyConsent: isThirdParty,
            currentState: CaseState.INICIADO,
            currentChannel: Channel.WEB,
            contextJson: { otp_verified_channels: ["WEB"] },
          },
        });

        await recordAndPublishEvent({
          caseId: serviceCase.id,
          patientId: targetPatient.id,
          journeyId: serviceCase.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.SESSION_STARTED,
          prevState: null,
          nextState: CaseState.INICIADO,
          payload: { webSessionId, isThirdParty, relationshipLabel },
        });
      } else if (serviceCase.currentChannel !== Channel.WEB) {
        // Salto de canal hacia Web (ej. WhatsApp -> Web)
        await recordAndPublishEvent({
          caseId: serviceCase.id,
          patientId: serviceCase.patientId,
          journeyId: serviceCase.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.SYSTEM,
          eventType: EventType.CHANNEL_SWITCH_DETECTED,
          payload: { fromChannel: serviceCase.currentChannel, toChannel: Channel.WEB },
        });
      }

      if (body.telefono || body.curp || isThirdParty) {
        await recordAndPublishEvent({
          caseId: serviceCase.id,
          patientId: targetPatient.id,
          journeyId: serviceCase.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.SYSTEM,
          eventType: EventType.IDENTITY_LINKED,
          payload: {
            linkedPhone: Boolean(body.telefono),
            linkedCurp: Boolean(body.curp || body.beneficiary?.curp),
            isThirdParty,
            relationshipLabel,
          },
        });
      }

      const expectedVer = body.expectedVersion ?? serviceCase.version;

      const step1 = await transitionServiceCase({
        caseId: serviceCase.id,
        expectedVersion: expectedVer,
        nextState: CaseState.COTIZANDO,
        channel: Channel.WEB,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.STUDY_QUOTED,
        correlationId,
        contextPatch: {
          study: {
            code: study.code,
            name: study.name,
            price: study.price,
            prep: study.prep,
          },
          ...(body.preferredSlot ? { preferred_slot: body.preferredSlot } : {}),
        },
        eventPayload: { studyCode: study.code, price: study.price, isThirdParty },
      });

      let finalCase = step1.updatedCase;

      if (clinic) {
        const step2 = await transitionServiceCase({
          caseId: finalCase.id,
          expectedVersion: finalCase.version,
          nextState: CaseState.CLINICA_ELEGIDA,
          channel: Channel.WEB,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.CLINIC_SELECTED,
          correlationId,
          contextPatch: {
            clinic: {
              id: clinic.id,
              name: clinic.name,
              city: clinic.city,
              address: clinic.address,
            },
          },
          eventPayload: { clinicId: clinic.id, clinicName: clinic.name },
        });
        finalCase = step2.updatedCase;
      }

      return reply.status(200).send({
        case: finalCase,
        patientId: targetPatient.id,
        requesterPatientId: holder.id,
        isThirdParty,
        relationshipLabel,
        webSessionId,
        correlationId,
      });
    }
  );

  /**
   * Guardar para continuar despues (PAUSADO_PENDIENTE)
   */
  app.post(
    "/api/channels/web/abandon",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Guarda el borrador del trámite (PAUSADO_PENDIENTE) conservando el contexto intacto",
      },
    },
    async (request, reply) => {
      const body = abandonSchema.parse(request.body);
      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: body.caseId,
        expectedVersion: body.expectedVersion,
        nextState: CaseState.PAUSADO_PENDIENTE,
        channel: Channel.WEB,
        actorRole: ActorRole.SYSTEM,
        eventType: EventType.FLOW_INTERRUPTED,
        eventPayload: { reason: body.reason },
      });

      return reply.status(200).send({
        case: updatedCase,
        correlationId,
      });
    }
  );

  /**
   * Retomar en Sitio Web un tramite iniciado/continuado en otro canal (N-saltos bidireccionales)
   */
  app.post(
    "/api/channels/web/cases/:caseId/resume",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Rehidrata en Sitio Web un trámite activo proveniente de WhatsApp, Call Center o borrador Web",
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const existing = await prisma.serviceCase.findUnique({
        where: { id: caseId },
        include: {
          patient: { select: { firstName: true, paternalLastName: true, curp: true, phone: true } },
        },
      });
      if (!existing) {
        return reply.status(404).send({ error: "CASE_NOT_FOUND", message: "Trámite no encontrado." });
      }
      if (existing.currentState === CaseState.CITA_CONFIRMADA) {
        return reply.status(200).send({ case: existing, alreadyConfirmed: true });
      }

      const correlationId = crypto.randomUUID();
      if (existing.currentChannel !== Channel.WEB) {
        await recordAndPublishEvent({
          caseId: existing.id,
          patientId: existing.patientId,
          journeyId: existing.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.SYSTEM,
          eventType: EventType.CHANNEL_SWITCH_DETECTED,
          payload: { fromChannel: existing.currentChannel, toChannel: Channel.WEB },
        });
      }

      const { updatedCase } = await transitionServiceCase({
        caseId: existing.id,
        expectedVersion: existing.version,
        nextState: CaseState.EN_PROGRESO,
        channel: Channel.WEB,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.CONTEXT_REHYDRATED,
        correlationId,
        eventPayload: {
          recoveredFromChannel: existing.currentChannel,
          recoveredFromState: existing.currentState,
        },
      });

      return reply.status(200).send({
        case: updatedCase,
        correlationId,
      });
    }
  );

  /**
   * Confirmar cita directamente desde el Sitio Web (genera Folio + QR y avisa por WhatsApp firmado)
   */
  app.post(
    "/api/channels/web/cases/:caseId/confirm",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Confirma la cita desde Sitio Web generando folio + QR y notificación firmada a WhatsApp",
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = confirmWebSchema.parse(request.body);

      const existing = await prisma.serviceCase.findUnique({
        where: { id: caseId },
        include: {
          patient: { select: { firstName: true, paternalLastName: true, phone: true } },
          requester: { select: { phone: true } },
        },
      });
      if (!existing) {
        return reply.status(404).send({ error: "CASE_NOT_FOUND", message: "Trámite no encontrado." });
      }

      const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;
      const folio = `SD-2026-${crypto.randomInt(1000, 9999)}`;
      const qrPayload = `SALUDDIGNA|${folio}|${prevCtx.study?.code ?? "EST"}|${prevCtx.clinic?.id ?? "CLN"}`;

      const { updatedCase, correlationId } = await transitionServiceCase({
        caseId: existing.id,
        expectedVersion: body.expectedVersion,
        nextState: CaseState.CITA_CONFIRMADA,
        channel: Channel.WEB,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.APPOINTMENT_CONFIRMED,
        contextPatch: {
          appointment_folio: folio,
          qr_payload: qrPayload,
        },
        eventPayload: { folio, paymentMethod: body.paymentMethod },
      });

      const notifyPhone = existing.requester?.phone ?? existing.patient.phone;
      if (notifyPhone) {
        await publishSignedGatewayOutbound({
          toPhone: notifyPhone,
          text:
            `✅ ¡Cita confirmada en Salud Digna!\n` +
            `• Folio: ${folio}\n` +
            `• Estudio: ${prevCtx.study?.name ?? "Estudio"}\n` +
            `• Clínica: ${prevCtx.clinic?.name ?? "Clínica"}\n` +
            `• Preparación: ${prevCtx.study?.prep ?? "Presentarse 15 min antes."}`,
          correlationId,
        });
      }

      return reply.status(200).send({
        case: updatedCase,
        folio,
        qrPayload,
        correlationId,
      });
    }
  );

  app.get(
    "/api/channels/web/case",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Consulta el trámite activo por teléfono, CURP o sesión Web",
        querystring: {
          type: "object",
          properties: {
            telefono: { type: "string" },
            curp: { type: "string" },
            webSessionId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { telefono?: string; curp?: string; webSessionId?: string };

      let patient = null;
      if (q.telefono) {
        patient = await findPatientByIdentifier(IdentifierType.PHONE, q.telefono);
      } else if (q.curp) {
        patient = await findPatientByIdentifier(IdentifierType.CURP, q.curp);
      } else if (q.webSessionId) {
        patient = await findPatientByIdentifier(IdentifierType.WEB_SESSION, q.webSessionId);
      }

      if (!patient) {
        return reply.status(404).send({
          error: "PATIENT_NOT_FOUND",
          message: "No se encontró un paciente con el identificador proporcionado.",
        });
      }

      const activeCase = await prisma.serviceCase.findFirst({
        where: { OR: [{ requesterPatientId: patient.id }, { patientId: patient.id }] },
        orderBy: { updatedAt: "desc" },
      });

      return {
        patient: {
          id: patient.id,
          nombres: patient.firstName,
          apellido_paterno: patient.paternalLastName,
          apellido_materno: patient.maternalLastName,
          telefono: patient.phone,
        },
        case: activeCase,
      };
    }
  );
}
