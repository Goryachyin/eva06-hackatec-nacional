import { MEXICAN_STATES } from "./curp";
import { CaseState, RelationshipType } from "../types/api";

export type WizardStep = 1 | 2 | 3;
export type PaymentMethod = "online" | "oxxo" | "clinic";

export const TIME_SLOTS = ["07:30", "08:30", "09:30", "10:30", "11:30", "13:00", "16:00"];

export const RELATIONSHIP_OPTIONS: Array<{ value: RelationshipType; label: string }> = [
  { value: "HIJO_A", label: "Hijo / Hija" },
  { value: "PADRE_MADRE", label: "Padre / Madre" },
  { value: "CONYUGE", label: "Esposo / Esposa (Cónyuge)" },
  { value: "ABUELO_A", label: "Abuelo / Abuela" },
  { value: "FAMILIAR", label: "Otro familiar" },
  { value: "CONOCIDO", label: "Conocido / Amigo" },
];

export interface BookingDraft {
  caseId: string;
  webSessionId?: string;
  step: WizardStep;
  selectedStudyCode?: string;
  selectedClinicId?: string;
  preferredDate?: string;
  preferredTime?: string;
  forThirdParty?: boolean;
  relationship?: RelationshipType;
  thirdPartyConsent?: boolean;
  nombres?: string;
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  fechaNacimiento?: string;
  genero?: "FEMENINO" | "MASCULINO" | "";
  estadoNacimientoCode?: string;
  pais?: string;
  curp?: string;
  telefono?: string;
  paymentMethod?: PaymentMethod;
  advisorNotes?: string;
  updatedAt: string;
  updatedByChannel: "WEB" | "CALL_CENTER";
}

const BOOKING_DRAFTS_KEY = "sd_omnicanal_booking_drafts_v1";

export function getDefaultTomorrowIso(): string {
  const tomorrow = new Date(Date.now() + 86400000);
  return tomorrow.toISOString().slice(0, 10);
}

export function findStateCodeByNameOrCode(val: string | null | undefined): string {
  if (!val) return "";
  const clean = val
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
  const match = MEXICAN_STATES.find(
    (st) =>
      st.code === clean ||
      st.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase() === clean
  );
  return match?.code || "";
}

/**
 * Extrae fecha de nacimiento, género y estado de nacimiento de una CURP de 18 caracteres.
 */
export function parseCurpMetadata(curp: string | null | undefined): {
  fechaNacimiento: string;
  genero: "FEMENINO" | "MASCULINO" | "";
  estadoNacimientoCode: string;
} {
  const empty = { fechaNacimiento: "", genero: "" as const, estadoNacimientoCode: "" };
  if (!curp) return empty;
  const clean = curp.trim().toUpperCase();
  if (clean.length !== 18) return empty;

  const yy = clean.slice(4, 6);
  const mm = clean.slice(6, 8);
  const dd = clean.slice(8, 10);
  const sexChar = clean[10];
  const state2 = clean.slice(11, 13);
  const centuryChar = clean[16];

  let fechaNacimiento = "";
  if (/^\d{2}$/.test(yy) && /^\d{2}$/.test(mm) && /^\d{2}$/.test(dd)) {
    const century = /[A-Z]/.test(centuryChar) ? "20" : "19";
    fechaNacimiento = `${century}${yy}-${mm}-${dd}`;
  }

  const genero: "FEMENINO" | "MASCULINO" | "" =
    sexChar === "M" ? "FEMENINO" : sexChar === "H" ? "MASCULINO" : "";

  const estadoNacimientoCode = findStateCodeByNameOrCode(state2);

  return { fechaNacimiento, genero, estadoNacimientoCode };
}

export function getPreparationSteps(prepText: string): string[] {
  const parts = prepText
    .split(/\.|;/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;
  return [
    prepText.trim(),
    "Presentar identificación oficial vigente y folio de cita en recepción 15 minutos antes.",
  ];
}

export function normalizedPhoneForSubmit(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+52${digits}`;
  if (digits.startsWith("52") && digits.length >= 12) return `+${digits}`;
  return raw.trim();
}

export function formatDateDisplay(isoDate: string): string {
  if (!isoDate) return "dd/mm/aaaa";
  const parts = isoDate.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate;
}

function readAllDrafts(): Record<string, BookingDraft> {
  try {
    const raw = localStorage.getItem(BOOKING_DRAFTS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, BookingDraft>;
  } catch {
    return {};
  }
}

export function getBookingDraft(caseId: string | null | undefined): BookingDraft | null {
  if (!caseId) return null;
  const all = readAllDrafts();
  return all[caseId] || null;
}

export function saveBookingDraft(draft: BookingDraft): void {
  if (!draft.caseId) return;
  try {
    const all = readAllDrafts();
    all[draft.caseId] = draft;
    localStorage.setItem(BOOKING_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // Ignorar cuotas de almacenamiento
  }
}

export function clearBookingDraft(caseId: string | null | undefined): void {
  if (!caseId) return;
  try {
    const all = readAllDrafts();
    if (all[caseId]) {
      delete all[caseId];
      localStorage.setItem(BOOKING_DRAFTS_KEY, JSON.stringify(all));
    }
  } catch {
    // Ignorar
  }
}

/**
 * Determina el paso exacto donde se quedó el paciente para continuar sin fricción
 * entre Sitio Web, WhatsApp y Call Center.
 */
export function inferResumeStep(params: {
  currentState?: CaseState;
  hasStudy: boolean;
  hasClinic: boolean;
  hasCompleteProfile: boolean;
  hasFolio: boolean;
  draft?: BookingDraft | null;
}): WizardStep {
  if (params.currentState === "CITA_CONFIRMADA" || params.hasFolio) {
    return 3;
  }
  if (!params.hasStudy || !params.hasClinic) {
    return 1;
  }
  if (!params.hasCompleteProfile) {
    return 2;
  }
  if (params.draft?.step === 1 || params.draft?.step === 2) {
    return params.draft.step;
  }
  return 3;
}
