import crypto from "crypto";
import { Queue, Worker, Job } from "bullmq";
import { ActorRole, CaseState, Channel, EventType, IdentifierType } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { createBullConnection, redis } from "../lib/redis";
import { normalizePhone } from "../lib/crypto";
import { findClinicById, findStudyByCode, STUDIES_CATALOG, CLINICS_CATALOG } from "../data/catalog";
import {
  findPatientByIdentifier,
  issueOtpChallenge,
  resolveOrCreatePatient,
  verifyOtpChallenge,
} from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";

export interface WhatsAppInboundJob {
  wamid: string;
  fromPhone: string;
  /** Numero exacto tal como lo envio Meta (ej. 521667... en Mexico) para evitar error #131030 */
  metaRawFrom?: string;
  text: string;
  source: "meta" | "simulator";
  correlationId: string;
  receivedAt: string;
}

export interface ChatBubble {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  timestamp: string;
  correlationId: string;
}

const CHAT_HISTORY_KEY = (phone: string) => `sim:wa:chat:${normalizePhone(phone)}`;

// Hash-tag "{bull}" requerido oficialmente por BullMQ para compatibilidad total
// tanto en Redis standalone (Docker local) como en AWS ElastiCache Valkey Cluster Mode.
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
 * Envia respuesta real a Meta WhatsApp Cloud API si hay credenciales configuradas
 * y el mensaje entro por el webhook oficial.
 */
async function sendMetaWhatsAppText(toPhone: string, text: string): Promise<void> {
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`[WhatsApp Meta Dry-Run] Para ${toPhone}: ${text}`);
    return;
  }

  const toDigits = toPhone.replace(/\D/g, "");
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const sendTo = async (digits: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: digits,
        type: "text",
        text: { body: text },
      }),
    });

  let res = await sendTo(toDigits);
  if (!res.ok) {
    const errText = await res.text();
    // Compatibilidad Mexico Meta Cloud API: reintentar sin el "1" tras 52 si devuelve #131030
    if (errText.includes("131030") && toDigits.startsWith("521") && toDigits.length === 13) {
      res = await sendTo(`52${toDigits.slice(3)}`);
      if (res.ok) return;
      const retryErr = await res.text();
      throw new Error(`Meta Graph API error (${res.status}): ${retryErr}`);
    }
    throw new Error(`Meta Graph API error (${res.status}): ${errText}`);
  }
}

async function replyToPatient(job: WhatsAppInboundJob, replyText: string) {
  await appendChatBubble(job.fromPhone, {
    id: crypto.randomUUID(),
    direction: "outbound",
    text: replyText,
    timestamp: new Date().toISOString(),
    correlationId: job.correlationId,
  });

  if (job.source === "meta") {
    await sendMetaWhatsAppText(job.metaRawFrom ?? job.fromPhone, replyText);
  }
}

/**
 * Motor deterministico del Canal WhatsApp (CERO Bot-Bot / CERO LLM bloqueante).
 * Interpreta comandos claros, codigos OTP de 6 digitos y dudas del paciente
 * actualizando directamente la Maquina de Estados en PostgreSQL 16.
 */
