import crypto from "crypto";
import { ActorRole, CaseState, Channel, EventType, ServiceCase } from "@prisma/client";
import { env } from "../config/env";
import {
  CLINICS_CATALOG,
  findClinicById,
  findStudyByCode,
  STUDIES_CATALOG,
} from "../data/catalog";
import { CaseContextJson, transitionServiceCase } from "./stateMachine";

export interface SimpleChatMessage {
  direction: "inbound" | "outbound";
  text: string;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: OpenAiMessage;
  }>;
}

/**
 * Sanitiza posibles fragmentos sensibles (CURP de 18 caracteres o codigos OTP de 6 digitos)
 * antes de enviar historial conversacional al proveedor de IA externo (privacidad LFPDPPP).
 */
function scrubPotentialPii(text: string): string {
  return text
    .replace(/\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi, "[CURP_OCULTA]")
    .replace(/\b\d{6}\b/g, "[CODIGO_OCULTO]");
}

const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "quote_study",
      description:
        "Cotiza y guarda un estudio oficial del catálogo de Salud Digna en el trámite activo del paciente.",
      parameters: {
        type: "object",
        properties: {
          studyCode: {
            type: "string",
            enum: STUDIES_CATALOG.map((s) => s.code),
            description: "Código exacto del estudio del catálogo oficial.",
          },
        },
        required: ["studyCode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_clinic",
      description:
        "Guarda la clínica Salud Digna seleccionada y opcionalmente la fecha y hora preferida del paciente.",
      parameters: {
        type: "object",
        properties: {
          clinicId: {
            type: "string",
            enum: CLINICS_CATALOG.map((c) => c.id),
            description: "ID exacto de la clínica oficial.",
          },
          preferredDate: {
            type: "string",
            description: "Fecha deseada en formato YYYY-MM-DD (opcional).",
          },
          preferredTime: {
            type: "string",
            description: "Hora deseada en formato HH:MM, ej. 09:30 (opcional).",
          },
        },
        required: ["clinicId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_question_or_escalate",
      description:
        "Registra una duda clínica/operativa o solicita transferencia a un asesor de Call Center para que aparezca en el Screen-Pop.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Resumen breve de la duda o motivo de atención.",
          },
          requestAdvisor: {
            type: "boolean",
            description: "True si el paciente pide hablar con un asesor humano o Call Center.",
          },
        },
        required: ["question", "requestAdvisor"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_appointment",
      description:
        "Confirma oficialmente la cita generando folio y código QR. Solo usar cuando el paciente confirma explícitamente y ya existe estudio y clínica seleccionados.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

async function callOpenAi(messages: OpenAiMessage[], allowTools: boolean): Promise<OpenAiMessage> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      temperature: 0.25,
      max_tokens: 420,
      messages,
      ...(allowTools ? { tools: ORCHESTRATOR_TOOLS, tool_choice: "auto" } : {}),
    }),
    signal: AbortSignal.timeout(env.OPENAI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as OpenAiChatResponse;
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("OpenAI devolvió respuesta vacía.");
  return msg;
}

/**
 * Plugin inteligente de conversación (OpenAI Function Calling) controlado estrictamente
 * por la Máquina de Estados Determinística.
 *
 * - Si OPENAI_API_KEY no está configurada o ocurre un error/timeout, devuelve `null`
 *   para activar automáticamente el fallback determinístico sin pérdida de disponibilidad.
 */
export async function runSmartWhatsAppAssistant(params: {
  serviceCase: ServiceCase;
  patientFirstName?: string | null;
  isThirdParty: boolean;
  relationshipLabel: string;
  history: SimpleChatMessage[];
  userText: string;
  correlationId: string;
}): Promise<{ reply: string; updatedCase: ServiceCase; confirmed: boolean } | null> {
  if (!env.OPENAI_API_KEY) {
    return null;
  }

  let currentCase = params.serviceCase;
  let confirmed = false;

  const catalogText = STUDIES_CATALOG.map(
    (s) =>
      `- ${s.code}: ${s.name} (${s.category}) | Precio: $${s.price} MXN (10% desc. en línea: $${Math.round(
        s.price * 0.9
      )} MXN) | Prep: ${s.prep}`
  ).join("\n");

  const clinicsText = CLINICS_CATALOG.map(
    (c) => `- ${c.id}: ${c.name} (${c.city}) | ${c.address} | Horario: ${c.hours}`
  ).join("\n");

  const ctx = (currentCase.contextJson ?? {}) as CaseContextJson;
  const todayIso = new Date().toISOString().slice(0, 10);

  const systemPrompt = [
    "Eres el asistente virtual oficial de Salud Digna en WhatsApp (español de México, trato amable, claro y breve).",
    "REGLAS ESTRICTAS DE ARQUITECTURA (NUNCA ROMPER):",
    "1. SOLO usa precios, estudios, preparaciones y clínicas del catálogo oficial proporcionado abajo. JAMÁS inventes precios, estudios, horarios ni folios.",
    "2. Si el paciente menciona un estudio, clínica, horario, duda, pide asesor o confirma la cita, DEBES llamar a las herramientas (tools) correspondientes para actualizar la base de datos oficial.",
    "3. Puedes llamar varias herramientas en un solo turno (ej. quote_study + select_clinic si menciona ambos).",
    "4. NO llames confirm_appointment a menos que el paciente haya expresado claramente que quiere confirmar/agendar Y ya tenga estudio y clínica elegidos.",
    "5. Si el paciente pregunta algo general (ej. pagos: 10% descuento en línea, OXXO Pay o en clínica; o qué estudios ofrecen), responde con claridad y proponle el siguiente paso concreto para que nunca se trabe la conversación.",
    "6. Recuérdale cuando sea útil que su avance se sincroniza automáticamente con su cuenta web y Call Center, y que puede escribir 'CAMBIAR' si gestiona citas de familiares.",
    "7. Formato WhatsApp limpio y conciso (máximo 8–10 líneas, usa *negritas* y viñetas).",
    "",
    `FECHA ACTUAL: ${todayIso}`,
    `CONTEXTO ACTUAL DEL TRÁMITE:`,
    `- Estado canónico: ${currentCase.currentState}`,
    `- Paciente: ${params.patientFirstName || "Paciente"} (${params.relationshipLabel}${
      params.isThirdParty ? " — cita gestionada por familiar/titular" : ""
    })`,
    `- Estudio actual: ${
      ctx.study ? `${ctx.study.code} ${ctx.study.name} ($${ctx.study.price} MXN)` : "Ninguno aún"
    }`,
    `- Clínica actual: ${ctx.clinic ? `${ctx.clinic.id} ${ctx.clinic.name}` : "Ninguna aún"}`,
    `- Horario preferido: ${
      ctx.preferred_slot ? `${ctx.preferred_slot.date} ${ctx.preferred_slot.time}` : "Sin definir"
    }`,
    `- Folio confirmado: ${ctx.appointment_folio || "Pendiente"}`,
    "",
    "CATÁLOGO OFICIAL DE ESTUDIOS:",
    catalogText,
    "",
    "CATÁLOGO OFICIAL DE CLÍNICAS:",
    clinicsText,
  ].join("\n");

  // Tomar los últimos 8 mensajes recientes (sin el último que se añade explícitamente abajo)
  const recentHistory = params.history.slice(-9, -1);
  const messages: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];

  for (const h of recentHistory) {
    messages.push({
      role: h.direction === "inbound" ? "user" : "assistant",
      content: scrubPotentialPii(h.text),
    });
  }
  messages.push({
    role: "user",
    content: scrubPotentialPii(params.userText),
  });

  try {
    const firstReply = await callOpenAi(messages, true);

    // Si el modelo decidió ejecutar herramientas del Orquestador
    if (firstReply.tool_calls && firstReply.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: firstReply.content ?? null,
        tool_calls: firstReply.tool_calls,
      });

      for (const tc of firstReply.tool_calls) {
        let toolOutput: Record<string, unknown> = { ok: false, error: "Herramienta desconocida" };
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }

        try {
          if (tc.function.name === "quote_study") {
            const study = findStudyByCode(String(args.studyCode || ""));
            if (!study) {
              toolOutput = { ok: false, error: "Código de estudio inválido." };
            } else {
              const res = await transitionServiceCase({
                caseId: currentCase.id,
                expectedVersion: currentCase.version,
                nextState: CaseState.COTIZANDO,
                channel: Channel.WHATSAPP,
                actorRole: ActorRole.PATIENT,
                eventType: EventType.STUDY_QUOTED,
                correlationId: params.correlationId,
                contextPatch: {
                  study: {
                    code: study.code,
                    name: study.name,
                    price: study.price,
                    prep: study.prep,
                  },
                },
                eventPayload: { studyCode: study.code, price: study.price, via: "ai_nlu" },
              });
              currentCase = res.updatedCase;
              toolOutput = {
                ok: true,
                state: currentCase.currentState,
                study,
                onlineDiscountPrice: Math.round(study.price * 0.9),
              };
            }
          } else if (tc.function.name === "select_clinic") {
            const clinic = findClinicById(String(args.clinicId || ""));
            if (!clinic) {
              toolOutput = { ok: false, error: "ID de clínica inválido." };
            } else {
              const preferredDate = args.preferredDate ? String(args.preferredDate) : undefined;
              const preferredTime = args.preferredTime ? String(args.preferredTime) : undefined;
              const res = await transitionServiceCase({
                caseId: currentCase.id,
                expectedVersion: currentCase.version,
                nextState: CaseState.CLINICA_ELEGIDA,
                channel: Channel.WHATSAPP,
                actorRole: ActorRole.PATIENT,
                eventType: EventType.CLINIC_SELECTED,
                correlationId: params.correlationId,
                contextPatch: {
                  clinic: {
                    id: clinic.id,
                    name: clinic.name,
                    city: clinic.city,
                    address: clinic.address,
                  },
                  ...(preferredDate || preferredTime
                    ? {
                        preferred_slot: {
                          date: preferredDate || todayIso,
                          time: preferredTime || "09:30",
                        },
                      }
                    : {}),
                },
                eventPayload: { clinicId: clinic.id, via: "ai_nlu" },
              });
              currentCase = res.updatedCase;
              toolOutput = { ok: true, state: currentCase.currentState, clinic };
            }
          } else if (tc.function.name === "log_question_or_escalate") {
            const qText = String(args.question || params.userText).trim();
            const requestAdvisor = Boolean(args.requestAdvisor);
            const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
            const res = await transitionServiceCase({
              caseId: currentCase.id,
              expectedVersion: currentCase.version,
              nextState: CaseState.DUDAS_ABIERTAS,
              channel: Channel.WHATSAPP,
              actorRole: ActorRole.PATIENT,
              eventType: EventType.PATIENT_QUESTION_LOGGED,
              correlationId: params.correlationId,
              contextPatch: {
                open_questions: [...(curCtx.open_questions ?? []), qText],
              },
              eventPayload: { question: qText, requestedAdvisor: requestAdvisor, via: "ai_nlu" },
            });
            currentCase = res.updatedCase;
            toolOutput = {
              ok: true,
              state: currentCase.currentState,
              escalatedToCallCenter: requestAdvisor,
              prepOfCurrentStudy: curCtx.study?.prep ?? null,
            };
          } else if (tc.function.name === "confirm_appointment") {
            const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
            if (!curCtx.study || !curCtx.clinic) {
              toolOutput = {
                ok: false,
                error: "Falta elegir estudio o clínica antes de confirmar la cita.",
                missingStudy: !curCtx.study,
                missingClinic: !curCtx.clinic,
              };
            } else {
              const folio = `SD-2026-${crypto.randomInt(1000, 9999)}`;
              const qrPayload = `SALUDDIGNA|${folio}|${curCtx.study.code}|${curCtx.clinic.id}`;
              const res = await transitionServiceCase({
                caseId: currentCase.id,
                expectedVersion: currentCase.version,
                nextState: CaseState.CITA_CONFIRMADA,
                channel: Channel.WHATSAPP,
                actorRole: ActorRole.PATIENT,
                eventType: EventType.APPOINTMENT_CONFIRMED,
                correlationId: params.correlationId,
                contextPatch: {
                  appointment_folio: folio,
                  qr_payload: qrPayload,
                },
                eventPayload: { folio, confirmedVia: Channel.WHATSAPP, via: "ai_nlu" },
              });
              currentCase = res.updatedCase;
              confirmed = true;
              toolOutput = {
                ok: true,
                state: currentCase.currentState,
                folio,
                study: curCtx.study,
                clinic: curCtx.clinic,
              };
            }
          }
        } catch (toolErr) {
          toolOutput = {
            ok: false,
            error: toolErr instanceof Error ? toolErr.message : "Error ejecutando transición",
          };
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(toolOutput),
        });
      }

      // Segunda pasada para redactar la respuesta final natural basada en los resultados reales de las tools
      const finalReply = await callOpenAi(messages, false);
      const textOut = finalReply.content?.trim();
      if (!textOut) return null;

      return { reply: textOut, updatedCase: currentCase, confirmed };
    }

    const directText = firstReply.content?.trim();
    if (!directText) return null;
    return { reply: directText, updatedCase: currentCase, confirmed };
  } catch (err) {
    console.warn(
      `[AI Assistant] Fallback automático al motor determinístico:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
