import crypto from "crypto";
import {
  ActorRole,
  CaseState,
  Channel,
  EventType,
  Gender,
  IdentifierType,
  Patient,
  RelationshipType,
  ServiceCase,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import {
  maskIdentifier,
  maskPatientName,
  normalizeCurp,
  normalizeEmail,
  normalizePersonName,
  normalizePhone,
  normalizePlaceName,
} from "../lib/crypto";
import {
  CLINICS_CATALOG,
  findClinicById,
  findStudyByCode,
  STUDIES_CATALOG,
} from "../data/catalog";
import {
  findPatientByIdentifier,
  formatLidIdentifier,
  issueOtpChallenge,
  mergePatientProfiles,
  RELATIONSHIP_LABELS,
  resolveOrCreateBeneficiary,
  upsertIdentityLink,
} from "./identityService";
import { recordAndPublishEvent } from "./eventBus";
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

type PaymentMethod = "online" | "oxxo" | "clinic";

const AVAILABLE_TIME_SLOTS = ["07:30", "08:30", "09:30", "10:30", "11:30", "13:00", "16:00"];

const MEXICAN_STATES: Array<{ code: string; name: string }> = [
  { code: "AS", name: "AGUASCALIENTES" },
  { code: "BC", name: "BAJA CALIFORNIA" },
  { code: "BS", name: "BAJA CALIFORNIA SUR" },
  { code: "CC", name: "CAMPECHE" },
  { code: "CL", name: "COAHUILA" },
  { code: "CM", name: "COLIMA" },
  { code: "CS", name: "CHIAPAS" },
  { code: "CH", name: "CHIHUAHUA" },
  { code: "DF", name: "CIUDAD DE MÉXICO" },
  { code: "DG", name: "DURANGO" },
  { code: "GT", name: "GUANAJUATO" },
  { code: "GR", name: "GUERRERO" },
  { code: "HG", name: "HIDALGO" },
  { code: "JC", name: "JALISCO" },
  { code: "MC", name: "ESTADO DE MÉXICO" },
  { code: "MN", name: "MICHOACÁN" },
  { code: "MS", name: "MORELOS" },
  { code: "NT", name: "NAYARIT" },
  { code: "NL", name: "NUEVO LEÓN" },
  { code: "OC", name: "OAXACA" },
  { code: "PL", name: "PUEBLA" },
  { code: "QT", name: "QUERÉTARO" },
  { code: "QR", name: "QUINTANA ROO" },
  { code: "SP", name: "SAN LUIS POTOSÍ" },
  { code: "SL", name: "SINALOA" },
  { code: "SR", name: "SONORA" },
  { code: "TC", name: "TABASCO" },
  { code: "TS", name: "TAMAULIPAS" },
  { code: "TL", name: "TLAXCALA" },
  { code: "VZ", name: "VERACRUZ" },
  { code: "YN", name: "YUCATÁN" },
  { code: "ZS", name: "ZACATECAS" },
  { code: "NE", name: "NACIDO EN EL EXTRANJERO" },
];

const CURP_REGEX = /\b([A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d)\b/i;

const IGNORED_PREFIXES = new Set([
  "DE", "DEL", "LA", "LAS", "LOS", "MC", "MAC", "VON", "VAN", "Y", "DA", "DAS", "DO", "DOS",
]);
const IGNORED_FIRST_NAMES = new Set(["MARIA", "MA", "MA.", "JOSE", "J", "J."]);
const INCONVENIENT_WORDS = new Set([
  "BACA", "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO", "COGE", "COJA", "COJE",
  "COJI", "COJO", "CULO", "FETO", "GUEY", "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KOGE", "KOJO",
  "KAKA", "KULO", "MAME", "MAMO", "MEAR", "MEAS", "MEON", "MION", "MOCO", "MULA", "PEDA", "PEDO",
  "PENE", "PUTA", "PUTO", "QULO", "RATA", "RUIN",
]);

/**
 * Sanitiza fragmentos sensibles (CURP de 18 caracteres o códigos OTP de 6 dígitos)
 * antes de enviar historial conversacional al proveedor de IA externo (privacidad LFPDPPP).
 */
function scrubPotentialPii(text: string): string {
  return text
    .replace(/\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi, "[CURP_OCULTA]")
    .replace(/\b\d{6}\b/g, "[CODIGO_OCULTO]");
}

/**
 * Extrae una CURP válida directamente del mensaje crudo en el servidor (nunca se expone a OpenAI).
 */
function extractCurpFromRawText(rawText: string): string | null {
  const match = CURP_REGEX.exec(rawText);
  return match ? match[1].toUpperCase() : null;
}

function normalizeAsciiUpper(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, "")
    .trim();
}

function normalizeSearchText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function splitFullNameIfNeeded(
  nombresRaw?: string | null,
  paternoRaw?: string | null,
  maternoRaw?: string | null
): { firstName?: string; paternalLastName?: string; maternalLastName?: string } {
  const nom = nombresRaw?.trim() || "";
  const pat = paternoRaw?.trim() || "";
  const mat = maternoRaw?.trim() || "";
  if (nom && !pat) {
    const tokens = nom.split(/\s+/).filter(Boolean);
    if (tokens.length === 2) {
      return {
        firstName: tokens[0],
        paternalLastName: tokens[1],
        ...(mat ? { maternalLastName: mat } : {}),
      };
    }
    if (tokens.length >= 3) {
      return {
        firstName: tokens.slice(0, tokens.length - 2).join(" "),
        paternalLastName: tokens[tokens.length - 2],
        maternalLastName: mat || tokens[tokens.length - 1],
      };
    }
  }
  return {
    ...(nom ? { firstName: nom } : {}),
    ...(pat ? { paternalLastName: pat } : {}),
    ...(mat ? { maternalLastName: mat } : {}),
  };
}

function resolveMexicanState(input?: string | null): { code: string; name: string } | null {
  if (!input) return null;
  const clean = normalizeAsciiUpper(input);
  if (!clean) return null;
  const aliases: Record<string, string> = {
    CDMX: "DF",
    "CIUDAD DE MEXICO": "DF",
    "DISTRITO FEDERAL": "DF",
    EDOMEX: "MC",
    "ESTADO DE MEXICO": "MC",
    "NUEVO LEON": "NL",
    MICHOACAN: "MN",
    YUCATAN: "YN",
    QUERETARO: "QT",
    "SAN LUIS POTOSI": "SP",
  };
  if (aliases[clean]) {
    const byAlias = MEXICAN_STATES.find((s) => s.code === aliases[clean]);
    if (byAlias) return byAlias;
  }
  return (
    MEXICAN_STATES.find(
      (s) => s.code === clean || normalizeAsciiUpper(s.name) === clean || normalizeAsciiUpper(s.name).includes(clean)
    ) ?? null
  );
}

function generateDeterministicCurpServer(params: {
  firstName?: string | null;
  paternalLastName?: string | null;
  maternalLastName?: string | null;
  birthDate?: string | null;
  gender?: Gender | null;
  birthState?: string | null;
}): string | null {
  if (
    !params.firstName?.trim() ||
    !params.paternalLastName?.trim() ||
    !params.birthDate ||
    !params.gender ||
    (params.gender !== Gender.FEMENINO && params.gender !== Gender.MASCULINO)
  ) {
    return null;
  }
  const state = resolveMexicanState(params.birthState);
  if (!state) return null;

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.birthDate);
  if (!dateMatch) return null;

  const getMainWord = (raw: string, isFirst = false): string => {
    const tokens = normalizeAsciiUpper(raw)
      .split(/\s+/)
      .filter((t) => t.length > 0 && !IGNORED_PREFIXES.has(t));
    if (tokens.length === 0) return "";
    if (isFirst && tokens.length > 1 && IGNORED_FIRST_NAMES.has(tokens[0])) {
      return tokens[1];
    }
    return tokens[0];
  };

  const firstVowel = (w: string): string => {
    for (let i = 1; i < w.length; i++) {
      if ("AEIOU".includes(w[i])) return w[i];
    }
    return "X";
  };

  const firstConsonant = (w: string): string => {
    for (let i = 1; i < w.length; i++) {
      const ch = w[i];
      if (ch >= "A" && ch <= "Z" && !"AEIOU".includes(ch)) return ch;
    }
    return "X";
  };

  const pat = getMainWord(params.paternalLastName) || "X";
  const mat = getMainWord(params.maternalLastName || "");
  const nom = getMainWord(params.firstName, true) || "X";

  let prefix4 = (pat[0] || "X") + firstVowel(pat) + (mat ? mat[0] : "X") + (nom[0] || "X");
  if (INCONVENIENT_WORDS.has(prefix4)) {
    prefix4 = prefix4[0] + "X" + prefix4.slice(2);
  }

  const yearNum = Number(dateMatch[1]);
  const yy = dateMatch[1].slice(2, 4);
  const mm = dateMatch[2];
  const dd = dateMatch[3];
  const sexChar = params.gender === Gender.FEMENINO ? "M" : "H";
  const cons3 = firstConsonant(pat) + (mat ? firstConsonant(mat) : "X") + firstConsonant(nom);
  const homoclave = yearNum >= 2000 ? "A" : "0";
  const base17 = `${prefix4}${yy}${mm}${dd}${sexChar}${state.code}${cons3}${homoclave}`;

  const dict = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = dict.indexOf(base17[i]);
    sum += (idx === -1 ? 0 : idx) * (18 - i);
  }
  const checkDigit = String((10 - (sum % 10)) % 10);
  return `${base17}${checkDigit}`;
}

function getPaymentMethodLabel(method?: PaymentMethod): string {
  if (method === "online") return "Pago en línea (10% de descuento)";
  if (method === "oxxo") return "OXXO Pay (efectivo)";
  if (method === "clinic") return "Pago en clínica";
  return "Sin definir";
}

