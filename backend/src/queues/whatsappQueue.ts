import crypto from "crypto";
import { Queue, Worker, Job } from "bullmq";
import { ActorRole, CaseState, Channel, EventType, IdentifierType } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import {
  createBullConnection,
  redis,
  WHATSAPP_OUTBOUND_PUBSUB_CHANNEL,
} from "../lib/redis";
import { maskPatientName, normalizePhone, signGatewayPayload } from "../lib/crypto";
import { CLINICS_CATALOG, STUDIES_CATALOG } from "../data/catalog";
import { BOT_TEMPLATES } from "../data/botTemplates";
import {
  findPatientByIdentifier,
  issueOtpChallenge,
  resolveOrCreatePatient,
  verifyOtpChallenge,
} from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";

export interface WhatsAppInboundJob {
  messageId: string;
  fromPhone: string;
  /** JID de Baileys (ej. 5217443116876@s.whatsapp.net) para responder al chat exacto */
  remoteJid?: string;
  text: string;
  source: "baileys" | "simulator";
  correlationId: string;
  receivedAt: string;
}

export interface SignedOutboundEnvelope {
  id: string;
  toPhone: string;
  remoteJid?: string;
  text: string;
  correlationId: string;
  timestamp: string;
  signature: string;
}

export interface ChatBubble {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  timestamp: string;
  correlationId: string;
}

const CHAT_HISTORY_KEY = (phone: string) => `sim:wa:chat:${normalizePhone(phone)}`;
const SELECTED_CASE_KEY = (phone: string) => `wa:active_case:${normalizePhone(phone)}`;
const PENDING_OUTBOUND_LIST = "gw:wa:outbound:pending";

// Hash-tag "{bull}" compatible con Redis standalone y AWS ElastiCache Valkey Cluster Mode
const BULLMQ_PREFIX = "{bull}";

export const whatsappInboundQueue = new Queue<WhatsAppInboundJob>("whatsapp-inbound", {
  connection: createBullConnection(),
  prefix: BULLMQ_PREFIX,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: { count: 500 },
    removeOnFail: false,
  },
});

export const whatsappDlqQueue = new Queue("whatsapp-dlq", {
  connection: createBullConnection(),
  prefix: BULLMQ_PREFIX,
});

async function appendChatBubble(phone: string, bubble: ChatBubble) {
  const key = CHAT_HISTORY_KEY(phone);
  await redis.rpush(key, JSON.stringify(bubble));
  await redis.ltrim(key, -50, -1);
  await redis.expire(key, 86400);
}

export async function getSimulatedChatHistory(phone: string): Promise<ChatBubble[]> {
  const items = await redis.lrange(CHAT_HISTORY_KEY(phone), 0, -1);
  return items.map((x) => JSON.parse(x) as ChatBubble);
}

/**
 * Empaqueta y firma criptograficamente (HMAC-SHA256) un mensaje saliente
 * para el Gateway local Baileys a traves de Redis Pub/Sub -> SSE autenticado.
 * Si no hay gateway conectado en ese instante, queda respaldado en Redis.
 */
export async function publishSignedGatewayOutbound(params: {
  toPhone: string;
  remoteJid?: string;
  text: string;
  correlationId: string;
}): Promise<SignedOutboundEnvelope> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const corePayload = {
    id: crypto.randomUUID(),
    toPhone: normalizePhone(params.toPhone),
    remoteJid: params.remoteJid,
    text: params.text,
    correlationId: params.correlationId,
  };
  const signature = signGatewayPayload(
    timestamp,
    JSON.stringify(corePayload),
    env.WHATSAPP_GATEWAY_SECRET
  );

  const envelope: SignedOutboundEnvelope = {
    ...corePayload,
    timestamp,
    signature,
  };

  const serialized = JSON.stringify(envelope);
  const receivers = await redis.publish(WHATSAPP_OUTBOUND_PUBSUB_CHANNEL, serialized);

  // Si ningun gateway SSE esta conectado en este segundo, lo resguardamos en buffer temporal
  if (receivers === 0) {
    await redis.rpush(PENDING_OUTBOUND_LIST, serialized);
    await redis.ltrim(PENDING_OUTBOUND_LIST, -100, -1);
    await redis.expire(PENDING_OUTBOUND_LIST, 1800);
  }

  return envelope;
}

