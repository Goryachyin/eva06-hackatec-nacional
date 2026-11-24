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
    badgeClass: string;
    barColor: string;
    dotColor: string;
  }
> = {
  INICIADO: {
    label: "Iniciado",
    shortLabel: "Iniciado",
    badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
    barColor: "#64748B",
    dotColor: "bg-slate-500",
  },
  COTIZANDO: {
    label: "Cotizando",
    shortLabel: "Cotizando",
    badgeClass: "bg-sky-50 text-sky-700 border-sky-200",
    barColor: "#0284C7",
    dotColor: "bg-sky-500",
  },
  CLINICA_ELEGIDA: {
    label: "Clínica elegida",
    shortLabel: "Clínica",
    badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
    barColor: "#4F46E5",
    dotColor: "bg-indigo-500",
  },
  PAUSADO_PENDIENTE: {
    label: "Pausado / Pendiente",
    shortLabel: "Pausado",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
    barColor: "#D97706",
    dotColor: "bg-amber-500",
  },
  EN_PROGRESO: {
    label: "En progreso",
    shortLabel: "En progreso",
    badgeClass: "bg-cyan-50 text-cyan-800 border-cyan-200",
    barColor: "#0891B2",
    dotColor: "bg-cyan-500",
  },
  DUDAS_ABIERTAS: {
    label: "Dudas abiertas",
    shortLabel: "Dudas",
    badgeClass: "bg-orange-50 text-orange-800 border-orange-200",
    barColor: "#EA580C",
    dotColor: "bg-orange-500",
  },
  EN_ATENCION_ASESOR: {
    label: "En atención asesor",
    shortLabel: "Asesor",
    badgeClass: "bg-violet-50 text-violet-800 border-violet-200",
    barColor: "#7C3AED",
    dotColor: "bg-violet-500",
  },
  CITA_CONFIRMADA: {
    label: "Cita confirmada",
    shortLabel: "Confirmada",
    badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
    barColor: "#00843D",
    dotColor: "bg-[#00843D]",
  },
};

export const CHANNEL_META: Record<
  Channel,
  {
    label: string;
    color: string;
    badgeClass: string;
  }
> = {
  WEB: {
    label: "Sitio Web",
    color: "#0066B3",
    badgeClass: "bg-blue-50 text-[#0066B3] border-blue-200",
  },
  WHATSAPP: {
    label: "WhatsApp",
    color: "#16A34A",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  CALL_CENTER: {
    label: "Call Center",
    color: "#7C3AED",
    badgeClass: "bg-violet-50 text-violet-700 border-violet-200",
  },
  APP: {
    label: "App Móvil",
    color: "#0EA5E9",
    badgeClass: "bg-sky-50 text-sky-700 border-sky-200",
  },
  SYSTEM: {
    label: "Sistema",
    color: "#64748B",
    badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

export const EVENT_TYPE_LABELS: Record<string, { label: string; tone: string }> = {
  SESSION_STARTED: { label: "Sesión iniciada", tone: "text-slate-700 bg-slate-100" },
  IDENTITY_LINKED: { label: "Identidad vinculada", tone: "text-blue-700 bg-blue-50" },
  STUDY_QUOTED: { label: "Estudio cotizado", tone: "text-sky-700 bg-sky-50" },
  CLINIC_SELECTED: { label: "Clínica seleccionada", tone: "text-indigo-700 bg-indigo-50" },
  FLOW_INTERRUPTED: { label: "Abandono / Pausa", tone: "text-amber-800 bg-amber-50" },
  CHANNEL_SWITCH_DETECTED: { label: "Salto de canal detectado", tone: "text-cyan-800 bg-cyan-50" },
  OTP_CHALLENGE_SENT: { label: "OTP Step-Up enviado", tone: "text-purple-700 bg-purple-50" },
  OTP_VALIDATION_FAILED: { label: "OTP fallido (Auditado)", tone: "text-rose-700 bg-rose-50" },
  IDENTITY_VERIFIED_OTP: { label: "OTP verificado", tone: "text-emerald-700 bg-emerald-50" },
  CONTEXT_REHYDRATED: { label: "Contexto rehidratado", tone: "text-teal-800 bg-teal-50" },
  PATIENT_QUESTION_LOGGED: { label: "Duda registrada", tone: "text-orange-800 bg-orange-50" },
  ADVISOR_ASSIGNED: { label: "Asesor asignado (Screen-Pop)", tone: "text-violet-800 bg-violet-50" },
  APPOINTMENT_CONFIRMED: { label: "Cita confirmada", tone: "text-emerald-800 bg-emerald-100" },
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
