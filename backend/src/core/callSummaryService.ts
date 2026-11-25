import crypto from "crypto";
import { env } from "../config/env";
import {
  CLINICS_CATALOG,
  findClinicById,
  findStudyByCode,
  STUDIES_CATALOG,
} from "../data/catalog";
import { CallSummaryRecord, CaseContextJson } from "./stateMachine";

/**
 * Sanitiza fragmentos sensibles (CURP 18 caracteres, OTP 6 dígitos y tarjetas 16 dígitos)
 * antes de enviar transcripciones de llamadas a OpenAI o guardarlas en el expediente (LFPDPPP).
 */
export function scrubCallTranscriptPii(text: string): string {
  return text
    .replace(/\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi, "[CURP_PROTEGIDA]")
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[TARJETA_PROTEGIDA]")
    .replace(/\b\d{6}\b/g, "[CODIGO_PROTEGIDO]");
}

function getExtensionFromMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("ogg")) return "ogg";
  return "webm";
}

async function callOpenAiTranscription(
  audioBuffer: Buffer,
  mimeType: string,
  model: string
): Promise<string> {
  const ext = getExtensionFromMime(mimeType);
  const cleanMime = mimeType.split(";")[0].trim() || "audio/webm";
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: cleanMime });
  const form = new FormData();
  form.append("file", blob, `call.${ext}`);
  form.append("model", model);
  form.append("language", "es");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: form,
    signal: AbortSignal.timeout(env.OPENAI_CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI STT (${model}) HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as { text?: string };
  return (data.text || "").trim();
}

async function transcribeAudioBuffer(audioBuffer: Buffer, mimeType: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no configurada para transcripción de audio.");
  }
  try {
    return await callOpenAiTranscription(audioBuffer, mimeType, env.OPENAI_STT_MODEL);
  } catch (err) {
    // Respaldo automático a whisper-1 si el modelo configurado no está disponible o rechaza el contenedor
    if (env.OPENAI_STT_MODEL !== "whisper-1") {
      console.warn(
        `[CallSummary] Reintentando STT con whisper-1 tras fallo de ${env.OPENAI_STT_MODEL}:`,
        err instanceof Error ? err.message : String(err)
      );
      return await callOpenAiTranscription(audioBuffer, mimeType, "whisper-1");
    }
    throw err;
  }
}

interface AiStructuredSummary {
  summary?: string;
  patientSafeSummary?: string;
  patientIntent?: string;
  agreements?: string[];
  pendingActions?: string[];
  openQuestions?: string[];
  sentiment?: string;
  extractedEntities?: {
    studyCode?: string | null;
    clinicId?: string | null;
    preferredDate?: string | null;
    preferredTime?: string | null;
    paymentMethod?: string | null;
  };
}

function buildDeterministicFallback(params: {
  sanitizedTranscript: string;
  currentCtx: CaseContextJson;
}): AiStructuredSummary {
  const lower = params.sanitizedTranscript.toLowerCase();
  const matchedStudy = STUDIES_CATALOG.find(
    (s) =>
      lower.includes(s.code.toLowerCase()) ||
      lower.includes(s.name.toLowerCase()) ||
      lower.includes(s.name.toLowerCase().split(" ")[0])
  );
  const matchedClinic = CLINICS_CATALOG.find(
    (c) =>
      lower.includes(c.id.toLowerCase()) ||
      lower.includes(c.city.toLowerCase().split(",")[0])
  );
  let paymentMethod: "online" | "oxxo" | "clinic" | undefined;
  if (/en l[ií]nea|tarjeta|descuento/i.test(lower)) paymentMethod = "online";
  else if (/oxxo/i.test(lower)) paymentMethod = "oxxo";
  else if (/cl[ií]nica|efectivo|recepci[oó]n/i.test(lower)) paymentMethod = "clinic";

  const timeMatch = /\b(07:30|08:30|09:30|10:30|11:30|13:00|16:00)\b/.exec(
    params.sanitizedTranscript
  );
  const dateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(params.sanitizedTranscript);

  const shortSnippet =
    params.sanitizedTranscript.length > 220
      ? `${params.sanitizedTranscript.slice(0, 220).trim()}...`
      : params.sanitizedTranscript;

  return {
    summary: shortSnippet
      ? `Llamada atendida en Call Center: ${shortSnippet}`
      : "Llamada atendida en Call Center y registrada en el expediente omnicanal.",
    patientSafeSummary:
      "Atención telefónica registrada con un asesor de Call Center; tu avance quedó sincronizado en tu expediente.",
    patientIntent: "Seguimiento y aclaración de dudas sobre cita médica",
    agreements: [
      ...(matchedStudy ? [`Estudio mencionado: ${matchedStudy.name}`] : []),
      ...(matchedClinic ? [`Clínica mencionada: ${matchedClinic.name}`] : []),
    ],
    pendingActions: params.currentCtx.appointment_folio
      ? ["Acudir a clínica con folio y preparación indicada"]
      : ["Confirmar datos finales y emitir folio de cita"],
    openQuestions: /\?/.test(params.sanitizedTranscript)
      ? ["Consulta atendida durante llamada con Call Center"]
      : [],
    sentiment: "neutral",
    extractedEntities: {
      studyCode: matchedStudy?.code ?? null,
      clinicId: matchedClinic?.id ?? null,
      preferredDate: dateMatch?.[1] ?? null,
      preferredTime: timeMatch?.[1] ?? null,
      paymentMethod: paymentMethod ?? null,
    },
  };
}

