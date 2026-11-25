import { ActorRole, CaseState, Channel, EventType, Prisma, ServiceCase } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { recordAndPublishEvent } from "./eventBus";

export class OptimisticLockError extends Error {
  statusCode = 409;
  constructor(caseId: string, expectedVersion: number) {
    super(
      `Conflicto de concurrencia optimista en caso ${caseId}: la version esperada (${expectedVersion}) fue modificada por otro canal.`
    );
    this.name = "OptimisticLockError";
  }
}

export class InvalidStateTransitionError extends Error {
  statusCode = 400;
  constructor(from: CaseState, to: CaseState) {
    super(`Transicion de estado invalida: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export interface CaseContextJson {
  study?: {
    code: string;
    name: string;
    price: number;
    prep: string;
  };
  clinic?: {
    id: string;
    name: string;
    city?: string;
    address?: string;
  };
  preferred_slot?: {
    date: string;
    time: string;
  };
  payment_method?: "online" | "oxxo" | "clinic";
  open_questions?: string[];
  appointment_folio?: string | null;
  qr_payload?: string | null;
  otp_verified_channels?: string[];
  handoff_summary?: string;
  beneficiary_summary?: {
    is_third_party: boolean;
    relationship: string;
    beneficiary_name: string;
    requester_name?: string;
  };
}

/**
 * Grafo canonico deterministico de los 8 estados oficiales con soporte total
 * para N-saltos bidireccionales entre Web <-> WhatsApp <-> Call Center.
 */
const ALLOWED_TRANSITIONS: Record<CaseState, CaseState[]> = {
  [CaseState.INICIADO]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.EN_PROGRESO,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
  ],
  [CaseState.COTIZANDO]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.EN_PROGRESO,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.CLINICA_ELEGIDA]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.EN_PROGRESO,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.PAUSADO_PENDIENTE]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.EN_PROGRESO,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.EN_PROGRESO]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.DUDAS_ABIERTAS]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.EN_PROGRESO,
    CaseState.DUDAS_ABIERTAS,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.EN_ATENCION_ASESOR]: [
    CaseState.COTIZANDO,
    CaseState.CLINICA_ELEGIDA,
    CaseState.PAUSADO_PENDIENTE,
    CaseState.EN_PROGRESO,
    CaseState.EN_ATENCION_ASESOR,
    CaseState.DUDAS_ABIERTAS,
    CaseState.CITA_CONFIRMADA,
  ],
  [CaseState.CITA_CONFIRMADA]: [CaseState.CITA_CONFIRMADA],
};

export function assertValidTransition(from: CaseState, to: CaseState): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Constructor 100% deterministico del Resumen Handoff (con soporte Multibeneficiario).
 */
export function buildDeterministicHandoffSummary(
  patientName: string,
  ctx: CaseContextJson,
  currentState: CaseState,
  currentChannel: Channel,
  thirdPartyInfo?: { isThirdParty: boolean; requesterName?: string; relationshipLabel?: string }
): string {
  const parts: string[] = [];
  const studyText = ctx.study
    ? `${ctx.study.name} ($${ctx.study.price} MXN)`
    : "estudio pendiente de definir";
  const clinicText = ctx.clinic ? `en ${ctx.clinic.name}` : "sin clínica seleccionada";

  if (thirdPartyInfo?.isThirdParty && thirdPartyInfo.requesterName) {
    parts.push(
      `Cita para ${patientName} (${thirdPartyInfo.relationshipLabel || "Familiar"}), gestionada por ${thirdPartyInfo.requesterName}: ${studyText} ${clinicText}.`
    );
  } else {
    parts.push(`${patientName} inició trámite para ${studyText} ${clinicText}.`);
  }

  if (ctx.preferred_slot) {
    parts.push(`Horario preferido: ${ctx.preferred_slot.date} a las ${ctx.preferred_slot.time}.`);
  }
  if (ctx.open_questions && ctx.open_questions.length > 0) {
    parts.push(`Duda pendiente: "${ctx.open_questions[ctx.open_questions.length - 1]}".`);
  }
  if (ctx.study?.prep) {
    parts.push(`Preparación: ${ctx.study.prep}`);
  }
  if (ctx.appointment_folio) {
    parts.push(`Cita confirmada con folio ${ctx.appointment_folio}.`);
  } else {
    parts.push(`Estado actual: ${currentState} (último canal: ${currentChannel}).`);
  }
  return parts.join(" ");
}

export interface TransitionCaseInput {
  caseId: string;
  expectedVersion: number;
  nextState: CaseState;
  channel: Channel;
  actorRole: ActorRole;
  eventType: EventType;
  correlationId?: string;
  contextPatch?: Partial<CaseContextJson>;
  assignedAdvisorId?: string | null;
  eventPayload?: Record<string, unknown>;
}

export async function transitionServiceCase(input: TransitionCaseInput): Promise<{
  updatedCase: ServiceCase;
  correlationId: string;
}> {
  const existing = await prisma.serviceCase.findUnique({
    where: { id: input.caseId },
    include: {
      patient: { select: { firstName: true, paternalLastName: true } },
      requester: { select: { firstName: true, paternalLastName: true } },
    },
  });

  if (!existing) {
    const err = new Error(`Caso no encontrado: ${input.caseId}`) as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }

  assertValidTransition(existing.currentState, input.nextState);

  const prevCtx = (existing.contextJson ?? {}) as CaseContextJson;
  const mergedCtx: CaseContextJson = {
    ...prevCtx,
    ...(input.contextPatch ?? {}),
  };

  const patientDisplay =
    [existing.patient.firstName, existing.patient.paternalLastName].filter(Boolean).join(" ") ||
    "Paciente";
  const requesterDisplay = existing.requester
    ? [existing.requester.firstName, existing.requester.paternalLastName].filter(Boolean).join(" ")
    : undefined;
  const isThirdParty =
    Boolean(existing.requesterPatientId) && existing.requesterPatientId !== existing.patientId;

  mergedCtx.beneficiary_summary = {
    is_third_party: isThirdParty,
    relationship: existing.relationshipLabel || (isThirdParty ? "Familiar" : "Titular"),
    beneficiary_name: patientDisplay,
    ...(isThirdParty && requesterDisplay ? { requester_name: requesterDisplay } : {}),
  };

  mergedCtx.handoff_summary = buildDeterministicHandoffSummary(
    patientDisplay,
    mergedCtx,
    input.nextState,
    input.channel,
    {
      isThirdParty,
      requesterName: requesterDisplay,
      relationshipLabel: existing.relationshipLabel ?? undefined,
    }
  );

  const updateResult = await prisma.serviceCase.updateMany({
    where: {
      id: existing.id,
      version: input.expectedVersion,
    },
    data: {
      currentState: input.nextState,
      currentChannel: input.channel,
      contextJson: mergedCtx as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
      ...(input.assignedAdvisorId !== undefined
        ? { assignedAdvisorId: input.assignedAdvisorId }
        : {}),
    },
  });

  if (updateResult.count === 0) {
    throw new OptimisticLockError(existing.id, input.expectedVersion);
  }

  const updatedCase = await prisma.serviceCase.findUniqueOrThrow({
    where: { id: existing.id },
  });

  const { correlationId } = await recordAndPublishEvent({
    caseId: updatedCase.id,
    patientId: updatedCase.patientId,
    journeyId: updatedCase.journeyId,
    correlationId: input.correlationId,
    channel: input.channel,
    actorRole: input.actorRole,
    eventType: input.eventType,
    prevState: existing.currentState,
    nextState: updatedCase.currentState,
    payload: {
      version: updatedCase.version,
      ...(input.eventPayload ?? {}),
    },
  });

  return { updatedCase, correlationId };
}
