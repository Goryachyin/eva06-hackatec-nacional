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
  formatLidIdentifier,
  issueOtpChallenge,
  resolveOrCreatePatient,
  verifyOtpChallenge,
} from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";
import { runSmartWhatsAppAssistant } from "../core/aiAssistant";

export interface WhatsAppInboundJob {
  messageId: string;
  fromPhone: string;
  /** JID de Baileys (ej. 5217443116876@s.whatsapp.net o ...@lid) para responder al chat exacto */
  remoteJid?: string;
  whatsappLid?: string;
  isUnresolvedLid?: boolean;
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

function normalizeForMatch(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function findStudyInText(text: string) {
  const norm = normalizeForMatch(text);
  if (!norm) return undefined;
  return STUDIES_CATALOG.find((s) => {
    const codeNorm = normalizeForMatch(s.code);
    const nameNorm = normalizeForMatch(s.name);
    const catNorm = normalizeForMatch(s.category);
    const firstWord = nameNorm.split(/\s+/)[0] || "";
    const firstTwo = nameNorm.split(/\s+/).slice(0, 2).join(" ");
    return (
      norm.includes(codeNorm) ||
      (firstTwo.length >= 5 && norm.includes(firstTwo)) ||
      (firstWord.length >= 4 && norm.includes(firstWord)) ||
      norm.includes(catNorm)
    );
  });
}

function findClinicInText(text: string) {
  const norm = normalizeForMatch(text);
  if (!norm) return undefined;
  return CLINICS_CATALOG.find((c) => {
    const idNorm = normalizeForMatch(c.id);
    const nameNorm = normalizeForMatch(c.name);
    const cityNorm = normalizeForMatch(c.city.split(",")[0] || "");
    const branchKeyword = nameNorm.replace(/^clinica\s+/i, "").trim();
    return (
      norm.includes(idNorm) ||
      (cityNorm.length >= 3 && norm.includes(cityNorm)) ||
      (branchKeyword.length >= 4 && norm.includes(branchKeyword)) ||
      (c.id === "CDMX-01" && /\b(cdmx|ciudad de mexico|lindavista)\b/.test(norm))
    );
  });
}

/**
 * Motor deterministico del Canal WhatsApp (CERO Bot-Bot / CERO Meta Cloud API).
 * Soporta:
 *  - Multibeneficiario (Titular + Familiares/Conocidos con menu numerado y privacidad)
 *  - Step-Up OTP en saltos de canal y citas de terceros
 *  - N-saltos bidireccionales Web <-> WhatsApp <-> Call Center
 */
export async function processWhatsAppInbound(jobData: WhatsAppInboundJob): Promise<{ reply: string }> {
  const isUnresolvedLid = Boolean(jobData.isUnresolvedLid);
  const phone = isUnresolvedLid ? jobData.fromPhone : normalizePhone(jobData.fromPhone);
  const text = jobData.text.trim();
  const correlationId = jobData.correlationId;

  await appendChatBubble(phone, {
    id: jobData.messageId,
    direction: "inbound",
    text,
    timestamp: jobData.receivedAt,
    correlationId,
  });

  // 1. Resolver o vincular inteligentemente al Titular propietario (soporta telefono real y @lid)
  let holder = isUnresolvedLid
    ? await findPatientByIdentifier(
        IdentifierType.APP,
        formatLidIdentifier(jobData.whatsappLid || jobData.fromPhone)
      )
    : null;

  if (!holder) {
    holder = isUnresolvedLid
      ? await resolveOrCreatePatient({
          whatsappLid: jobData.whatsappLid || jobData.fromPhone,
        })
      : await resolveOrCreatePatient({
          phone,
          ...(jobData.whatsappLid ? { whatsappLid: jobData.whatsappLid } : {}),
        });
  }

  // 2. Obtener TODOS los tramites abiertos (excluyendo los anulados explícitamente por el paciente)
  const rawOpenCases = await prisma.serviceCase.findMany({
    where: {
      OR: [{ requesterPatientId: holder.id }, { patientId: holder.id }],
      currentState: { not: CaseState.CITA_CONFIRMADA },
    },
    include: {
      patient: { select: { id: true, firstName: true, paternalLastName: true, phone: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 15,
  });

  const openCases = rawOpenCases.filter((c) => {
    const cCtx = (c.contextJson ?? {}) as CaseContextJson;
    return !cCtx.cancelled;
  });

  // Menú rápido de acceso directo (funciona en cualquier momento vía chat)
  const wantsQuickMenu = /^(0|menu|men[uú]|opciones|ayuda)$/i.test(text);
  if (wantsQuickMenu) {
    const reply = BOT_TEMPLATES.welcomeMenu();
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // Comando explicito "NUEVO" / "NUEVA CITA" para abrir una nueva cotizacion
  const wantsNewCase =
    /^(nuevo|nueva)(\s+(estudio|cita|tr[aá]mite))?$/i.test(text) ||
    /\b(nueva\s+cita|otra\s+cita|agendar\s+otra|registrar\s+otra|quiero\s+otra\s+cita)\b/i.test(text);

  // Comando explicito "CAMBIAR" / "MIS CITAS" para listar tramites familiares/propios
  const wantsMenu = /^(cambiar|mis citas|tramites|tr[aá]mites)$/i.test(text);

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

  // Seleccionar caso activo (si hay un trámite incompleto y pide una NUEVA cita, lo pasamos al asistente
  // para que pregunte si desea guardarlo o anularlo antes de generar el nuevo).
  let selectedCaseId = await redis.get(SELECTED_CASE_KEY(phone));
  let activeCase =
    openCases.find((c) => c.id === selectedCaseId) ??
    (openCases.length === 1 ? openCases[0] : undefined);

  if (wantsNewCase && activeCase) {
    const activeCtx = (activeCase.contextJson ?? {}) as CaseContextJson;
    const hasProgress = Boolean(
      activeCtx.study || activeCtx.clinic || activeCtx.preferred_slot || activeCase.currentState !== CaseState.INICIADO
    );
    // Si el caso abierto no tenía avance real ni OpenAI activo, creamos uno limpio; si sí tenía avance,
    // el asistente preguntará (a) Guardar y retomar luego vs (b) Anular y crear nueva.
    if (!hasProgress && !env.OPENAI_API_KEY) {
      activeCase = undefined;
    }
  }

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

  // Si no tiene tramite abierto (por ej. ya completó su cita anterior o es usuario nuevo):
  if (!activeCase) {
    const wantsOnlyStatusCheck =
      !wantsNewCase &&
      (/^(2)$/i.test(text) ||
        (/\b(mi\s+folio|ver\s+mis?\s+citas?|consultar\s+mis?\s+citas?|estatus|status|estado\s+de\s+mi\s+cita|folios?)\b/i.test(
          text
        ) &&
          !/\b(nueva|otra|otro|agendar|reservar|registrar|cotizar|editar|modificar|cambiar|reagendar)\b/i.test(
            text
          )));

    const wantsEditConfirmed =
      !wantsNewCase &&
      (/^(3)$/i.test(text) ||
        /\b(editar|modificar|reagendar|cambiar\s+(mi\s+)?(cita|hora|horario|fecha|cl[ií]nica|estudio|pago))\b/i.test(
          text
        ));

    if (wantsOnlyStatusCheck) {
      const confirmedList = await prisma.serviceCase.findMany({
        where: {
          OR: [{ requesterPatientId: holder.id }, { patientId: holder.id }],
          currentState: CaseState.CITA_CONFIRMADA,
        },
        include: {
          patient: { select: { firstName: true, paternalLastName: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });
      if (confirmedList.length > 0) {
        const blocks = confirmedList.map((c) => {
          const ctx = (c.contextJson ?? {}) as CaseContextJson;
          const who = maskPatientName(c.patient.firstName, c.patient.paternalLastName);
          const slotTxt = ctx.preferred_slot
            ? `${ctx.preferred_slot.date} a las ${ctx.preferred_slot.time}`
            : "Horario por confirmar";
          return (
            `✅ *Folio ${ctx.appointment_folio ?? "Activo"}* (${who}):\n` +
            `• Estudio: ${ctx.study?.name ?? "Estudio"}\n` +
            `• Clínica: ${ctx.clinic?.name ?? "Clínica asignada"}\n` +
            `• Horario: ${slotTxt}`
          );
        });
        const reply =
          `${blocks.join("\n\n")}\n\n` +
          `¿Qué deseas hacer ahora?\n` +
          `• Escribe *1* o *NUEVA CITA* para agendar otro estudio.\n` +
          `• Escribe *3* o *EDITAR CITA* si quieres modificar fecha, horario, clínica o estudio.\n` +
          `• Escribe *MENÚ* para ver todas las opciones rápidas.`;
        await replyToPatient(jobData, reply);
        return { reply };
      }
    }

    // Si quiere editar/reagendar una cita ya confirmada, operar directamente sobre ella sin abrir un borrador vacío
    if (wantsEditConfirmed) {
      const latestConfirmed = await prisma.serviceCase.findFirst({
        where: {
          OR: [{ requesterPatientId: holder.id }, { patientId: holder.id }],
          currentState: CaseState.CITA_CONFIRMADA,
        },
        include: {
          patient: { select: { id: true, firstName: true, paternalLastName: true, phone: true } },
        },
        orderBy: { updatedAt: "desc" },
      });

      if (latestConfirmed && env.OPENAI_API_KEY) {
        const history = await getSimulatedChatHistory(phone);
        const aiRes = await runSmartWhatsAppAssistant({
          serviceCase: latestConfirmed,
          holder,
          patientFirstName: latestConfirmed.patient.firstName,
          isThirdParty: latestConfirmed.patientId !== holder.id,
          relationshipLabel: latestConfirmed.relationshipLabel || "Titular",
          history,
          userText: text,
          correlationId,
          whatsappLid: jobData.whatsappLid,
          isUnresolvedLid,
        });
        if (aiRes) {
          if (aiRes.switchedCaseId && !aiRes.confirmed) {
            await redis.set(SELECTED_CASE_KEY(phone), aiRes.switchedCaseId, "EX", 1800);
          }
          await replyToPatient(jobData, aiRes.reply);
          return { reply: aiRes.reply };
        }
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

    // Si OpenAI está habilitado, procesamos incluso el primer turno con Function Calling NLU
    if (env.OPENAI_API_KEY) {
      const history = await getSimulatedChatHistory(phone);
      const aiRes = await runSmartWhatsAppAssistant({
        serviceCase: activeCase,
        holder,
        patientFirstName: holder.firstName,
        isThirdParty: false,
        relationshipLabel: "Titular",
        history,
        userText: text,
        correlationId,
        whatsappLid: jobData.whatsappLid,
        isUnresolvedLid,
      });
      if (aiRes) {
        if (aiRes.confirmed) {
          await redis.del(SELECTED_CASE_KEY(phone));
        } else if (aiRes.switchedCaseId) {
          await redis.set(SELECTED_CASE_KEY(phone), aiRes.switchedCaseId, "EX", 1800);
        }
        await replyToPatient(jobData, aiRes.reply);
        return { reply: aiRes.reply };
      }
    }

    const matchedStudy = findStudyInText(text);

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

    if (/^4$|servicio|estudio|cat[aá]logo|precio|cotizar/i.test(text)) {
      const reply = BOT_TEMPLATES.studiesCatalog();
      await replyToPatient(jobData, reply);
      return { reply };
    }

    if (/^1$/i.test(text)) {
      const reply = BOT_TEMPLATES.studiesCatalog();
      await replyToPatient(jobData, reply);
      return { reply };
    }

    if (/cl[ií]nica|sucursal|horario|direcci[oó]n|ubicaci[oó]n/i.test(text)) {
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

  // 4. Canal autenticado (después de validar Menú Familiar y Step-Up OTP):
  //    Si OPENAI_API_KEY está configurada, delegamos comprensión + Function Calling al plugin IA
  //    con fallback automático e invisible al motor determinístico si hay error o timeout.
  if (env.OPENAI_API_KEY) {
    const history = await getSimulatedChatHistory(phone);
    const aiRes = await runSmartWhatsAppAssistant({
      serviceCase: activeCase,
      holder,
      patientFirstName: activeCase.patient.firstName,
      isThirdParty,
      relationshipLabel: activeCase.relationshipLabel || (isThirdParty ? "Familiar" : "Titular"),
      history,
      userText: text,
      correlationId,
      whatsappLid: jobData.whatsappLid,
      isUnresolvedLid,
    });
    if (aiRes) {
      if (aiRes.confirmed) {
        await redis.del(SELECTED_CASE_KEY(phone));
      } else if (aiRes.switchedCaseId) {
        await redis.set(SELECTED_CASE_KEY(phone), aiRes.switchedCaseId, "EX", 1800);
      }
      await replyToPatient(jobData, aiRes.reply);
      return { reply: aiRes.reply };
    }
  }

  // Fallback determinístico (si no hay OPENAI_API_KEY o si OpenAI falló/timeout):
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

  if (/^6$|asesor|call\s*center|humano|operador|llamada/i.test(text)) {
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

  const matchedStudyExisting = !ctx.study ? findStudyInText(text) : undefined;

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

  const matchedClinic = findClinicInText(text);

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

  if (/\b(confirmar|confirmo|agendar|agendo|reservar|reservo)\b/i.test(text) && ctx.study && ctx.clinic) {
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