function getMissingConfirmationRequirements(ctx: CaseContextJson, patient: Patient | null): string[] {
  const missing: string[] = [];
  if (!ctx.study) missing.push("estudio");
  if (!ctx.clinic) missing.push("clinica");
  if (!ctx.preferred_slot?.date || !ctx.preferred_slot?.time) missing.push("fecha_y_hora");
  if (!ctx.payment_method) missing.push("forma_de_pago");
  if (!patient?.firstName?.trim() || !patient?.paternalLastName?.trim()) {
    missing.push("nombre_y_apellido_paterno");
  }
  return missing;
}

const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_patient_context",
      description:
        "Consulta en tiempo real todos los trámites abiertos y confirmados del titular (y sus familiares) en Web, WhatsApp y Call Center, sus folios, historial reciente de eventos entre canales, beneficiarios vinculados y qué datos faltan para terminar el trámite activo.",
      parameters: {
        type: "object",
        properties: {
          includeConfirmed: {
            type: "boolean",
            description: "Si es true incluye citas ya confirmadas y sus folios.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Consulta el catálogo oficial de estudios (precios, descuento 10% en línea y preparación) y/o clínicas (dirección y horarios) filtrando por categoría, palabra clave o ciudad.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["studies", "clinics", "both"],
            description: "Qué catálogo consultar.",
          },
          query: {
            type: "string",
            description: "Texto opcional para filtrar estudio, categoría o ciudad.",
          },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quote_study",
      description:
        "Cotiza y guarda un estudio oficial del catálogo de Salud Digna en el trámite activo (Paso 1: Estudio).",
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
      name: "select_clinic_and_slot",
      description:
        "Guarda la clínica oficial seleccionada y opcionalmente la fecha, hora preferida y el código de estudio (si aún no se había guardado) en el trámite activo (Paso 1: Estudio, clínica y horario).",
      parameters: {
        type: "object",
        properties: {
          clinicId: {
            type: "string",
            enum: CLINICS_CATALOG.map((c) => c.id),
            description: "ID exacto de la clínica oficial.",
          },
          studyCode: {
            type: "string",
            enum: STUDIES_CATALOG.map((s) => s.code),
            description: "Código oficial del estudio si aún no estaba guardado en el trámite (opcional).",
          },
          preferredDate: {
            type: "string",
            description: "Fecha deseada en formato YYYY-MM-DD (opcional).",
          },
          preferredTime: {
            type: "string",
            description: `Hora deseada en formato HH:MM, horarios oficiales: ${AVAILABLE_TIME_SLOTS.join(", ")} (opcional).`,
          },
        },
        required: ["clinicId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_preferred_slot",
      description:
        "Actualiza únicamente la fecha y/o hora deseada del trámite activo sin modificar el estudio ni la clínica ya elegidos.",
      parameters: {
        type: "object",
        properties: {
          preferredDate: {
            type: "string",
            description: "Fecha deseada en formato YYYY-MM-DD.",
          },
          preferredTime: {
            type: "string",
            description: `Hora deseada en formato HH:MM (ej. ${AVAILABLE_TIME_SLOTS.join(", ")}).`,
          },
        },
        required: ["preferredDate", "preferredTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_patient_profile",
      description:
        "Guarda o actualiza los datos de pre-registro del paciente del trámite activo (Paso 2). Si se proporcionan suficientes datos (o el usuario envió su CURP en el mensaje), el servidor genera/guarda la CURP de forma segura sin exponerla al modelo.",
      parameters: {
        type: "object",
        properties: {
          nombres: { type: "string", description: "Nombre(s) del paciente." },
          apellidoPaterno: { type: "string", description: "Apellido paterno del paciente." },
          apellidoMaterno: { type: "string", description: "Apellido materno (opcional)." },
          fechaNacimiento: {
            type: "string",
            description: "Fecha de nacimiento en formato YYYY-MM-DD (opcional).",
          },
          genero: {
            type: "string",
            enum: ["FEMENINO", "MASCULINO"],
            description: "Género del paciente (opcional).",
          },
          estadoNacimiento: {
            type: "string",
            description: "Estado de nacimiento en México o código de 2 letras (opcional).",
          },
          pais: { type: "string", description: "País de nacimiento, ej. MÉXICO (opcional)." },
          telefono: {
            type: "string",
            description: "Teléfono de 10 dígitos o +52 del paciente para vincular con su cuenta web (opcional).",
          },
          email: { type: "string", description: "Correo electrónico del paciente (opcional)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_existing_account",
      description:
        "Vincula inteligentemente esta conversación de WhatsApp (incluyendo chats con @lid o segundo número) con una cuenta existente de Sitio Web o Call Center usando teléfono o correo (o CURP detectada en servidor), sincronizando todo el historial de citas.",
      parameters: {
        type: "object",
        properties: {
          telefono: {
            type: "string",
            description: "Teléfono registrado en la cuenta web o Call Center (10 dígitos o +52).",
          },
          email: {
            type: "string",
            description: "Correo electrónico registrado en la cuenta web.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_payment_method",
      description:
        "Registra la forma de pago preferida del paciente en el trámite activo (Paso 3) y calcula el monto final con o sin 10% de descuento.",
      parameters: {
        type: "object",
        properties: {
          paymentMethod: {
            type: "string",
            enum: ["online", "oxxo", "clinic"],
            description: "online (10% descuento), oxxo (OXXO Pay efectivo) o clinic (en clínica).",
          },
        },
        required: ["paymentMethod"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_case_for_later",
      description:
        "Guarda el trámite actual como borrador (PAUSADO_PENDIENTE) conservando todo el contexto para continuarlo después en Sitio Web, Call Center o WhatsApp.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Motivo breve por el cual el paciente pausa el trámite.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_or_create_case",
      description:
        "Permite cambiar a otro trámite existente del titular, iniciar una cita nueva para el titular, pausar la actual y abrir una nueva (pause_and_new), anular la actual incompleta y abrir una nueva (discard_and_new), o crear una cita para un familiar/tercero con expediente clínico separado.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["switch", "new_self", "pause_and_new", "discard_and_new", "new_beneficiary"],
            description:
              "switch (cambiar a un caseId existente), new_self (nuevo trámite para el titular), pause_and_new (guardar/pausar el trámite incompleto actual y crear uno nuevo), discard_and_new (anular el trámite incompleto actual y crear uno nuevo), new_beneficiary (nuevo trámite para familiar/conocido).",
          },
          targetCaseId: {
            type: "string",
            description: "UUID del trámite al cual cambiar (requerido si action es 'switch').",
          },
          relationship: {
            type: "string",
            enum: ["HIJO_A", "PADRE_MADRE", "CONYUGE", "ABUELO_A", "FAMILIAR", "CONOCIDO"],
            description: "Parentesco del familiar (requerido si action es 'new_beneficiary').",
          },
          consentAccepted: {
            type: "boolean",
            description:
              "Debe ser true cuando el titular confirmó autorización para agendar a un tercero.",
          },
          beneficiaryNombres: { type: "string", description: "Nombre(s) del familiar." },
          beneficiaryApellidoPaterno: {
            type: "string",
            description: "Apellido paterno del familiar.",
          },
          beneficiaryApellidoMaterno: {
            type: "string",
            description: "Apellido materno del familiar (opcional).",
          },
          beneficiaryFechaNacimiento: {
            type: "string",
            description: "Fecha de nacimiento del familiar YYYY-MM-DD (opcional).",
          },
          beneficiaryGenero: {
            type: "string",
            enum: ["FEMENINO", "MASCULINO"],
            description: "Género del familiar (opcional).",
          },
          beneficiaryEstadoNacimiento: {
            type: "string",
            description: "Estado de nacimiento del familiar (opcional).",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_question_or_escalate",
      description:
        "Registra una duda clínica/operativa o turna el expediente a un asesor humano de Call Center (Screen-Pop inmediato con todo el contexto).",
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
        "Finaliza y confirma oficialmente la cita generando Folio y código QR. Exige estudio, clínica, fecha y hora, forma de pago y nombre/apellido paterno del paciente. Si el usuario indica alguno de estos campos al confirmar, pueden pasarse aquí directamente.",
      parameters: {
        type: "object",
        properties: {
          studyCode: {
            type: "string",
            enum: STUDIES_CATALOG.map((s) => s.code),
            description: "Código del estudio si aún no se había guardado (opcional).",
          },
          clinicId: {
            type: "string",
            enum: CLINICS_CATALOG.map((c) => c.id),
            description: "ID de clínica si aún no se había guardado (opcional).",
          },
          paymentMethod: {
            type: "string",
            enum: ["online", "oxxo", "clinic"],
            description: "Forma de pago si el usuario la menciona al confirmar (opcional).",
          },
          preferredDate: {
            type: "string",
            description: "Fecha YYYY-MM-DD si la menciona al confirmar (opcional).",
          },
          preferredTime: {
            type: "string",
            description: "Hora HH:MM si la menciona al confirmar (opcional).",
          },
          nombres: {
            type: "string",
            description: "Nombre(s) del paciente si los da al confirmar (opcional).",
          },
          apellidoPaterno: {
            type: "string",
            description: "Apellido paterno del paciente si lo da al confirmar (opcional).",
          },
          apellidoMaterno: {
            type: "string",
            description: "Apellido materno del paciente si lo da al confirmar (opcional).",
          },
          telefono: {
            type: "string",
            description: "Teléfono del paciente si lo da al confirmar (opcional).",
          },
          email: {
            type: "string",
            description: "Correo del paciente si lo da al confirmar (opcional).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_confirmed_appointment",
      description:
        "Edita o reagenda una cita YA CONFIRMADA previamente del paciente (cambiando estudio, clínica, fecha, horario y/o forma de pago) conservando su folio y sincronizando los cambios al instante en Call Center, Admin y Mi Cuenta.",
      parameters: {
        type: "object",
        properties: {
          caseId: {
            type: "string",
            description: "UUID de la cita confirmada a editar (opcional si se proporciona folio o solo hay una).",
          },
          folio: {
            type: "string",
            description: "Folio de la cita confirmada a editar, ej. SD-2026-1234 (opcional).",
          },
          studyCode: {
            type: "string",
            enum: STUDIES_CATALOG.map((s) => s.code),
            description: "Nuevo código de estudio oficial si desea cambiarlo (opcional).",
          },
          clinicId: {
            type: "string",
            enum: CLINICS_CATALOG.map((c) => c.id),
            description: "Nuevo ID de clínica oficial si desea cambiarla (opcional).",
          },
          preferredDate: {
            type: "string",
            description: "Nueva fecha YYYY-MM-DD (opcional).",
          },
          preferredTime: {
            type: "string",
            description: `Nuevo horario HH:MM (${AVAILABLE_TIME_SLOTS.join(", ")}) (opcional).`,
          },
          paymentMethod: {
            type: "string",
            enum: ["online", "oxxo", "clinic"],
            description: "Nueva forma de pago (opcional).",
          },
        },
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
      temperature: 0.2,
      max_tokens: 650,
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
 * Asistente omnicanal (OpenAI Function Calling) controlado estrictamente
 * por la Máquina de Estados Determinística y las reglas de privacidad LFPDPPP.
 *
 * - Capaz de consultar contextos de Web, WhatsApp y Call Center, ejecutar el flujo completo
 *   de 3 pasos (Estudio/Clínica/Horario -> Pre-registro -> Forma de pago y Confirmación),
 *   pausar borradores, gestionar familiares y escalar a Call Center.
 * - Si OPENAI_API_KEY no está configurada o ocurre un error/timeout, devuelve `null`
 *   para activar automáticamente el fallback determinístico.
 */
export async function runSmartWhatsAppAssistant(params: {
  serviceCase: ServiceCase;
  holder: Pick<Patient, "id" | "firstName" | "paternalLastName" | "phone">;
  patientFirstName?: string | null;
  isThirdParty: boolean;
  relationshipLabel: string;
  history: SimpleChatMessage[];
  userText: string;
  correlationId: string;
  whatsappLid?: string;
  isUnresolvedLid?: boolean;
}): Promise<{
  reply: string;
  updatedCase: ServiceCase;
  confirmed: boolean;
  switchedCaseId?: string;
} | null> {
  if (!env.OPENAI_API_KEY) {
    return null;
  }

  let currentCase = params.serviceCase;
  let confirmed = false;
  let switchedCaseId: string | undefined;

  // Extraer posible CURP del texto crudo en servidor (nunca se envía a OpenAI)
  const rawCurpInMessage = extractCurpFromRawText(params.userText);

  // Cargar contexto omnicanal completo (paciente actual, trámites en todos los canales y eventos recientes)
  const [activePatientInitial, allHolderCases, recentEvents, holderRelationships] =
    await Promise.all([
      prisma.patient.findUnique({ where: { id: currentCase.patientId } }),
      prisma.serviceCase.findMany({
        where: {
          OR: [{ requesterPatientId: params.holder.id }, { patientId: params.holder.id }],
        },
        include: {
          patient: { select: { id: true, firstName: true, paternalLastName: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 12,
      }),
      prisma.journeyEvent.findMany({
        where: { caseId: currentCase.id },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      prisma.patientRelationship.findMany({
        where: { holderPatientId: params.holder.id },
        include: {
          beneficiary: { select: { id: true, firstName: true, paternalLastName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

  let activePatient = activePatientInitial;

  const catalogText = STUDIES_CATALOG.map(
    (s) =>
      `- ${s.code}: ${s.name} (${s.category}) | Precio: $${s.price} MXN (en línea -10%: $${Math.round(
        s.price * 0.9
      )} MXN) | Prep: ${s.prep}`
  ).join("\n");

  const clinicsText = CLINICS_CATALOG.map(
    (c) => `- ${c.id}: ${c.name} (${c.city}) | ${c.address} | Horario: ${c.hours}`
  ).join("\n");

  const ctx = (currentCase.contextJson ?? {}) as CaseContextJson;
  const todayIso = new Date().toISOString().slice(0, 10);
  const missingReq = getMissingConfirmationRequirements(ctx, activePatient);

  const otherCasesSummary = allHolderCases
    .filter((c) => c.id !== currentCase.id)
    .slice(0, 6)
    .map((c) => {
      const cCtx = (c.contextJson ?? {}) as CaseContextJson;
      const who = maskPatientName(c.patient.firstName, c.patient.paternalLastName);
      const rel = c.relationshipLabel || (c.patientId === params.holder.id ? "Titular" : "Familiar");
      return `- caseId=${c.id} | ${who} (${rel}) | Estado: ${c.currentState} | Canal: ${
        c.currentChannel
      } | Estudio: ${cCtx.study?.name ?? "Pendiente"} | Clínica: ${
        cCtx.clinic?.name ?? "Pendiente"
      }${cCtx.appointment_folio ? ` | Folio: ${cCtx.appointment_folio}` : ""}`;
    })
    .join("\n");

  const recentEventsSummary = [...recentEvents]
    .reverse()
    .map(
      (ev) =>
        `- [${ev.channel}] ${ev.eventType}${
          ev.nextState ? ` (${ev.prevState ?? "INICIO"} -> ${ev.nextState})` : ""
        }`
    )
    .join("\n");

  const beneficiariesSummary = holderRelationships
    .map(
      (rel) =>
        `- ${maskPatientName(rel.beneficiary.firstName, rel.beneficiary.paternalLastName)} (${
          RELATIONSHIP_LABELS[rel.relationship] || rel.relationship
        })`
    )
    .join("\n");

  const profileStatusSummary = [
    `Nombre(s): ${activePatient?.firstName || "FALTANTE"}`,
    `Apellido paterno: ${activePatient?.paternalLastName ? "Registrado" : "FALTANTE"}`,
    `Fecha nac.: ${activePatient?.birthDate ? "Registrada" : "Pendiente"}`,
    `Género: ${activePatient?.gender ?? "Pendiente"}`,
    `Estado nac.: ${activePatient?.birthState || "Pendiente"}`,
    `CURP: ${activePatient?.curp ? "Registrada (protegida)" : "Pendiente (se autogenera en servidor)"}`,
  ].join(" | ");

  const systemPrompt = [
    "Eres el asistente virtual omnicanal oficial de Salud Digna en WhatsApp (español de México, trato cercano, claro y profesional, con capacidades completas equivalentes al portal web y a un asesor de Call Center).",
    "",
    "MISIÓN Y FLUJO DE 3 PASOS PARA TERMINAR TRÁMITES:",
    "Guía y completa trámites de citas de principio a fin respetando los 3 pasos oficiales, retomando SIEMPRE desde el paso exacto donde se quedó el paciente en Sitio Web, Call Center o WhatsApp:",
    "- Paso 1 (Estudio, clínica y horario): cotizar estudio (`quote_study`), elegir clínica y fecha/hora (`select_clinic_and_slot` o `update_preferred_slot`). Horarios sugeridos: " +
      AVAILABLE_TIME_SLOTS.join(", ") +
      ".",
    "- Paso 2 (Pre-registro): verificar si faltan datos del paciente (`update_patient_profile`). Para confirmar se requiere al menos nombre(s) y apellido paterno; si el usuario da fecha de nacimiento, género y estado (o escribe su CURP), guárdalos con `update_patient_profile` y el servidor generará/resguardará la CURP automáticamente.",
    "- Paso 3 (Resumen, forma de pago y confirmación): registrar forma de pago (`set_payment_method`: `online` con 10% de descuento, `oxxo` o `clinic`) y confirmar la cita (`confirm_appointment`) generando Folio y código QR.",
    "",
    "REGLAS ESTRICTAS DE ARQUITECTURA Y SEGURIDAD (NUNCA ROMPER):",
    "1. Usa EXCLUSIVAMENTE estudios, códigos, precios, preparaciones y clínicas del catálogo oficial. JAMÁS inventes precios, folios, códigos QR ni disponibilidad.",
    "2. SINCRONIZACIÓN OBLIGATORIA EN TIEMPO REAL: Ejecuta SIEMPRE la herramienta correspondiente EN EL MISMO TURNO en que el usuario proporcione o elija información (NO respondas solo con texto):",
    "   - Si el usuario menciona, elige o confirma un estudio (con o sin acentos, ej. 'quimica sanguinea', 'biometria', 'ultrasonido'), llama INMEDIATAMENTE `quote_study` en ese mismo turno.",
    "   - Si elige clínica y/o fecha/hora, llama `select_clinic_and_slot` (si `Estudio actual` aún dice 'Ninguno aún', pasa también `studyCode` o llama `quote_study` junto con `select_clinic_and_slot`).",
    "   - En cuanto el usuario escriba su nombre, apellido, teléfono, correo, fecha de nacimiento, género, estado o CURP, llama INMEDIATAMENTE `update_patient_profile` en ese mismo turno para que Call Center y Admin muestren su nombre real y el resumen actualizado al instante.",
    "   - Si indica forma de pago (`online`, `oxxo` o `clinic`), llama `set_payment_method`.",
    "3. Puedes combinar múltiples tools en el mismo turno (ej. `quote_study` + `select_clinic_and_slot`, o `update_patient_profile` + `set_payment_method` + `confirm_appointment`).",
    "4. PROHIBIDO ABSOLUTO ALUCINAR CONFIRMACIÓN: NUNCA digas que la cita quedó confirmada, reservada o agendada ni muestres un folio si NO ejecutaste `confirm_appointment` con `ok: true` en este turno (o si ya existía un `Folio confirmado` real). Antes de confirmar asegúrate de tener: estudio, clínica, fecha/hora, forma de pago y nombre + apellido paterno. Los campos extra de perfil (CURP, fecha de nacimiento, correo o cuenta web) son OPCIONALES: si el usuario no desea darlos ahora o los omite, NO bloquees la confirmación si ya tienes los 5 datos obligatorios.",
    "5. Privacidad LFPDPPP: NUNCA pidas ni repitas códigos OTP ni CURPs completas en texto abierto innecesariamente; recuerda al usuario que sus datos y CURP se protegen automáticamente en el servidor. Si el usuario menciona familiares, valida autorización (`consentAccepted: true`) antes de usar `switch_or_create_case` con `new_beneficiary`.",
    "6. Si el usuario pregunta por citas iniciadas en Web o Call Center, estatus, folios o historial, usa `get_patient_context` para responder con información exacta y actualizada de todos los canales. Si el chat llegó con identificador privado (@lid) o el usuario indica un teléfono/correo distinto para encontrar su cuenta web, usa `link_existing_account` para sincronizar todo su historial al instante.",
    "7. CITA A MEDIAS + SOLICITUD DE NUEVA CITA (OBLIGATORIO): Si el trámite activo NO está confirmado (`currentState !== CITA_CONFIRMADA`) y ya tiene avance (estudio, clínica u horario), y el usuario pide iniciar/crear otra cita nueva, ANTES de crearla debes preguntarle exactamente estas dos opciones:",
    "   a) ¿Quieres *guardar tu cita actual* y retomarla en otro momento?",
    "   b) ¿Quieres *anular esta cita* y generar una nueva?",
    "   Cuando responda (a), llama `switch_or_create_case({ action: \"pause_and_new\" })`. Cuando responda (b), llama `switch_or_create_case({ action: \"discard_and_new\" })`. Si el trámite activo YA está confirmado (`CITA_CONFIRMADA`) y el usuario quiere agendar otra cita nueva, NO le repitas el resumen de la cita ya confirmada: llama directamente `switch_or_create_case({ action: \"new_self\" })` para abrir un nuevo registro.",
    "8. EDICIÓN DE CITAS CONFIRMADAS: Si el usuario pide editar, modificar o reagendar una cita ya registrada/confirmada (cambiar estudio, clínica, fecha, horario o forma de pago), consulta con `get_patient_context` si hay varias citas para confirmar qué folio editar, y aplica los cambios con `edit_confirmed_appointment`.",
    "9. MENÚ RÁPIDO VÍA CHAT: Cuando el usuario salude sin petición concreta, escriba 'MENÚ'/'OPCIONES'/'0' o elija una opción numérica del menú rápido, presenta/atiende estas opciones numeradas:",
    "   1️⃣ Agendar o cotizar una nueva cita",
    "   2️⃣ Ver mis citas y folios activos",
    "   3️⃣ Editar o reagendar una cita confirmada",
    "   4️⃣ Ver estudios, precios y clínicas",
    "   5️⃣ Pausar o cambiar de trámite",
    "   6️⃣ Hablar con un asesor de Call Center",
    "10. Si el usuario dice que continúa después o quiere pausar, llama `pause_case_for_later` y confírmale que podrá retomar exactamente en el mismo paso desde Sitio Web, WhatsApp o Call Center. Si pide hablar con un humano o tiene una duda médica compleja, llama `log_question_or_escalate` con `requestAdvisor: true`.",
    "11. Formato WhatsApp limpio y conciso (máximo 12 líneas, usa *negritas* y viñetas claras, y cierra siempre con el siguiente paso concreto o recordatorio breve de escribir *MENÚ*).",
    "",
    `FECHA ACTUAL: ${todayIso}`,
    `CHAT CON IDENTIFICADOR PRIVADO (@lid SIN TELÉFONO VISIBLE): ${params.isUnresolvedLid ? "SÍ (pide teléfono de 10 dígitos o correo para vincular con su cuenta web si pregunta por citas previas o antes de confirmar)" : "NO"}`,
    `MENSAJE ACTUAL TRAE CURP DETECTADA EN SERVIDOR: ${rawCurpInMessage ? "SÍ (lista para guardarse vía update_patient_profile)" : "NO"}`,
    "",
    "TRÁMITE ACTIVO ACTUAL:",
    `- caseId: ${currentCase.id}`,
    `- Estado canónico: ${currentCase.currentState} | Último canal: ${currentCase.currentChannel}`,
    `- Beneficiario: ${params.patientFirstName || activePatient?.firstName || "Paciente"} (${params.relationshipLabel}${
      params.isThirdParty ? " — cita de familiar/tercero" : ""
    })`,
    `- Perfil del paciente: ${profileStatusSummary}`,
    `- Estudio actual: ${
      ctx.study ? `${ctx.study.code} ${ctx.study.name} ($${ctx.study.price} MXN)` : "Ninguno aún"
    }`,
    `- Clínica actual: ${ctx.clinic ? `${ctx.clinic.id} ${ctx.clinic.name}` : "Ninguna aún"}`,
    `- Horario preferido: ${
      ctx.preferred_slot ? `${ctx.preferred_slot.date} ${ctx.preferred_slot.time}` : "Sin definir"
    }`,
    `- Forma de pago: ${getPaymentMethodLabel(ctx.payment_method)}`,
    `- Folio confirmado: ${ctx.appointment_folio || "Pendiente"}`,
    `- Faltantes para poder confirmar: ${missingReq.length > 0 ? missingReq.join(", ") : "Ninguno (listo para confirmar)"}`,
    `- Resumen handoff omnicanal: ${ctx.handoff_summary || "Sin resumen previo"}`,
    ...(ctx.call_summaries && ctx.call_summaries.length > 0
      ? [
          `- Última llamada con Call Center (${ctx.call_summaries[0].advisorName}): ${ctx.call_summaries[0].summary}`,
          ...(ctx.call_summaries[0].agreements.length > 0
            ? [`- Acuerdos de la llamada: ${ctx.call_summaries[0].agreements.join("; ")}`]
            : []),
          ...(ctx.call_summaries[0].pendingActions.length > 0
            ? [`- Pendientes de la llamada: ${ctx.call_summaries[0].pendingActions.join("; ")}`]
            : []),
        ]
      : []),
    "",
    "ÚLTIMOS EVENTOS DEL TRÁMITE ACTIVO ENTRE CANALES:",
    recentEventsSummary || "- Sin eventos previos",
    "",
    "OTROS TRÁMITES DEL TITULAR EN TODOS LOS CANALES:",
    otherCasesSummary || "- No hay otros trámites registrados",
    "",
    "FAMILIARES / BENEFICIARIOS REGISTRADOS:",
    beneficiariesSummary || "- Ninguno registrado aún",
    "",
    "CATÁLOGO OFICIAL DE ESTUDIOS:",
    catalogText,
    "",
    "CATÁLOGO OFICIAL DE CLÍNICAS:",
    clinicsText,
  ].join("\n");

  const recentHistory = params.history.slice(-11, -1);
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

  const executeToolCall = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    if (name === "get_patient_context") {
      const includeConfirmed = args.includeConfirmed !== false;
      const [freshCases, freshEvents, freshPatient] = await Promise.all([
        prisma.serviceCase.findMany({
          where: {
            OR: [{ requesterPatientId: params.holder.id }, { patientId: params.holder.id }],
            ...(includeConfirmed ? {} : { currentState: { not: CaseState.CITA_CONFIRMADA } }),
          },
          include: {
            patient: { select: { id: true, firstName: true, paternalLastName: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        prisma.journeyEvent.findMany({
          where: { caseId: currentCase.id },
          orderBy: { createdAt: "desc" },
          take: 8,
        }),
        prisma.patient.findUnique({ where: { id: currentCase.patientId } }),
      ]);
      activePatient = freshPatient;
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;

      return {
        ok: true,
        activeCaseId: currentCase.id,
        activeState: currentCase.currentState,
        activeChannel: currentCase.currentChannel,
        missingForConfirmation: getMissingConfirmationRequirements(curCtx, activePatient),
        activeSummary: {
          study: curCtx.study ?? null,
          clinic: curCtx.clinic ?? null,
          preferredSlot: curCtx.preferred_slot ?? null,
          paymentMethod: curCtx.payment_method ?? null,
          folio: curCtx.appointment_folio ?? null,
          handoffSummary: curCtx.handoff_summary ?? null,
          latestCallSummary: curCtx.latest_call_summary ?? null,
          latestCallAgreements: curCtx.call_summaries?.[0]?.agreements ?? [],
          latestCallPendingActions: curCtx.call_summaries?.[0]?.pendingActions ?? [],
        },
        recentEvents: freshEvents.reverse().map((e) => ({
          channel: e.channel,
          eventType: e.eventType,
          prevState: e.prevState,
          nextState: e.nextState,
          at: e.createdAt.toISOString(),
        })),
        allCases: freshCases.map((c) => {
          const cCtx = (c.contextJson ?? {}) as CaseContextJson;
          return {
            caseId: c.id,
            isActive: c.id === currentCase.id,
            beneficiary: maskPatientName(c.patient.firstName, c.patient.paternalLastName),
            relationship: c.relationshipLabel || "Titular",
            state: c.currentState,
            channel: c.currentChannel,
            study: cCtx.study?.name ?? null,
            clinic: cCtx.clinic?.name ?? null,
            slot: cCtx.preferred_slot ?? null,
            folio: cCtx.appointment_folio ?? null,
          };
        }),
      };
    }

    if (name === "search_catalog") {
      const type = String(args.type || "both");
      const q = normalizeSearchText(String(args.query || ""));
      const matchedStudies =
        type === "clinics"
          ? []
          : STUDIES_CATALOG.filter(
              (s) =>
                !q ||
                normalizeSearchText(s.name).includes(q) ||
                normalizeSearchText(s.category).includes(q) ||
                normalizeSearchText(s.code).includes(q)
            ).map((s) => ({
              ...s,
              onlinePrice: Math.round(s.price * 0.9),
            }));
      const matchedClinics =
        type === "studies"
          ? []
          : CLINICS_CATALOG.filter(
              (c) =>
                !q ||
                normalizeSearchText(c.name).includes(q) ||
                normalizeSearchText(c.city).includes(q) ||
                normalizeSearchText(c.address).includes(q) ||
                normalizeSearchText(c.id).includes(q)
            );
      return {
        ok: true,
        studies: matchedStudies,
        clinics: matchedClinics,
        availableTimeSlots: AVAILABLE_TIME_SLOTS,
      };
    }

    if (name === "quote_study") {
      const study = findStudyByCode(String(args.studyCode || ""));
      if (!study) return { ok: false, error: "Código de estudio inválido." };
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
      const nextState = curCtx.clinic ? CaseState.CLINICA_ELEGIDA : CaseState.COTIZANDO;
      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState,
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
      return {
        ok: true,
        state: currentCase.currentState,
        study,
        onlineDiscountPrice: Math.round(study.price * 0.9),
        missingForConfirmation: getMissingConfirmationRequirements(
          (currentCase.contextJson ?? {}) as CaseContextJson,
          activePatient
        ),
      };
    }

    if (name === "select_clinic_and_slot") {
      const clinic = findClinicById(String(args.clinicId || ""));
      if (!clinic) return { ok: false, error: "ID de clínica inválido." };
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
      const studyOverride = args.studyCode ? findStudyByCode(String(args.studyCode)) : undefined;
      const preferredDate = args.preferredDate
        ? String(args.preferredDate)
        : curCtx.preferred_slot?.date;
      const preferredTime = args.preferredTime
        ? String(args.preferredTime)
        : curCtx.preferred_slot?.time;

      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState: CaseState.CLINICA_ELEGIDA,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.CLINIC_SELECTED,
        correlationId: params.correlationId,
        contextPatch: {
          ...(studyOverride
            ? {
                study: {
                  code: studyOverride.code,
                  name: studyOverride.name,
                  price: studyOverride.price,
                  prep: studyOverride.prep,
                },
              }
            : {}),
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
        eventPayload: {
          clinicId: clinic.id,
          ...(studyOverride ? { studyCode: studyOverride.code } : {}),
          preferredDate: preferredDate ?? null,
          preferredTime: preferredTime ?? null,
          via: "ai_nlu",
        },
      });
      currentCase = res.updatedCase;
      return {
        ok: true,
        state: currentCase.currentState,
        study: ((currentCase.contextJson ?? {}) as CaseContextJson).study ?? null,
        clinic,
        preferredSlot: ((currentCase.contextJson ?? {}) as CaseContextJson).preferred_slot ?? null,
        missingForConfirmation: getMissingConfirmationRequirements(
          (currentCase.contextJson ?? {}) as CaseContextJson,
          activePatient
        ),
      };
    }

    if (name === "update_preferred_slot") {
      const preferredDate = String(args.preferredDate || "").trim();
      const preferredTime = String(args.preferredTime || "").trim();
      if (!preferredDate || !preferredTime) {
        return { ok: false, error: "Debes indicar fecha (YYYY-MM-DD) y hora (HH:MM)." };
      }
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
      const nextState = curCtx.clinic ? CaseState.CLINICA_ELEGIDA : CaseState.EN_PROGRESO;
      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.CLINIC_SELECTED,
        correlationId: params.correlationId,
        contextPatch: {
          preferred_slot: { date: preferredDate, time: preferredTime },
        },
        eventPayload: { preferredDate, preferredTime, via: "ai_nlu" },
      });
      currentCase = res.updatedCase;
      return {
        ok: true,
        state: currentCase.currentState,
        preferredSlot: { date: preferredDate, time: preferredTime },
        missingForConfirmation: getMissingConfirmationRequirements(
          (currentCase.contextJson ?? {}) as CaseContextJson,
          activePatient
        ),
      };
    }

    if (name === "update_patient_profile") {
      const existing = await prisma.patient.findUnique({ where: { id: currentCase.patientId } });
      if (!existing) return { ok: false, error: "Expediente de paciente no encontrado." };

      const parsedNames = splitFullNameIfNeeded(
        args.nombres ? String(args.nombres) : undefined,
        args.apellidoPaterno ? String(args.apellidoPaterno) : undefined,
        args.apellidoMaterno ? String(args.apellidoMaterno) : undefined
      );
      const firstName = normalizePersonName(parsedNames.firstName) ?? existing.firstName;
      const paternalLastName =
        normalizePersonName(parsedNames.paternalLastName) ?? existing.paternalLastName;
      const maternalLastName =
        normalizePersonName(parsedNames.maternalLastName) ?? existing.maternalLastName;
      const birthDateStr = args.fechaNacimiento
        ? String(args.fechaNacimiento).trim()
        : existing.birthDate
        ? existing.birthDate.toISOString().slice(0, 10)
        : null;
      const genderArg =
        args.genero === "FEMENINO"
          ? Gender.FEMENINO
          : args.genero === "MASCULINO"
          ? Gender.MASCULINO
          : existing.gender;
      const resolvedState = args.estadoNacimiento
        ? resolveMexicanState(String(args.estadoNacimiento))
        : null;
      const birthState =
        normalizePlaceName(resolvedState?.name) ||
        normalizePlaceName(args.estadoNacimiento ? String(args.estadoNacimiento) : undefined) ||
        existing.birthState;
      const country =
        normalizePlaceName(args.pais ? String(args.pais) : undefined) ?? existing.country;
      const emailArg = normalizeEmail(args.email ? String(args.email) : undefined);
      const phoneArg =
        args.telefono && String(args.telefono).replace(/\D/g, "").length >= 10
          ? normalizePhone(String(args.telefono))
          : undefined;

      // Detectar si alguno de los identificadores (CURP, correo o teléfono) ya pertenece a una cuenta maestra
      let matchedMaster: Patient | null = null;
      if (rawCurpInMessage) {
        matchedMaster = await findPatientByIdentifier(IdentifierType.CURP, rawCurpInMessage);
      }
      if (!matchedMaster && emailArg) {
        matchedMaster = await findPatientByIdentifier(IdentifierType.EMAIL, emailArg);
      }
      if (!matchedMaster && phoneArg) {
        matchedMaster = await findPatientByIdentifier(IdentifierType.PHONE, phoneArg);
      }

      if (matchedMaster && matchedMaster.id !== existing.id) {
        const merged = await mergePatientProfiles({
          masterId: matchedMaster.id,
          secondaryIds: [existing.id],
          channel: Channel.WHATSAPP,
        });
        if (merged.mergedPatientIds.includes(existing.id)) {
          activePatient = merged.master;
          if (params.whatsappLid) {
            await upsertIdentityLink(
              activePatient.id,
              IdentifierType.APP,
              formatLidIdentifier(params.whatsappLid),
              false
            );
          }
          currentCase = await prisma.serviceCase.findUniqueOrThrow({ where: { id: currentCase.id } });
          const nextStateAfterMerge =
            currentCase.currentState === CaseState.INICIADO
              ? CaseState.EN_PROGRESO
              : currentCase.currentState;
          const syncedMerge = await transitionServiceCase({
            caseId: currentCase.id,
            expectedVersion: currentCase.version,
            nextState: nextStateAfterMerge,
            channel: Channel.WHATSAPP,
            actorRole: ActorRole.PATIENT,
            eventType: EventType.IDENTITY_LINKED,
            correlationId: params.correlationId,
            eventPayload: {
              via: "ai_nlu",
              linkedToExistingAccount: true,
              syncedCasesCount: merged.syncedCasesCount,
            },
          });
          currentCase = syncedMerge.updatedCase;
          switchedCaseId = currentCase.id;
          return {
            ok: true,
            linkedToExistingAccount: true,
            syncedCasesCount: merged.syncedCasesCount,
            patientFirstName: activePatient.firstName,
            hasPaternalLastName: Boolean(activePatient.paternalLastName),
            curpSaved: Boolean(activePatient.curp),
            missingForConfirmation: getMissingConfirmationRequirements(
              (currentCase.contextJson ?? {}) as CaseContextJson,
              activePatient
            ),
          };
        }
      }

      // Generar o capturar CURP en servidor sin exponerla a OpenAI
      let finalCurp = existing.curp;
      if (!finalCurp && rawCurpInMessage) {
        const collision = await prisma.patient.findUnique({ where: { curp: rawCurpInMessage } });
        if (!collision || collision.id === existing.id) {
          finalCurp = rawCurpInMessage;
        }
      }
      if (!finalCurp) {
        const generated = generateDeterministicCurpServer({
          firstName,
          paternalLastName,
          maternalLastName,
          birthDate: birthDateStr,
          gender: genderArg,
          birthState,
        });
        if (generated) {
          const collision = await prisma.patient.findUnique({ where: { curp: generated } });
          if (!collision || collision.id === existing.id) {
            finalCurp = generated;
          }
        }
      }

      const updateData: Record<string, unknown> = {
        ...(firstName ? { firstName } : {}),
        ...(paternalLastName ? { paternalLastName } : {}),
        ...(maternalLastName ? { maternalLastName } : {}),
        ...(birthDateStr && /^\d{4}-\d{2}-\d{2}$/.test(birthDateStr)
          ? { birthDate: new Date(birthDateStr) }
          : {}),
        ...(genderArg ? { gender: genderArg } : {}),
        ...(birthState ? { birthState } : {}),
        ...(country ? { country } : {}),
        ...(finalCurp ? { curp: finalCurp } : {}),
        ...(phoneArg && !existing.phone ? { phone: phoneArg } : {}),
      };

      if (emailArg && emailArg !== existing.email) {
        const emailTaken = await prisma.patient.findUnique({ where: { email: emailArg } });
        if (!emailTaken) {
          updateData.email = emailArg;
        }
      }

      activePatient = await prisma.patient.update({
        where: { id: existing.id },
        data: updateData,
      });

      if (finalCurp) {
        await upsertIdentityLink(activePatient.id, IdentifierType.CURP, finalCurp, false);
      }
      if (phoneArg) {
        await upsertIdentityLink(activePatient.id, IdentifierType.PHONE, phoneArg, false);
      }
      if (emailArg && activePatient.email === emailArg) {
        await upsertIdentityLink(activePatient.id, IdentifierType.EMAIL, emailArg, false);
      }

      const nextStateAfterProfile =
        currentCase.currentState === CaseState.INICIADO
          ? CaseState.EN_PROGRESO
          : currentCase.currentState;

      const syncedProfile = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState: nextStateAfterProfile,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.IDENTITY_LINKED,
        correlationId: params.correlationId,
        eventPayload: {
          via: "ai_nlu",
          updatedProfile: true,
          curpSaved: Boolean(finalCurp),
        },
      });
      currentCase = syncedProfile.updatedCase;

      return {
        ok: true,
        patientFirstName: activePatient.firstName,
        hasPaternalLastName: Boolean(activePatient.paternalLastName),
        curpSaved: Boolean(finalCurp),
        curpMasked: finalCurp ? maskIdentifier(IdentifierType.CURP, finalCurp) : null,
        missingForConfirmation: getMissingConfirmationRequirements(
          (currentCase.contextJson ?? {}) as CaseContextJson,
          activePatient
        ),
      };
    }

    if (name === "link_existing_account") {
      const phoneArg =
        args.telefono && String(args.telefono).replace(/\D/g, "").length >= 10
          ? normalizePhone(String(args.telefono))
          : undefined;
      const emailArg = normalizeEmail(args.email ? String(args.email) : undefined);

      if (!phoneArg && !emailArg && !rawCurpInMessage) {
        return {
          ok: false,
          error: "Pide al paciente su teléfono de 10 dígitos, correo electrónico o CURP para localizar su cuenta.",
        };
      }

      let targetMaster: Patient | null = null;
      if (rawCurpInMessage) {
        targetMaster = await findPatientByIdentifier(IdentifierType.CURP, rawCurpInMessage);
      }
      if (!targetMaster && emailArg) {
        targetMaster = await findPatientByIdentifier(IdentifierType.EMAIL, emailArg);
      }
      if (!targetMaster && phoneArg) {
        targetMaster = await findPatientByIdentifier(IdentifierType.PHONE, phoneArg);
      }

      if (!targetMaster) {
        // Si aún no tiene cuenta web, al menos guardamos el teléfono/correo en el expediente actual
        if (phoneArg || emailArg) {
          activePatient = await prisma.patient.update({
            where: { id: currentCase.patientId },
            data: {
              ...(phoneArg ? { phone: phoneArg } : {}),
              ...(emailArg ? { email: emailArg } : {}),
            },
          });
          if (phoneArg) {
            await upsertIdentityLink(activePatient.id, IdentifierType.PHONE, phoneArg, false);
          }
          if (emailArg) {
            await upsertIdentityLink(activePatient.id, IdentifierType.EMAIL, emailArg, false);
          }
          const syncedContact = await transitionServiceCase({
            caseId: currentCase.id,
            expectedVersion: currentCase.version,
            nextState:
              currentCase.currentState === CaseState.INICIADO
                ? CaseState.EN_PROGRESO
                : currentCase.currentState,
            channel: Channel.WHATSAPP,
            actorRole: ActorRole.PATIENT,
            eventType: EventType.IDENTITY_LINKED,
            correlationId: params.correlationId,
            eventPayload: { via: "ai_nlu", contactUpdated: true },
          });
          currentCase = syncedContact.updatedCase;
        }
        return {
          ok: true,
          foundExistingWebAccount: false,
          message:
            "Guardamos tu dato de contacto. Cuando crees tu cuenta en la página web con este teléfono/correo, tus citas de WhatsApp se sincronizarán automáticamente.",
        };
      }

      let syncedCasesCount = 0;
      if (targetMaster.id !== currentCase.patientId) {
        const merged = await mergePatientProfiles({
          masterId: targetMaster.id,
          secondaryIds: [currentCase.patientId],
          channel: Channel.WHATSAPP,
        });
        syncedCasesCount = merged.syncedCasesCount;
        activePatient = merged.master;
      } else {
        activePatient = targetMaster;
      }

      if (params.whatsappLid) {
        await upsertIdentityLink(
          activePatient.id,
          IdentifierType.APP,
          formatLidIdentifier(params.whatsappLid),
          false
        );
      }

      currentCase = await prisma.serviceCase.findUniqueOrThrow({ where: { id: currentCase.id } });
      const syncedLink = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState:
          currentCase.currentState === CaseState.INICIADO
            ? CaseState.EN_PROGRESO
            : currentCase.currentState,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.IDENTITY_LINKED,
        correlationId: params.correlationId,
        eventPayload: {
          via: "ai_nlu",
          foundExistingWebAccount: true,
          syncedCasesCount,
        },
      });
      currentCase = syncedLink.updatedCase;
      switchedCaseId = currentCase.id;

      const linkedCases = await prisma.serviceCase.findMany({
        where: {
          OR: [{ patientId: activePatient.id }, { requesterPatientId: activePatient.id }],
        },
        orderBy: { updatedAt: "desc" },
        take: 8,
      });

      return {
        ok: true,
        foundExistingWebAccount: true,
        syncedCasesCount,
        patientFirstName: activePatient.firstName,
        totalCasesInAccount: linkedCases.length,
        cases: linkedCases.map((c) => {
          const cCtx = (c.contextJson ?? {}) as CaseContextJson;
          return {
            caseId: c.id,
            state: c.currentState,
            channel: c.currentChannel,
            study: cCtx.study?.name ?? null,
            clinic: cCtx.clinic?.name ?? null,
            folio: cCtx.appointment_folio ?? null,
          };
        }),
      };
    }

    if (name === "set_payment_method") {
      const pm = args.paymentMethod as PaymentMethod | undefined;
      if (pm !== "online" && pm !== "oxxo" && pm !== "clinic") {
        return { ok: false, error: "Forma de pago inválida. Usa: online, oxxo o clinic." };
      }
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
      const nextState =
        currentCase.currentState === CaseState.INICIADO
          ? CaseState.EN_PROGRESO
          : currentCase.currentState;
      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.CONTEXT_REHYDRATED,
        correlationId: params.correlationId,
        contextPatch: {
          payment_method: pm,
        },
        eventPayload: { paymentMethod: pm, via: "ai_nlu" },
      });
      currentCase = res.updatedCase;
      const basePrice = curCtx.study?.price ?? 0;
      const discount = pm === "online" ? Math.round(basePrice * 0.1) : 0;
      return {
        ok: true,
        paymentMethod: pm,
        paymentLabel: getPaymentMethodLabel(pm),
        subtotal: basePrice,
        discount,
        finalTotal: basePrice - discount,
        missingForConfirmation: getMissingConfirmationRequirements(
          (currentCase.contextJson ?? {}) as CaseContextJson,
          activePatient
        ),
      };
    }

    if (name === "pause_case_for_later") {
      const reason = String(args.reason || "PATIENT_PAUSED_VIA_WHATSAPP").trim();
      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState: CaseState.PAUSADO_PENDIENTE,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.FLOW_INTERRUPTED,
        correlationId: params.correlationId,
        eventPayload: { reason, via: "ai_nlu" },
      });
      currentCase = res.updatedCase;
      return {
        ok: true,
        state: currentCase.currentState,
        message: "Borrador guardado. El paciente puede continuar en Web, WhatsApp o Call Center.",
      };
    }

    if (name === "switch_or_create_case") {
      const action = String(args.action || "");

      if (action === "switch") {
        const targetId = String(args.targetCaseId || "").trim();
        const found = await prisma.serviceCase.findFirst({
          where: {
            id: targetId,
            OR: [{ requesterPatientId: params.holder.id }, { patientId: params.holder.id }],
          },
          include: { patient: true },
        });
        if (!found) {
          return { ok: false, error: "No se encontró el trámite solicitado para este titular." };
        }

        const targetCtx = (found.contextJson ?? {}) as CaseContextJson;
        const verifiedCh = targetCtx.otp_verified_channels ?? [];
        const targetIsThirdParty = found.patientId !== params.holder.id;
        const needsOtp =
          found.currentState !== CaseState.CITA_CONFIRMADA &&
          !verifiedCh.includes("WHATSAPP") &&
          (found.currentChannel !== Channel.WHATSAPP ||
            found.currentState === CaseState.PAUSADO_PENDIENTE ||
            targetIsThirdParty);

        currentCase = found;
        activePatient = found.patient;
        switchedCaseId = found.id;

        if (needsOtp) {
          await issueOtpChallenge({
            patient: found.patient,
            caseId: found.id,
            journeyId: found.journeyId,
            channel: Channel.WHATSAPP,
            correlationId: params.correlationId,
            destinationPhone: params.holder.phone,
          });
          return {
            ok: true,
            requiresOtpVerification: true,
            switchedToCaseId: found.id,
            message:
              "Se envió un código de verificación de 6 dígitos (Consola 2FA / SMS). Pide al paciente responder con ese código para desbloquear el trámite.",
          };
        }

        return {
          ok: true,
          requiresOtpVerification: false,
          switchedToCaseId: found.id,
          state: found.currentState,
          study: targetCtx.study ?? null,
          clinic: targetCtx.clinic ?? null,
          slot: targetCtx.preferred_slot ?? null,
          folio: targetCtx.appointment_folio ?? null,
          missingForConfirmation: getMissingConfirmationRequirements(targetCtx, activePatient),
        };
      }

      if (action === "new_self" || action === "pause_and_new" || action === "discard_and_new") {
        if (
          (action === "pause_and_new" || action === "discard_and_new") &&
          currentCase.currentState !== CaseState.CITA_CONFIRMADA
        ) {
          const isDiscard = action === "discard_and_new";
          await transitionServiceCase({
            caseId: currentCase.id,
            expectedVersion: currentCase.version,
            nextState: CaseState.PAUSADO_PENDIENTE,
            channel: Channel.WHATSAPP,
            actorRole: ActorRole.PATIENT,
            eventType: EventType.FLOW_INTERRUPTED,
            correlationId: params.correlationId,
            ...(isDiscard
              ? {
                  contextPatch: {
                    cancelled: true,
                    cancelled_reason: "ANULADA_POR_PACIENTE_PARA_NUEVA_CITA",
                  },
                }
              : {}),
            eventPayload: {
              via: "ai_nlu",
              reason: isDiscard
                ? "PATIENT_DISCARDED_CASE_FOR_NEW"
                : "PATIENT_PAUSED_CASE_FOR_NEW",
              cancelled: isDiscard,
            },
          });
        }

        const created = await prisma.serviceCase.create({
          data: {
            patientId: params.holder.id,
            requesterPatientId: params.holder.id,
            relationshipLabel: "Titular",
            thirdPartyConsent: false,
            currentState: CaseState.INICIADO,
            currentChannel: Channel.WHATSAPP,
            contextJson: { otp_verified_channels: ["WHATSAPP"] },
          },
        });
        await recordAndPublishEvent({
          caseId: created.id,
          patientId: params.holder.id,
          journeyId: created.journeyId,
          correlationId: params.correlationId,
          channel: Channel.WHATSAPP,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.SESSION_STARTED,
          prevState: null,
          nextState: CaseState.INICIADO,
          payload: { via: "ai_nlu", action },
        });
        currentCase = created;
        activePatient = await prisma.patient.findUnique({ where: { id: params.holder.id } });
        switchedCaseId = created.id;
        return {
          ok: true,
          action,
          previousCaseAction:
            action === "discard_and_new"
              ? "anulada"
              : action === "pause_and_new"
              ? "guardada_para_despues"
              : "ninguna",
          createdCaseId: created.id,
          state: created.currentState,
          missingForConfirmation: getMissingConfirmationRequirements({}, activePatient),
        };
      }

      if (action === "new_beneficiary") {
        if (!args.consentAccepted) {
          return {
            ok: false,
            error:
              "Debes confirmar que el titular cuenta con autorización del familiar/beneficiario antes de crear el trámite.",
          };
        }
        const bNom = String(args.beneficiaryNombres || "").trim();
        const bPat = String(args.beneficiaryApellidoPaterno || "").trim();
        const bMat = args.beneficiaryApellidoMaterno
          ? String(args.beneficiaryApellidoMaterno).trim()
          : undefined;
        const bBirth = args.beneficiaryFechaNacimiento
          ? String(args.beneficiaryFechaNacimiento).trim()
          : undefined;
        const bGen =
          args.beneficiaryGenero === "FEMENINO"
            ? Gender.FEMENINO
            : args.beneficiaryGenero === "MASCULINO"
            ? Gender.MASCULINO
            : undefined;
        const bStateObj = args.beneficiaryEstadoNacimiento
          ? resolveMexicanState(String(args.beneficiaryEstadoNacimiento))
          : null;
        const bState =
          bStateObj?.name ||
          (args.beneficiaryEstadoNacimiento
            ? String(args.beneficiaryEstadoNacimiento).trim()
            : undefined);

        if (bNom.length < 2 || bPat.length < 2) {
          return {
            ok: false,
            error: "Faltan nombre(s) y apellido paterno del familiar para registrar su expediente.",
          };
        }

        const beneficiaryCurp =
          rawCurpInMessage ||
          generateDeterministicCurpServer({
            firstName: bNom,
            paternalLastName: bPat,
            maternalLastName: bMat,
            birthDate: bBirth,
            gender: bGen,
            birthState: bState,
          });

        if (!beneficiaryCurp) {
          return {
            ok: false,
            error:
              "Para crear el expediente separado del familiar necesito también su fecha de nacimiento (YYYY-MM-DD), género (Mujer/Hombre) y estado de nacimiento (o que escriba su CURP) para generar su CURP de forma segura.",
          };
        }

        const fullHolder = await prisma.patient.findUniqueOrThrow({
          where: { id: params.holder.id },
        });
        const relEnum = (args.relationship as RelationshipType) || RelationshipType.FAMILIAR;
        const resolved = await resolveOrCreateBeneficiary({
          holder: fullHolder,
          relationship: relEnum,
          consentAccepted: true,
          beneficiary: {
            firstName: bNom,
            paternalLastName: bPat,
            maternalLastName: bMat,
            birthDate: bBirth,
            gender: bGen,
            birthState: bState,
            country: "MÉXICO",
            curp: beneficiaryCurp,
            phone: fullHolder.phone ?? undefined,
          },
        });

        const created = await prisma.serviceCase.create({
          data: {
            patientId: resolved.beneficiary.id,
            requesterPatientId: fullHolder.id,
            relationshipLabel: resolved.relationshipLabel,
            thirdPartyConsent: true,
            currentState: CaseState.INICIADO,
            currentChannel: Channel.WHATSAPP,
            contextJson: { otp_verified_channels: ["WHATSAPP"] },
          },
        });

        await recordAndPublishEvent({
          caseId: created.id,
          patientId: resolved.beneficiary.id,
          journeyId: created.journeyId,
          correlationId: params.correlationId,
          channel: Channel.WHATSAPP,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.SESSION_STARTED,
          prevState: null,
          nextState: CaseState.INICIADO,
          payload: {
            via: "ai_nlu",
            isThirdParty: true,
            relationshipLabel: resolved.relationshipLabel,
          },
        });

        currentCase = created;
        activePatient = resolved.beneficiary;
        switchedCaseId = created.id;

        return {
          ok: true,
          createdCaseId: created.id,
          beneficiary: maskPatientName(
            resolved.beneficiary.firstName,
            resolved.beneficiary.paternalLastName
          ),
          relationshipLabel: resolved.relationshipLabel,
          missingForConfirmation: getMissingConfirmationRequirements({}, activePatient),
        };
      }

      return { ok: false, error: "Acción de cambio/creación no soportada." };
    }

    if (name === "log_question_or_escalate") {
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
      return {
        ok: true,
        state: currentCase.currentState,
        escalatedToCallCenter: requestAdvisor,
        prepOfCurrentStudy: curCtx.study?.prep ?? null,
      };
    }

    if (name === "confirm_appointment") {
      let freshPatient = await prisma.patient.findUnique({ where: { id: currentCase.patientId } });

      // Si el modelo pasó datos básicos del paciente al confirmar, los guardamos primero en BD
      const confirmNames = splitFullNameIfNeeded(
        args.nombres ? String(args.nombres) : undefined,
        args.apellidoPaterno ? String(args.apellidoPaterno) : undefined,
        args.apellidoMaterno ? String(args.apellidoMaterno) : undefined
      );
      const normConfirmFirst = normalizePersonName(confirmNames.firstName);
      const normConfirmPat = normalizePersonName(confirmNames.paternalLastName);
      const normConfirmMat = normalizePersonName(confirmNames.maternalLastName);
      const confirmPhone =
        args.telefono && String(args.telefono).replace(/\D/g, "").length >= 10
          ? normalizePhone(String(args.telefono))
          : undefined;
      const confirmEmail = normalizeEmail(args.email ? String(args.email) : undefined);

      if (
        freshPatient &&
        (normConfirmFirst ||
          normConfirmPat ||
          normConfirmMat ||
          (confirmPhone && !freshPatient.phone) ||
          (confirmEmail && !freshPatient.email))
      ) {
        const patchPatient: Record<string, unknown> = {
          ...(normConfirmFirst ? { firstName: normConfirmFirst } : {}),
          ...(normConfirmPat ? { paternalLastName: normConfirmPat } : {}),
          ...(normConfirmMat ? { maternalLastName: normConfirmMat } : {}),
          ...(confirmPhone && !freshPatient.phone ? { phone: confirmPhone } : {}),
        };
        if (confirmEmail && !freshPatient.email) {
          const taken = await prisma.patient.findUnique({ where: { email: confirmEmail } });
          if (!taken) patchPatient.email = confirmEmail;
        }
        if (Object.keys(patchPatient).length > 0) {
          freshPatient = await prisma.patient.update({
            where: { id: freshPatient.id },
            data: patchPatient,
          });
          if (confirmPhone) {
            await upsertIdentityLink(freshPatient.id, IdentifierType.PHONE, confirmPhone, false);
          }
          if (confirmEmail && freshPatient.email === confirmEmail) {
            await upsertIdentityLink(freshPatient.id, IdentifierType.EMAIL, confirmEmail, false);
          }
        }
      }

      activePatient = freshPatient;
      const curCtx = (currentCase.contextJson ?? {}) as CaseContextJson;

      const effectiveStudy = args.studyCode
        ? findStudyByCode(String(args.studyCode)) ?? curCtx.study
        : curCtx.study;
      const effectiveClinic = args.clinicId
        ? findClinicById(String(args.clinicId)) ?? curCtx.clinic
        : curCtx.clinic;
      const effectivePayment =
        (args.paymentMethod as PaymentMethod | undefined) || curCtx.payment_method;
      const effectiveSlot =
        args.preferredDate && args.preferredTime
          ? { date: String(args.preferredDate), time: String(args.preferredTime) }
          : curCtx.preferred_slot;

      const mergedCheckCtx: CaseContextJson = {
        ...curCtx,
        ...(effectiveStudy
          ? {
              study: {
                code: effectiveStudy.code,
                name: effectiveStudy.name,
                price: effectiveStudy.price,
                prep: effectiveStudy.prep,
              },
            }
          : {}),
        ...(effectiveClinic
          ? {
              clinic: {
                id: effectiveClinic.id,
                name: effectiveClinic.name,
                city: effectiveClinic.city,
                address: effectiveClinic.address,
              },
            }
          : {}),
        ...(effectivePayment ? { payment_method: effectivePayment } : {}),
        ...(effectiveSlot ? { preferred_slot: effectiveSlot } : {}),
      };

      const missing = getMissingConfirmationRequirements(mergedCheckCtx, activePatient);
      if (missing.length > 0) {
        return {
          ok: false,
          error: "Faltan datos obligatorios antes de emitir el Folio y confirmar la cita.",
          missing,
          availableTimeSlots: AVAILABLE_TIME_SLOTS,
          paymentOptions: ["online (10% descuento)", "oxxo", "clinic"],
        };
      }

      const folio = `SD-2026-${crypto.randomInt(1000, 9999)}`;
      const qrPayload = `SALUDDIGNA|${folio}|${mergedCheckCtx.study!.code}|${mergedCheckCtx.clinic!.id}`;
      const basePrice = mergedCheckCtx.study!.price;
      const finalPrice =
        effectivePayment === "online" ? Math.round(basePrice * 0.9) : basePrice;

      const res = await transitionServiceCase({
        caseId: currentCase.id,
        expectedVersion: currentCase.version,
        nextState: CaseState.CITA_CONFIRMADA,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.APPOINTMENT_CONFIRMED,
        correlationId: params.correlationId,
        contextPatch: {
          study: mergedCheckCtx.study,
          clinic: mergedCheckCtx.clinic,
          payment_method: effectivePayment,
          preferred_slot: effectiveSlot,
          appointment_folio: folio,
          qr_payload: qrPayload,
        },
        eventPayload: {
          folio,
          paymentMethod: effectivePayment,
          finalPrice,
          confirmedVia: Channel.WHATSAPP,
          via: "ai_nlu",
        },
      });
      currentCase = res.updatedCase;
      confirmed = true;
      return {
        ok: true,
        state: currentCase.currentState,
        folio,
        qrPayload,
        study: mergedCheckCtx.study,
        clinic: mergedCheckCtx.clinic,
        preferredSlot: effectiveSlot,
        paymentMethod: effectivePayment,
        paymentLabel: getPaymentMethodLabel(effectivePayment),
        finalPrice,
      };
    }

    if (name === "edit_confirmed_appointment") {
      const targetId = args.caseId ? String(args.caseId).trim() : undefined;
      const targetFolio = args.folio ? String(args.folio).trim().toUpperCase() : undefined;

      const confirmedCases = await prisma.serviceCase.findMany({
        where: {
          OR: [{ requesterPatientId: params.holder.id }, { patientId: params.holder.id }],
          currentState: CaseState.CITA_CONFIRMADA,
        },
        include: {
          patient: { select: { firstName: true, paternalLastName: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
      });

      if (confirmedCases.length === 0) {
        return {
          ok: false,
          error: "No hay citas confirmadas registradas para este usuario todavía.",
        };
      }

      let targetCase = confirmedCases.find((c) => targetId && c.id === targetId);
      if (!targetCase && targetFolio) {
        targetCase = confirmedCases.find((c) => {
          const cCtx = (c.contextJson ?? {}) as CaseContextJson;
          return cCtx.appointment_folio?.toUpperCase() === targetFolio;
        });
      }
      if (!targetCase && currentCase.currentState === CaseState.CITA_CONFIRMADA) {
        targetCase = confirmedCases.find((c) => c.id === currentCase.id);
      }
      if (!targetCase && confirmedCases.length === 1) {
        targetCase = confirmedCases[0];
      }
      if (!targetCase) {
        return {
          ok: false,
          error: "El paciente tiene varias citas confirmadas. Pregunta qué folio desea modificar.",
          confirmedAppointments: confirmedCases.map((c) => {
            const cCtx = (c.contextJson ?? {}) as CaseContextJson;
            return {
              caseId: c.id,
              folio: cCtx.appointment_folio ?? null,
              study: cCtx.study?.name ?? null,
              clinic: cCtx.clinic?.name ?? null,
              slot: cCtx.preferred_slot ?? null,
            };
          }),
        };
      }

      const prevCtx = (targetCase.contextJson ?? {}) as CaseContextJson;
      const nextStudy = args.studyCode ? findStudyByCode(String(args.studyCode)) : undefined;
      const nextClinic = args.clinicId ? findClinicById(String(args.clinicId)) : undefined;
      const nextDate = args.preferredDate
        ? String(args.preferredDate).trim()
        : prevCtx.preferred_slot?.date;
      const nextTime = args.preferredTime
        ? String(args.preferredTime).trim()
        : prevCtx.preferred_slot?.time;
      const nextPayment =
        args.paymentMethod === "online" ||
        args.paymentMethod === "oxxo" ||
        args.paymentMethod === "clinic"
          ? (args.paymentMethod as PaymentMethod)
          : prevCtx.payment_method;

      if (!nextStudy && !nextClinic && !args.preferredDate && !args.preferredTime && !args.paymentMethod) {
        return {
          ok: false,
          error:
            "Indica al menos un cambio a aplicar (estudio, clínica, fecha, horario o forma de pago).",
          currentAppointment: {
            caseId: targetCase.id,
            folio: prevCtx.appointment_folio ?? null,
            study: prevCtx.study ?? null,
            clinic: prevCtx.clinic ?? null,
            preferredSlot: prevCtx.preferred_slot ?? null,
            paymentMethod: prevCtx.payment_method ?? null,
          },
        };
      }

      const effectiveStudy = nextStudy
        ? { code: nextStudy.code, name: nextStudy.name, price: nextStudy.price, prep: nextStudy.prep }
        : prevCtx.study;
      const effectiveClinic = nextClinic
        ? {
            id: nextClinic.id,
            name: nextClinic.name,
            city: nextClinic.city,
            address: nextClinic.address,
          }
        : prevCtx.clinic;
      const folio = prevCtx.appointment_folio || `SD-2026-${crypto.randomInt(1000, 9999)}`;
      const qrPayload = `SALUDDIGNA|${folio}|${effectiveStudy?.code ?? "EST"}|${effectiveClinic?.id ?? "CLN"}`;
      const basePrice = effectiveStudy?.price ?? 0;
      const finalPrice = nextPayment === "online" ? Math.round(basePrice * 0.9) : basePrice;

      const res = await transitionServiceCase({
        caseId: targetCase.id,
        expectedVersion: targetCase.version,
        nextState: CaseState.CITA_CONFIRMADA,
        channel: Channel.WHATSAPP,
        actorRole: ActorRole.PATIENT,
        eventType: EventType.CONTEXT_REHYDRATED,
        correlationId: params.correlationId,
        contextPatch: {
          ...(effectiveStudy ? { study: effectiveStudy } : {}),
          ...(effectiveClinic ? { clinic: effectiveClinic } : {}),
          ...(nextDate || nextTime
            ? {
                preferred_slot: {
                  date: nextDate || todayIso,
                  time: nextTime || "09:30",
                },
              }
            : {}),
          ...(nextPayment ? { payment_method: nextPayment } : {}),
          appointment_folio: folio,
          qr_payload: qrPayload,
        },
        eventPayload: {
          via: "ai_nlu",
          editedConfirmedAppointment: true,
          folio,
          changes: {
            ...(nextStudy ? { studyCode: nextStudy.code } : {}),
            ...(nextClinic ? { clinicId: nextClinic.id } : {}),
            ...(args.preferredDate ? { preferredDate: nextDate } : {}),
            ...(args.preferredTime ? { preferredTime: nextTime } : {}),
            ...(args.paymentMethod ? { paymentMethod: nextPayment } : {}),
          },
        },
      });

      if (targetCase.id === currentCase.id) {
        currentCase = res.updatedCase;
      }

      return {
        ok: true,
        edited: true,
        caseId: targetCase.id,
        folio,
        qrPayload,
        study: effectiveStudy ?? null,
        clinic: effectiveClinic ?? null,
        preferredSlot: nextDate || nextTime ? { date: nextDate || todayIso, time: nextTime || "09:30" } : null,
        paymentMethod: nextPayment ?? null,
        paymentLabel: getPaymentMethodLabel(nextPayment),
        finalPrice,
      };
    }

    return { ok: false, error: `Herramienta desconocida: ${name}` };
  };

  try {
    // Hasta 5 rondas de tool calling para completar flujos multipaso (cotizar + clínica + perfil + pago + confirmar)
    for (let round = 0; round < 5; round++) {
      const assistantMsg = await callOpenAi(messages, true);

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const directText = assistantMsg.content?.trim();
        if (!directText) return null;
        return { reply: directText, updatedCase: currentCase, confirmed, switchedCaseId };
      }

      messages.push({
        role: "assistant",
        content: assistantMsg.content ?? null,
        tool_calls: assistantMsg.tool_calls,
      });

      // Ordenar para que confirm_appointment siempre se ejecute después de tools que actualizan estudio/clínica/perfil/pago
      const orderedToolCalls = [...assistantMsg.tool_calls].sort((a, b) => {
        const prio = (fnName: string) => (fnName === "confirm_appointment" ? 100 : 10);
        return prio(a.function.name) - prio(b.function.name);
      });

      for (const tc of orderedToolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          args = {};
        }

        let toolOutput: Record<string, unknown>;
        try {
          toolOutput = await executeToolCall(tc.function.name, args);
        } catch (toolErr) {
          toolOutput = {
            ok: false,
            error: toolErr instanceof Error ? toolErr.message : "Error ejecutando herramienta",
          };
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(toolOutput),
        });
      }
    }

    // Pasada final para redactar la respuesta clara basada EXCLUSIVAMENTE en el estado real guardado en BD
    const finalCtx = (currentCase.contextJson ?? {}) as CaseContextJson;
    const finalMissing = getMissingConfirmationRequirements(finalCtx, activePatient);
    messages.push({
      role: "system",
      content:
        `ESTADO REAL VERIFICADO EN BASE DE DATOS TRAS LAS HERRAMIENTAS: ` +
        `estado=${currentCase.currentState}, folio=${finalCtx.appointment_folio ?? "NINGUNO"}, ` +
        `confirmada=${confirmed ? "SÍ" : "NO"}, faltantes=${finalMissing.length > 0 ? finalMissing.join(", ") : "ninguno"}. ` +
        `Responde al paciente reflejando ÚNICAMENTE este estado real (nunca afirmes que la cita quedó confirmada si confirmada=NO y folio=NINGUNO).`,
    });

    const finalReply = await callOpenAi(messages, false);
    const textOut = finalReply.content?.trim();
    if (!textOut) return null;

    return { reply: textOut, updatedCase: currentCase, confirmed, switchedCaseId };
  } catch (err) {
    console.warn(
      `[AI Assistant] Fallback automático al motor determinístico:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
