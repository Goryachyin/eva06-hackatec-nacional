import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { ActorRole, CaseState, Channel, EventType, Gender, IdentifierType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { findClinicById, findStudyByCode } from "../data/catalog";
import {
  findPatientByIdentifier,
  resolveOrCreatePatient,
} from "../core/identityService";
import { transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";

const registerSchema = z.object({
  nombres: z.string().min(1).optional(),
  apellido_paterno: z.string().min(1).optional(),
  apellido_materno: z.string().optional(),
  fecha_nacimiento: z.string().optional(),
  genero: z.nativeEnum(Gender).optional(),
  estado_nacimiento: z.string().optional(),
  pais: z.string().default("México"),
  curp: z.string().length(18).optional(),
  telefono: z.string().min(10).optional(),
  email: z.string().email().optional(),
  webSessionId: z.string().optional(),
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
});

const abandonSchema = z.object({
  caseId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().default("USER_CLOSED_BROWSER"),
});

export async function webChannelRoutes(app: FastifyInstance) {
  /**
   * Registro / Identity Stitching del paciente con los 9 campos oficiales de Salud Digna
   */
  app.post(
    "/api/channels/web/register",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Registra o enriquece al paciente (9 campos) y vincula sus identidades multicanal",
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
   * Cotizar estudio y seleccionar clinica en Sitio Web (guardado progresivo de estado)
   */
  app.post(
    "/api/channels/web/quote",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Cotiza un estudio y opcionalmente selecciona clínica guardando avance en PostgreSQL",
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
      const patient = await resolveOrCreatePatient({
        firstName: body.nombres,
        paternalLastName: body.apellido_paterno,
        phone: body.telefono,
        curp: body.curp,
        webSessionId,
      });

      // Buscar caso existente o crear uno nuevo
      let serviceCase = body.caseId
        ? await prisma.serviceCase.findUnique({ where: { id: body.caseId } })
        : await prisma.serviceCase.findFirst({
            where: {
              patientId: patient.id,
              currentState: { not: CaseState.CITA_CONFIRMADA },
            },
            orderBy: { updatedAt: "desc" },
          });

      if (!serviceCase) {
        serviceCase = await prisma.serviceCase.create({
          data: {
            patientId: patient.id,
            currentState: CaseState.INICIADO,
            currentChannel: Channel.WEB,
            contextJson: { otp_verified_channels: ["WEB"] },
          },
        });

        await recordAndPublishEvent({
          caseId: serviceCase.id,
          patientId: patient.id,
          journeyId: serviceCase.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.SESSION_STARTED,
          prevState: null,
          nextState: CaseState.INICIADO,
          payload: { webSessionId },
        });
      }

      if (body.telefono || body.curp) {
        await recordAndPublishEvent({
          caseId: serviceCase.id,
          patientId: patient.id,
          journeyId: serviceCase.journeyId,
          correlationId,
          channel: Channel.WEB,
          actorRole: ActorRole.SYSTEM,
          eventType: EventType.IDENTITY_LINKED,
          payload: {
            linkedPhone: Boolean(body.telefono),
            linkedCurp: Boolean(body.curp),
          },
        });
      }

      const expectedVer = body.expectedVersion ?? serviceCase.version;

      // Transicion 1: STUDY_QUOTED -> COTIZANDO
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
        eventPayload: { studyCode: study.code, price: study.price },
      });

      let finalCase = step1.updatedCase;

      // Transicion 2 (si eligio clinica): CLINIC_SELECTED -> CLINICA_ELEGIDA
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
        patientId: patient.id,
        webSessionId,
        correlationId,
      });
    }
  );

  /**
   * Simula cierre de navegador / abandono parcial -> FLOW_INTERRUPTED (PAUSADO_PENDIENTE)
   */
  app.post(
    "/api/channels/web/abandon",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Registra abandono o cierre abrupto en Web conservando el contexto intacto",
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
   * Recupera tramite activo por telefono, CURP o sesion Web (soporta salto inverso WA -> Web)
   */
  app.get(
    "/api/channels/web/case",
    {
      schema: {
        tags: ["Canal 1: Sitio Web"],
        summary: "Consulta el trámite activo de un paciente por teléfono, CURP o sesión Web",
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
        where: { patientId: patient.id },
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
