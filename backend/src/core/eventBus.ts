import crypto from "crypto";
import { ActorRole, CaseState, Channel, EventType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { JOURNEY_PUBSUB_CHANNEL, redis } from "../lib/redis";
import { maskPatientName } from "../lib/crypto";

export interface EmitEventInput {
  caseId: string;
  patientId: string;
  journeyId: string;
  correlationId?: string;
  channel: Channel;
  actorRole: ActorRole;
  eventType: EventType;
  prevState?: CaseState | null;
  nextState?: CaseState | null;
  payload?: Record<string, unknown>;
}

/**
 * Registra un evento inmutable en PostgreSQL (journey_events) y lo publica
 * al canal distribuido Redis Pub/Sub para difusion SSE stateless (Admin y Pacientes).
 */
export async function recordAndPublishEvent(input: EmitEventInput) {
  const correlationId = input.correlationId ?? crypto.randomUUID();

  const event = await prisma.journeyEvent.create({
    data: {
      caseId: input.caseId,
      patientId: input.patientId,
      journeyId: input.journeyId,
      correlationId,
      channel: input.channel,
      actorRole: input.actorRole,
      eventType: input.eventType,
      prevState: input.prevState ?? null,
      nextState: input.nextState ?? null,
      payloadJson: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
    include: {
      patient: {
        select: { firstName: true, paternalLastName: true },
      },
      serviceCase: {
        select: {
          requesterPatientId: true,
          relationshipLabel: true,
          thirdPartyConsent: true,
        },
      },
    },
  });

  const broadcastPayload = {
    id: event.id,
    caseId: event.caseId,
    patientId: event.patientId,
    requesterPatientId: event.serviceCase.requesterPatientId ?? event.patientId,
    relationshipLabel: event.serviceCase.relationshipLabel ?? "Titular",
    isThirdParty:
      Boolean(event.serviceCase.requesterPatientId) &&
      event.serviceCase.requesterPatientId !== event.patientId,
    journeyId: event.journeyId,
    correlationId: event.correlationId,
    patientMasked: maskPatientName(event.patient.firstName, event.patient.paternalLastName),
    channel: event.channel,
    actorRole: event.actorRole,
    eventType: event.eventType,
    prevState: event.prevState,
    nextState: event.nextState,
    payload: event.payloadJson,
    createdAt: event.createdAt.toISOString(),
  };

  await redis.publish(JOURNEY_PUBSUB_CHANNEL, JSON.stringify(broadcastPayload));

  return { event, correlationId, broadcastPayload };
}