async function summarizeWithOpenAi(params: {
  sanitizedTranscript: string;
  currentCtx: CaseContextJson;
}): Promise<AiStructuredSummary | null> {
  if (!env.OPENAI_API_KEY) return null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const studiesList = STUDIES_CATALOG.map(
    (s) => `- ${s.code}: ${s.name} (${s.category}, $${s.price} MXN)`
  ).join("\n");
  const clinicsList = CLINICS_CATALOG.map(
    (c) => `- ${c.id}: ${c.name} (${c.city})`
  ).join("\n");

  const systemPrompt = [
    "Eres un analista clínico-operativo de Salud Digna. Analiza la transcripción de una llamada entre un paciente y un asesor de Call Center y genera un objeto JSON estricto para enriquecer el contexto omnicanal (Call Center, WhatsApp y Web).",
    "REGLAS ESTRICTAS:",
    "1. Responde ÚNICAMENTE con un objeto JSON válido con estas llaves exactas: summary, patientSafeSummary, patientIntent, agreements, pendingActions, openQuestions, sentiment, extractedEntities.",
    "2. `summary`: resumen ejecutivo de 2 a 3 frases claras en español de México.",
    "3. `patientSafeSummary`: 1 o 2 frases breves y amables aptas para mostrarse al paciente en Mi Cuenta (sin notas internas ni etiquetas de sentimiento).",
    "4. `agreements`, `pendingActions`, `openQuestions`: arreglos de strings concisos (máximo 4 elementos cada uno).",
    "5. `sentiment`: exactamente uno de: positivo, neutral, preocupado, urgente.",
    "6. `extractedEntities`: { studyCode, clinicId, preferredDate, preferredTime, paymentMethod }. SOLO usa códigos exactos del catálogo oficial abajo (o null si no se mencionó). `paymentMethod` solo puede ser 'online', 'oxxo', 'clinic' o null. `preferredDate` en YYYY-MM-DD (fecha actual: " +
      todayIso +
      ") y `preferredTime` en HH:MM.",
    "7. Jamás inventes datos ni incluyas CURPs, contraseñas o tarjetas.",
    "",
    "CONTEXTO PREVIO DEL TRÁMITE:",
    `- Estudio previo: ${params.currentCtx.study?.name ?? "Ninguno"}`,
    `- Clínica previa: ${params.currentCtx.clinic?.name ?? "Ninguna"}`,
    `- Horario previo: ${
      params.currentCtx.preferred_slot
        ? `${params.currentCtx.preferred_slot.date} ${params.currentCtx.preferred_slot.time}`
        : "Sin definir"
    }`,
    "",
    "CATÁLOGO OFICIAL DE ESTUDIOS:",
    studiesList,
    "",
    "CATÁLOGO OFICIAL DE CLÍNICAS:",
    clinicsList,
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      temperature: 0.15,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `TRANSCRIPCIÓN DE LA LLAMADA:\n${params.sanitizedTranscript}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(env.OPENAI_CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Summary HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return null;
  return JSON.parse(content) as AiStructuredSummary;
}

export async function processCallAudioAndSummarize(params: {
  callId?: string;
  advisorName: string;
  source: "webrtc_call" | "audio_upload" | "transcript_text";
  audioBase64?: string;
  mimeType?: string;
  transcriptText?: string;
  durationSeconds?: number;
  currentCtx: CaseContextJson;
}): Promise<CallSummaryRecord> {
  let rawTranscript = (params.transcriptText || "").trim();
  let aiProcessed = false;

  if (!rawTranscript && params.audioBase64) {
    const base64Clean = params.audioBase64.includes(",")
      ? params.audioBase64.split(",").pop() || ""
      : params.audioBase64;
    const audioBuffer = Buffer.from(base64Clean, "base64");
    if (audioBuffer.length < 100) {
      throw new Error("El archivo de audio recibido está vacío o es demasiado corto.");
    }
    try {
      rawTranscript = await transcribeAudioBuffer(audioBuffer, params.mimeType || "audio/webm");
      aiProcessed = true;
    } catch (err) {
      console.warn(
        "[CallSummary] No se pudo transcribir audio con OpenAI; usando respaldo:",
        err instanceof Error ? err.message : String(err)
      );
      rawTranscript =
        "Llamada de voz atendida en Call Center (transcripción automática no disponible en este intento).";
    }
  }

  if (!rawTranscript) {
    throw new Error("Se requiere audio o texto de transcripción para procesar la llamada.");
  }

  const sanitizedTranscript = scrubCallTranscriptPii(rawTranscript);

  let structured: AiStructuredSummary | null = null;
  try {
    structured = await summarizeWithOpenAi({
      sanitizedTranscript,
      currentCtx: params.currentCtx,
    });
    if (structured) aiProcessed = true;
  } catch (err) {
    console.warn(
      "[CallSummary] Fallback determinístico al resumir llamada:",
      err instanceof Error ? err.message : String(err)
    );
  }

  const resolved =
    structured ??
    buildDeterministicFallback({
      sanitizedTranscript,
      currentCtx: params.currentCtx,
    });

  // Validar entidades extraídas estrictamente contra el catálogo oficial
  const validStudy = resolved.extractedEntities?.studyCode
    ? findStudyByCode(String(resolved.extractedEntities.studyCode))
    : undefined;
  const validClinic = resolved.extractedEntities?.clinicId
    ? findClinicById(String(resolved.extractedEntities.clinicId))
    : undefined;
  const rawPayment = resolved.extractedEntities?.paymentMethod;
  const validPayment: "online" | "oxxo" | "clinic" | undefined =
    rawPayment === "online" || rawPayment === "oxxo" || rawPayment === "clinic"
      ? rawPayment
      : undefined;
  const rawDate = resolved.extractedEntities?.preferredDate || undefined;
  const validDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  const rawTime = resolved.extractedEntities?.preferredTime || undefined;
  const validTime = rawTime && /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : undefined;

  const rawSentiment = resolved.sentiment;
  const sentiment: CallSummaryRecord["sentiment"] =
    rawSentiment === "positivo" ||
    rawSentiment === "neutral" ||
    rawSentiment === "preocupado" ||
    rawSentiment === "urgente"
      ? rawSentiment
      : "neutral";

  const normalizeArray = (val: unknown): string[] =>
    Array.isArray(val)
      ? val
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

  return {
    id: crypto.randomUUID(),
    callId: params.callId,
    createdAt: new Date().toISOString(),
    durationSeconds: params.durationSeconds,
    advisorName: params.advisorName,
    source: params.source,
    summary:
      (resolved.summary || "").trim() ||
      "Llamada atendida en Call Center y sincronizada en el expediente.",
    patientSafeSummary:
      (resolved.patientSafeSummary || "").trim() ||
      "Atención telefónica completada con un asesor de Salud Digna; tu trámite se encuentra actualizado.",
    patientIntent: (resolved.patientIntent || "").trim() || "Atención telefónica de seguimiento",
    agreements: normalizeArray(resolved.agreements),
    pendingActions: normalizeArray(resolved.pendingActions),
    openQuestions: normalizeArray(resolved.openQuestions),
    sentiment,
    extractedEntities: {
      ...(validStudy ? { studyCode: validStudy.code } : {}),
      ...(validClinic ? { clinicId: validClinic.id } : {}),
      ...(validDate ? { preferredDate: validDate } : {}),
      ...(validTime ? { preferredTime: validTime } : {}),
      ...(validPayment ? { paymentMethod: validPayment } : {}),
    },
    transcriptPreview:
      sanitizedTranscript.length > 600
        ? `${sanitizedTranscript.slice(0, 600).trim()}...`
        : sanitizedTranscript,
    aiProcessed,
  };
}