export async function drainPendingGatewayOutbound(): Promise<SignedOutboundEnvelope[]> {
  const results: SignedOutboundEnvelope[] = [];
  for (let i = 0; i < 50; i++) {
    const raw = await redis.lpop(PENDING_OUTBOUND_LIST);
    if (!raw) break;
    try {
      results.push(JSON.parse(raw) as SignedOutboundEnvelope);
    } catch {
      // Ignorar elemento corrupto
    }
  }
  return results;
}

async function replyToPatient(job: WhatsAppInboundJob, replyText: string) {
  await appendChatBubble(job.fromPhone, {
    id: crypto.randomUUID(),
    direction: "outbound",
    text: replyText,
    timestamp: new Date().toISOString(),
    correlationId: job.correlationId,
  });

  if (job.source === "baileys") {
    await publishSignedGatewayOutbound({
      toPhone: job.fromPhone,
      remoteJid: job.remoteJid,
      text: replyText,
      correlationId: job.correlationId,
    });
  }
}

const STATE_SHORT: Record<CaseState, string> = {
  INICIADO: "Iniciado",
  COTIZANDO: "Cotizando",
  CLINICA_ELEGIDA: "Clínica elegida",
  PAUSADO_PENDIENTE: "Guardado / Pendiente",
  EN_PROGRESO: "En progreso",
  DUDAS_ABIERTAS: "Con duda abierta",
  EN_ATENCION_ASESOR: "En Call Center",
  CITA_CONFIRMADA: "Cita confirmada",
};

/**
 * Motor deterministico del Canal WhatsApp (CERO Bot-Bot / CERO Meta Cloud API).
 * Soporta:
 *  - Multibeneficiario (Titular + Familiares/Conocidos con menu numerado y privacidad)
 *  - Step-Up OTP en saltos de canal y citas de terceros
 *  - N-saltos bidireccionales Web <-> WhatsApp <-> Call Center
 */
