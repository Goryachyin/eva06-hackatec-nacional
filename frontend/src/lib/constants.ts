import { CaseState, Channel } from "../types/api";

export const CANONICAL_STATES: CaseState[] = [
  "INICIADO",
  "COTIZANDO",
  "CLINICA_ELEGIDA",
  "PAUSADO_PENDIENTE",
  "EN_PROGRESO",
  "DUDAS_ABIERTAS",
  "EN_ATENCION_ASESOR",
  "CITA_CONFIRMADA",
];

export const STATE_META: Record<
  CaseState,
  {
    label: string;
    shortLabel: string;
    textClass: string;
    barColor: string;
  }
> = {
  INICIADO: {
    label: "Iniciado",
    shortLabel: "Iniciado",
    textClass: "text-[#52606D]",
    barColor: "#7B8794",
  },
  COTIZANDO: {
    label: "Cotizando",
    shortLabel: "Cotizando",
    textClass: "text-[#1F2933]",
    barColor: "#52606D",
  },
  CLINICA_ELEGIDA: {
    label: "Clínica elegida",
    shortLabel: "Clínica",
    textClass: "text-[#00875A]",
    barColor: "#00875A",
  },
  PAUSADO_PENDIENTE: {
    label: "Pausado / Pendiente",
    shortLabel: "Pausado",
    textClass: "text-[#52606D]",
    barColor: "#52606D",
  },
  EN_PROGRESO: {
    label: "En progreso",
    shortLabel: "En progreso",
    textClass: "text-[#00875A]",
    barColor: "#00875A",
  },
  DUDAS_ABIERTAS: {
    label: "Dudas abiertas",
    shortLabel: "Dudas",
    textClass: "text-[#1F2933]",
    barColor: "#3E4C59",
  },
  EN_ATENCION_ASESOR: {
    label: "En atención asesor",
    shortLabel: "Asesor",
    textClass: "text-[#1F2933]",
    barColor: "#3E4C59",
  },
  CITA_CONFIRMADA: {
    label: "Cita confirmada",
    shortLabel: "Confirmada",
    textClass: "text-[#00875A]",
    barColor: "#00875A",
  },
};

export const CHANNEL_META: Record<
  Channel,
  {
    label: string;
    color: string;
    textClass: string;
  }
> = {
  WEB: {
    label: "Sitio Web",
    color: "#1F2933",
    textClass: "text-[#1F2933]",
  },
  WHATSAPP: {
    label: "WhatsApp",
    color: "#00875A",
    textClass: "text-[#00875A]",
  },
  CALL_CENTER: {
    label: "Call Center",
    color: "#52606D",
    textClass: "text-[#52606D]",
  },
  APP: {
    label: "App Móvil",
    color: "#7B8794",
    textClass: "text-[#52606D]",
  },
  SYSTEM: {
    label: "Sistema",
    color: "#9AA5B1",
    textClass: "text-[#52606D]",
  },
};

export const EVENT_TYPE_LABELS: Record<string, { label: string; tone: string }> = {
  SESSION_STARTED: { label: "Sesión iniciada", tone: "text-[#52606D]" },
  IDENTITY_LINKED: { label: "Identidad vinculada", tone: "text-[#1F2933]" },
  STUDY_QUOTED: { label: "Estudio cotizado", tone: "text-[#1F2933]" },
  CLINIC_SELECTED: { label: "Clínica seleccionada", tone: "text-[#00875A]" },
  FLOW_INTERRUPTED: { label: "Abandono / Pausa", tone: "text-[#52606D]" },
  CHANNEL_SWITCH_DETECTED: { label: "Salto de canal detectado", tone: "text-[#1F2933]" },
  OTP_CHALLENGE_SENT: { label: "OTP Step-Up enviado", tone: "text-[#1F2933]" },
  OTP_VALIDATION_FAILED: { label: "OTP fallido (Auditado)", tone: "text-[#B42318]" },
  IDENTITY_VERIFIED_OTP: { label: "OTP verificado", tone: "text-[#00875A]" },
  CONTEXT_REHYDRATED: { label: "Contexto rehidratado", tone: "text-[#00875A]" },
  PATIENT_QUESTION_LOGGED: { label: "Duda registrada", tone: "text-[#1F2933]" },
  ADVISOR_ASSIGNED: { label: "Asesor asignado (Screen-Pop)", tone: "text-[#1F2933]" },
  APPOINTMENT_CONFIRMED: { label: "Cita confirmada", tone: "text-[#00875A]" },
};

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatTimeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-MX", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