export async function processWhatsAppInbound(jobData: WhatsAppInboundJob): Promise<{ reply: string }> {
  const phone = normalizePhone(jobData.fromPhone);
  const text = jobData.text.trim();
  const correlationId = jobData.correlationId;

  await appendChatBubble(phone, {
    id: jobData.wamid,
    direction: "inbound",
    text,
    timestamp: jobData.receivedAt,
    correlationId,
  });

  // 1. Resolver o crear paciente por telefono (Identity Resolution)
  let patient = await findPatientByIdentifier(IdentifierType.PHONE, phone);
  if (!patient) {
    patient = await resolveOrCreatePatient({ phone });
  }

  // 2. Buscar tramite activo mas reciente del paciente
  let activeCase = await prisma.serviceCase.findFirst({
    where: {
      patientId: patient.id,
      currentState: { not: CaseState.CITA_CONFIRMADA },
    },
    orderBy: { updatedAt: "desc" },
  });

  // Si no tiene tramite pendiente, revisamos si tiene una cita ya confirmada o iniciamos uno nuevo
  if (!activeCase) {
    const confirmed = await prisma.serviceCase.findFirst({
      where: { patientId: patient.id, currentState: CaseState.CITA_CONFIRMADA },
      orderBy: { updatedAt: "desc" },
    });

    if (confirmed && /cita|folio|estado|status/i.test(text)) {
      const ctx = (confirmed.contextJson ?? {}) as CaseContextJson;
      const reply = `Tu cita ya está confirmada (${ctx.appointment_folio ?? "Folio activo"}) para ${ctx.study?.name ?? "tu estudio"} en ${ctx.clinic?.name ?? "clínica asignada"}.`;
      await replyToPatient(jobData, reply);
      return { reply };
    }

    // Crear nuevo caso iniciado directamente en WhatsApp (soporta salto inverso WA -> Web)
    activeCase = await prisma.serviceCase.create({
      data: {
        patientId: patient.id,
        currentState: CaseState.INICIADO,
        currentChannel: Channel.WHATSAPP,
        contextJson: { otp_verified_channels: ["WHATSAPP"] },
      },
    });

    await recordAndPublishEvent({
      caseId: activeCase.id,
      patientId: patient.id,
      journeyId: activeCase.journeyId,
      correlationId,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.SESSION_STARTED,
      prevState: null,
      nextState: CaseState.INICIADO,
      payload: { source: jobData.source },
    });

    // Si el mensaje ya menciona un estudio del catalogo, cotizamos de inmediato
    const matchedStudy = STUDIES_CATALOG.find(
      (s) =>
        text.toLowerCase().includes(s.code.toLowerCase()) ||
        text.toLowerCase().includes(s.name.toLowerCase().split(" ")[0])
    );

    if (matchedStudy) {
      const { updatedCase } = await transitionServiceCase({
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
      activeCase = updatedCase;
      const reply = `¡Hola! Cotizamos ${matchedStudy.name} ($${matchedStudy.price} MXN). ¿En qué clínica te gustaría agendar? (Ej: Culiacán, Guadalajara, CDMX o Monterrey). También puedes continuar en el Sitio Web sin perder este avance.`;
      await replyToPatient(jobData, reply);
      return { reply };
    }

    const reply =
      "¡Hola! Bienvenido a Salud Digna Omnicanal. No encontramos trámites pendientes. Escribe el estudio que deseas cotizar (ej: 'Ultrasonido', 'Biometría', 'Química') para comenzar.";
    await replyToPatient(jobData, reply);
    return { reply };
  }

  const ctx = (activeCase.contextJson ?? {}) as CaseContextJson;
  const verifiedChannels = ctx.otp_verified_channels ?? [];
  const cameFromOtherChannel = activeCase.currentChannel !== Channel.WHATSAPP;
  const needsStepUpOtp =
    !verifiedChannels.includes("WHATSAPP") &&
    (cameFromOtherChannel || activeCase.currentState === CaseState.PAUSADO_PENDIENTE);

  // 3. Flujo de Seguridad Step-Up OTP cuando cambia de canal (Web -> WhatsApp)
  const otpMatch = text.match(/^\d{6}$/);

  if (needsStepUpOtp) {
    if (otpMatch) {
      const verification = await verifyOtpChallenge({
        patientId: patient.id,
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

      // OTP valido -> Rehidratar contexto y pasar a EN_PROGRESO
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
        eventPayload: { recoveredFromState: activeCase.currentState },
      });

      const reCtx = (updatedCase.contextJson ?? {}) as CaseContextJson;
      const firstName = patient.firstName ?? "Paciente";
      const reply =
        `✅ Identidad verificada, ${firstName}. Retomamos tu trámite exactamente donde lo dejaste:\n` +
        `• Estudio: ${reCtx.study?.name ?? "Por definir"} ($${reCtx.study?.price ?? "--"} MXN)\n` +
        `• Clínica: ${reCtx.clinic?.name ?? "Por elegir"}\n` +
        `Puedes escribir tu duda (ej: "¿Requiero ayuno?"), indicar un horario o responder "CONFIRMAR" para agendar.`;

      await replyToPatient(jobData, reply);
      return { reply };
    }

    // Primera vez que llega desde otro canal -> registrar CHANNEL_SWITCH_DETECTED y emitir OTP en Consola 2FA externa
    await recordAndPublishEvent({
      caseId: activeCase.id,
      patientId: patient.id,
      journeyId: activeCase.journeyId,
      correlationId,
      channel: Channel.WHATSAPP,
      actorRole: ActorRole.SYSTEM,
      eventType: EventType.CHANNEL_SWITCH_DETECTED,
      payload: { fromChannel: activeCase.currentChannel, toChannel: Channel.WHATSAPP },
    });

    await issueOtpChallenge({
      patient,
      caseId: activeCase.id,
      journeyId: activeCase.journeyId,
      channel: Channel.WHATSAPP,
      correlationId,
    });

    const reply =
      "🔐 Detectamos un trámite pendiente iniciado en otro canal. Por tu privacidad clínica, enviamos un código de verificación de 6 dígitos a tu segundo factor (Consola 2FA / SMS). Respóndeme con ese código para continuar donde te quedaste.";
    await replyToPatient(jobData, reply);
    return { reply };
  }

  // 4. Ya autenticado en WhatsApp: procesar seleccion de clinica, confirmacion o duda
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

    const reply = `Perfecto, guardamos ${matchedClinic.name}. ¿Tienes alguna duda sobre preparación o deseas confirmar tu cita?`;
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

    const reply = `🎉 ¡Listo! Tu cita quedó confirmada con folio ${folio}. Preparación: ${ctx.study?.prep ?? "Presentarse 15 min antes."}`;
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
    `${prepAnswer}📝 Registramos tu consulta en tu expediente activo. Si prefieres llamar a nuestro Call Center, el asesor ya tendrá tu estudio, clínica y esta duda en pantalla sin que repitas nada.`;

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