export async function processWhatsAppInbound(jobData: WhatsAppInboundJob): Promise<{ reply: string }> {
  const phone = normalizePhone(jobData.fromPhone);
  const text = jobData.text.trim();
  const correlationId = jobData.correlationId;

  await appendChatBubble(phone, {
    id: jobData.messageId,
    direction: "inbound",
    text,
    timestamp: jobData.receivedAt,
    correlationId,
  });

  // 1. Resolver o crear al Titular propietario del numero telefonico
  let holder = await findPatientByIdentifier(IdentifierType.PHONE, phone);
  if (!holder) {
    holder = await resolveOrCreatePatient({ phone });
  }

  // 2. Obtener TODOS los tramites abiertos gestionados por este titular o donde es beneficiario
  const openCases = await prisma.serviceCase.findMany({
    where: {
      OR: [{ requesterPatientId: holder.id }, { patientId: holder.id }],
      currentState: { not: CaseState.CITA_CONFIRMADA },
    },
    include: {
      patient: { select: { id: true, firstName: true, paternalLastName: true, phone: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });

  // Comando explicito "NUEVO" para abrir una nueva cotizacion aunque existan otras
  const wantsNewCase = /^nuevo(\s+estudio)?$/i.test(text);

  // Comando explicito "MENU" / "CAMBIAR" / "MIS CITAS" para listar tramites familiares/propios
  const wantsMenu = /^(menu|men[uú]|cambiar|mis citas|tramites|tr[aá]mites)$/i.test(text);

  if (wantsMenu && openCases.length > 0) {
    await redis.del(SELECTED_CASE_KEY(phone));
    const lines = openCases.map((c, idx) => {
      const ctx = (c.contextJson ?? {}) as CaseContextJson;
      const who = maskPatientName(c.patient.firstName, c.patient.paternalLastName);
      const rel = c.relationshipLabel || (c.patientId === holder!.id ? "Titular" : "Familiar");
      const study = ctx.study?.name || "Estudio por elegir";
      return `${idx + 1}) ${study} — Para: ${who} (${rel}) [${STATE_SHORT[c.currentState]}]`;
    });
    const reply =
      `📋 Trámites activos asociados a tu número:\n${lines.join("\n")}\n\n` +
      `Responde con el número (1${openCases.length > 1 ? ` a ${openCases.length}` : ""}) para retomar ese trámite, o escribe "NUEVO" para iniciar otro estudio.`;
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // Seleccionar caso activo (soporte multibeneficiario cuando hay > 1 tramite abierto)
  let selectedCaseId = await redis.get(SELECTED_CASE_KEY(phone));
  let activeCase = wantsNewCase
    ? undefined
    : openCases.find((c) => c.id === selectedCaseId) ?? (openCases.length === 1 ? openCases[0] : undefined);

  // Si hay varios tramites abiertos (ej. Titular + Hijo/a) y aun no elige cual retomar
  if (!wantsNewCase && openCases.length > 1 && !activeCase) {
    const choiceMatch = text.match(/^(\d{1,2})$/);
    if (choiceMatch) {
      const idx = Number(choiceMatch[1]) - 1;
      if (idx >= 0 && idx < openCases.length) {
        activeCase = openCases[idx];
        await redis.set(SELECTED_CASE_KEY(phone), activeCase.id, "EX", 1800);
        // Al seleccionar el numero, si ya esta verificado le mostramos resumen inmediato; si requiere OTP caera en el bloque 3
        const chosenCtx = (activeCase.contextJson ?? {}) as CaseContextJson;
        const verifiedCh = chosenCtx.otp_verified_channels ?? [];
        const isThirdParty = activeCase.patientId !== holder.id;
        const needsOtpNow =
          !verifiedCh.includes("WHATSAPP") &&
          (activeCase.currentChannel !== Channel.WHATSAPP ||
            activeCase.currentState === CaseState.PAUSADO_PENDIENTE ||
            isThirdParty);

        if (!needsOtpNow) {
          const who = maskPatientName(activeCase.patient.firstName, activeCase.patient.paternalLastName);
          const rel = activeCase.relationshipLabel || (isThirdParty ? "Familiar" : "Titular");
          const reply =
            `✅ Retomamos el trámite de ${who} (${rel}):\n` +
            `• Estudio: ${chosenCtx.study?.name ?? "Por definir"}\n` +
            `• Clínica: ${chosenCtx.clinic?.name ?? "Por elegir"}\n` +
            `• Estatus: ${STATE_SHORT[activeCase.currentState]}\n` +
            `Escribe tu duda, una clínica, "CONFIRMAR" o "CAMBIAR" para ver tus otros trámites.`;
          await replyToPatient(jobData, reply);
          return { reply };
        }
      }
    }

    if (!activeCase) {
      const lines = openCases.map((c, idx) => {
        const ctx = (c.contextJson ?? {}) as CaseContextJson;
        const who = maskPatientName(c.patient.firstName, c.patient.paternalLastName);
        const rel = c.relationshipLabel || (c.patientId === holder!.id ? "Titular" : "Familiar");
        const study = ctx.study?.name || "Estudio por elegir";
        return `${idx + 1}) ${study} — Para: ${who} (${rel}) [${STATE_SHORT[c.currentState]}]`;
      });
      const reply =
        `👋 Detectamos ${openCases.length} trámites activos vinculados a tu número (protegiendo la privacidad de cada paciente):\n` +
        `${lines.join("\n")}\n\n` +
        `Responde con el número (1 a ${openCases.length}) del trámite que deseas retomar, o escribe "NUEVO" para cotizar otro estudio.`;
      await replyToPatient(jobData, reply);
      return { reply };
    }
  }

  // Si no tiene tramite abierto (o pidio "NUEVO"), revisar si pregunta por cita confirmada o crear caso nuevo
  if (!activeCase) {
    if (!wantsNewCase && /cita|folio|estado|status/i.test(text)) {
      const confirmed = await prisma.serviceCase.findFirst({
        where: {
          OR: [{ requesterPatientId: holder.id }, { patientId: holder.id }],
          currentState: CaseState.CITA_CONFIRMADA,
        },
        include: {
          patient: { select: { firstName: true, paternalLastName: true } },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (confirmed) {
        const ctx = (confirmed.contextJson ?? {}) as CaseContextJson;
        const who = maskPatientName(confirmed.patient.firstName, confirmed.patient.paternalLastName);
        const reply =
          `✅ Cita confirmada (${ctx.appointment_folio ?? "Folio activo"}) para ${who}:\n` +
          `• Estudio: ${ctx.study?.name ?? "Estudio"}\n` +
          `• Clínica: ${ctx.clinic?.name ?? "Clínica asignada"}\n` +
          `• Preparación: ${ctx.study?.prep ?? "Presentarse 15 min antes."}`;
        await replyToPatient(jobData, reply);
        return { reply };
      }
    }

    const createdCase = await prisma.serviceCase.create({
      data: {
        patientId: holder.id,
        requesterPatientId: holder.id,
        relationshipLabel: "Titular",
        thirdPartyConsent: false,
        currentState: CaseState.INICIADO,
        currentChannel: Channel.WHATSAPP,
        contextJson: { otp_verified_channels: ["WHATSAPP"] },
      },
      include: {
        patient: { select: { id: true, firstName: true, paternalLastName: true, phone: true } },
      },
    });
    activeCase = createdCase;
    await redis.set(SELECTED_CASE_KEY(phone), activeCase.id, "EX", 1800);

    await recordAndPublishEvent({
      caseId: activeCase.id,
      patientId: holder.id,
      journeyId: activeCase.journeyId,
      correlationId,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.SESSION_STARTED,
      prevState: null,
      nextState: CaseState.INICIADO,
      payload: { source: jobData.source },
    });

    const matchedStudy = STUDIES_CATALOG.find(
      (s) =>
        text.toLowerCase().includes(s.code.toLowerCase()) ||
        text.toLowerCase().includes(s.name.toLowerCase().split(" ")[0]) ||
        text.toLowerCase().includes(s.category.toLowerCase())
    );

    if (matchedStudy) {
      await transitionServiceCase({
        caseId: activeCase.id,
        expectedVersion: activeCase.version,
        nextState: CaseState.COTIZANDO,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.STUDY_QUOTED,
        correlationId,
        contextPatch: {
          study: {
            code: matchedStudy.code,
            name: matchedStudy.name,
            price: matchedStudy.price,
            prep: matchedStudy.prep,
          },
        },
        eventPayload: { studyCode: matchedStudy.code, price: matchedStudy.price },
      });
      const reply = BOT_TEMPLATES.studyQuoted(
        matchedStudy.name,
        matchedStudy.price,
        matchedStudy.prep
      );
      await replyToPatient(jobData, reply);
      return { reply };
    }

    if (/^1$|servicio|estudio|cat[aá]logo|precio|cotizar/i.test(text)) {
      const reply = BOT_TEMPLATES.studiesCatalog();
      await replyToPatient(jobData, reply);
      return { reply };
    }

    if (/^2$|cl[ií]nica|sucursal|horario|direcci[oó]n|ubicaci[oó]n/i.test(text)) {
      const reply = BOT_TEMPLATES.clinicsList();
      await replyToPatient(jobData, reply);
      return { reply };
    }

    const reply = BOT_TEMPLATES.welcomeMenu();
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // Persistir caso seleccionado para los siguientes mensajes
  await redis.set(SELECTED_CASE_KEY(phone), activeCase.id, "EX", 1800);

  const ctx = (activeCase.contextJson ?? {}) as CaseContextJson;
  const verifiedChannels = ctx.otp_verified_channels ?? [];
  const isThirdParty = activeCase.patientId !== holder.id;
  const cameFromOtherChannel = activeCase.currentChannel !== Channel.WHATSAPP;
  const needsStepUpOtp =
    !verifiedChannels.includes("WHATSAPP") &&
    (cameFromOtherChannel ||
      activeCase.currentState === CaseState.PAUSADO_PENDIENTE ||
      isThirdParty);

  // 3. Seguridad Step-Up OTP cuando retoma desde otro canal o gestiona cita de tercero
  const otpMatch = text.match(/^\d{6}$/);

  if (needsStepUpOtp) {
    if (otpMatch) {
      const verification = await verifyOtpChallenge({
        patientId: activeCase.patientId,
        caseId: activeCase.id,
        journeyId: activeCase.journeyId,
        channel: Channel.WHATSAPP,
        code: otpMatch[0],
        correlationId,
      });

      if (!verification.ok) {
        const reply = `🔒 ${verification.reason}`;
        await replyToPatient(jobData, reply);
        return { reply };
      }

      const { updatedCase } = await transitionServiceCase({
        caseId: activeCase.id,
        expectedVersion: activeCase.version,
        nextState: CaseState.EN_PROGRESO,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.SYSTEM,
        eventType: EventType.CONTEXT_REHYDRATED,
        correlationId,
        contextPatch: {
          otp_verified_channels: [...verifiedChannels, "WHATSAPP"],
        },
        eventPayload: {
          recoveredFromState: activeCase.currentState,
          recoveredFromChannel: activeCase.currentChannel,
          isThirdParty,
        },
      });

      const reCtx = (updatedCase.contextJson ?? {}) as CaseContextJson;
      const beneficiaryLabel = isThirdParty
        ? `${maskPatientName(activeCase.patient.firstName, activeCase.patient.paternalLastName)} (${activeCase.relationshipLabel || "Familiar"})`
        : activeCase.patient.firstName ?? "Paciente";

      const reply =
        `✅ Identidad verificada. Retomamos el trámite de ${beneficiaryLabel} exactamente donde quedó:\n` +
        `• Estudio: ${reCtx.study?.name ?? "Por definir"} ($${reCtx.study?.price ?? "--"} MXN)\n` +
        `• Clínica: ${reCtx.clinic?.name ?? "Por elegir"}\n` +
        `Puedes escribir tu duda (ej: "¿Requiero ayuno?"), indicar clínica, escribir "CONFIRMAR" o "CAMBIAR" para cambiar de trámite.`;

      await replyToPatient(jobData, reply);
      return { reply };
    }

    await recordAndPublishEvent({
      caseId: activeCase.id,
      patientId: activeCase.patientId,
      journeyId: activeCase.journeyId,
      correlationId,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.SYSTEM,
      eventType: EventType.CHANNEL_SWITCH_DETECTED,
      payload: {
        fromChannel: activeCase.currentChannel,
        toChannel: Channel.WHATSAPP,
        isThirdParty,
      },
    });

    const beneficiaryRecord = await prisma.patient.findUniqueOrThrow({
      where: { id: activeCase.patientId },
    });

    await issueOtpChallenge({
      patient: beneficiaryRecord,
      caseId: activeCase.id,
      journeyId: activeCase.journeyId,
      channel: Channel.WHATSAPP,
      correlationId,
      destinationPhone: holder.phone,
    });

    const reasonText = isThirdParty
      ? "Detectamos una cita gestionada para un familiar/tercero."
      : "Detectamos un trámite pendiente iniciado en otro canal.";

    const reply =
      `🔐 ${reasonText} Por privacidad clínica, enviamos un código de verificación de 6 dígitos a tu segundo factor (Consola 2FA / SMS). Respóndeme con ese código para continuar donde te quedaste.`;
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // 4. Canal autenticado: procesar opciones predeterminadas (1..4), estudio, clinica, pagos, asesor, confirmacion o duda
  if (/^(hola|buen[oa]s|inicio|ayuda|opciones)\b/i.test(text) && !ctx.study) {
    const reply = BOT_TEMPLATES.welcomeMenu();
    await replyToPatient(jobData, reply);
    return { reply };
  }

  if (/^1$|cat[aá]logo|precios|servicios|cotizar un estudio/i.test(text) && !ctx.study) {
    const reply = BOT_TEMPLATES.studiesCatalog();
    await replyToPatient(jobData, reply);
    return { reply };
  }

  if (/^2$|cl[ií]nicas|sucursales|horarios|direcci[oó]n|ubicaci[oó]n/i.test(text)) {
    const reply = BOT_TEMPLATES.clinicsList();
    await replyToPatient(jobData, reply);
    return { reply };
  }

  if (/pago|pagar|tarjeta|oxxo|descuento|costo/i.test(text)) {
    const reply = BOT_TEMPLATES.paymentInfo(ctx.study?.name, ctx.study?.price);
    await replyToPatient(jobData, reply);
    return { reply };
  }

  if (/^4$|asesor|call\s*center|humano|operador|llamada/i.test(text)) {
    const existingQuestions = ctx.open_questions ?? [];
    await transitionServiceCase({
      caseId: activeCase.id,
      expectedVersion: activeCase.version,
      nextState: CaseState.DUDAS_ABIERTAS,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.PATIENT_QUESTION_LOGGED,
      correlationId,
      contextPatch: {
        open_questions: [...existingQuestions, "Solicita atención con asesor de Call Center"],
      },
      eventPayload: { question: text, requestedAdvisor: true },
    });
    const reply = BOT_TEMPLATES.escalatedToAdvisor(ctx.study?.name, ctx.clinic?.name);
    await replyToPatient(jobData, reply);
    return { reply };
  }

  const matchedStudyExisting = !ctx.study
    ? STUDIES_CATALOG.find(
        (s) =>
          text.toLowerCase().includes(s.code.toLowerCase()) ||
          text.toLowerCase().includes(s.name.toLowerCase().split(" ")[0]) ||
          text.toLowerCase().includes(s.category.toLowerCase())
      )
    : undefined;

  if (matchedStudyExisting) {
    await transitionServiceCase({
      caseId: activeCase.id,
      expectedVersion: activeCase.version,
      nextState: CaseState.COTIZANDO,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.STUDY_QUOTED,
      correlationId,
      contextPatch: {
        study: {
          code: matchedStudyExisting.code,
          name: matchedStudyExisting.name,
          price: matchedStudyExisting.price,
          prep: matchedStudyExisting.prep,
        },
      },
      eventPayload: { studyCode: matchedStudyExisting.code, price: matchedStudyExisting.price },
    });

    const reply = BOT_TEMPLATES.studyQuoted(
      matchedStudyExisting.name,
      matchedStudyExisting.price,
      matchedStudyExisting.prep
    );
    await replyToPatient(jobData, reply);
    return { reply };
  }

  const matchedClinic = CLINICS_CATALOG.find(
    (c) =>
      text.toLowerCase().includes(c.id.toLowerCase()) ||
      text.toLowerCase().includes(c.city.toLowerCase().split(",")[0])
  );

  if (matchedClinic && !ctx.clinic) {
    await transitionServiceCase({
      caseId: activeCase.id,
      expectedVersion: activeCase.version,
      nextState: CaseState.CLINICA_ELEGIDA,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.CLINIC_SELECTED,
      correlationId,
      contextPatch: {
        clinic: {
          id: matchedClinic.id,
          name: matchedClinic.name,
          city: matchedClinic.city,
          address: matchedClinic.address,
        },
      },
      eventPayload: { clinicId: matchedClinic.id },
    });

    const reply = BOT_TEMPLATES.clinicSelected(matchedClinic.name, matchedClinic.address);
    await replyToPatient(jobData, reply);
    return { reply };
  }

  if (/^confirmar|agendar$/i.test(text)) {
    const folio = `SD-2026-${crypto.randomInt(1000, 9999)}`;
    await transitionServiceCase({
      caseId: activeCase.id,
      expectedVersion: activeCase.version,
      nextState: CaseState.CITA_CONFIRMADA,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.APPOINTMENT_CONFIRMED,
      correlationId,
      contextPatch: {
        appointment_folio: folio,
        qr_payload: `SALUDDIGNA|${folio}|${ctx.study?.code ?? "EST"}|${ctx.clinic?.id ?? "CLN"}`,
      },
      eventPayload: { folio, confirmedVia: Channel.WHATSAPP },
    });
    await redis.del(SELECTED_CASE_KEY(phone));

    const reply = BOT_TEMPLATES.appointmentConfirmed(
      folio,
      ctx.study?.name ?? "Estudio",
      ctx.clinic?.name ?? "Clínica",
      ctx.study?.prep ?? "Presentarse 15 min antes."
    );
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // Registrar duda clinica/operativa -> DUDAS_ABIERTAS (lista para Call Center Screen-Pop)
  const existingQuestions = ctx.open_questions ?? [];
  const nextQuestions = [...existingQuestions, text];

  await transitionServiceCase({
    caseId: activeCase.id,
    expectedVersion: activeCase.version,
    nextState: CaseState.DUDAS_ABIERTAS,
    channel: Channel.WHATSAPP,
    actorRole: ActorRole.PATIENT,
    eventType: EventType.PATIENT_QUESTION_LOGGED,
    correlationId,
    contextPatch: {
      open_questions: nextQuestions,
    },
    eventPayload: { question: text },
  });

  const prepAnswer =
    /ayuno|preparaci[oó]n|comer|agua/i.test(text) && ctx.study?.prep
      ? `Sobre tu estudio (${ctx.study.name}): ${ctx.study.prep}\n`
      : "";

  const reply =
    `${prepAnswer}📝 Registramos tu consulta en el expediente activo. Si prefieres continuar en Web o llamar a nuestro Call Center, todo tu contexto y esta duda ya aparecen sincronizados sin repetir nada.`;

  await replyToPatient(jobData, reply);
  return { reply };
}

let workerInstance: Worker<WhatsAppInboundJob> | null = null;

export function startWhatsAppWorker() {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<WhatsAppInboundJob>(
    "whatsapp-inbound",
    async (job: Job<WhatsAppInboundJob>) => {
      return processWhatsAppInbound(job.data);
    },
    {
      connection: createBullConnection(),
      prefix: BULLMQ_PREFIX,
      concurrency: 10,
    }
  );

  workerInstance.on("failed", async (job, err) => {
    console.error(`[BullMQ] Job ${job?.id} fallo (intento ${job?.attemptsMade}):`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      await whatsappDlqQueue.add("dead-letter", {
        originalJobId: job.id,
        data: job.data,
        failedReason: err.message,
        failedAt: new Date().toISOString(),
      });
      console.error(`[BullMQ DLQ] Job ${job.id} movido a whatsapp-dlq`);
    }
  });

  return workerInstance;
}
