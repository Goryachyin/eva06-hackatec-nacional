import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { ActorRole, CaseState, Channel, EventType, StaffRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireStaffRole } from "../middleware/rbac";
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
}
