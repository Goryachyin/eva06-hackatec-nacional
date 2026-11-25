import {
  AdminOverviewResponse,
  AdminUserLookupResponse,
  CallCenterCaseItem,
  ClinicItem,
  HealthResponse,
  JourneyEventItem,
  LoginResponse,
  OtpInboxItem,
  PatientAuthResponse,
  PatientMeResponse,
  PatientProfile,
  ServiceCase,
  StaffRole,
  StaffUser,
  StudyItem,
  WhatsAppChatMessage,
} from "../types/api";

export const LOCAL_API_URL = "http://localhost:3000";
export const AWS_API_URL = "https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws";

const API_BASE_STORAGE_KEY = "sd_omnicanal_api_url";
const LAST_PHONE_STORAGE_KEY = "sd_omnicanal_last_phone";
const WEB_SESSION_STORAGE_KEY = "sd_omnicanal_web_session";

export function getApiBaseUrl(): string {
  const saved = localStorage.getItem(API_BASE_STORAGE_KEY);
  if (saved) return saved.replace(/\/+$/, "");
  const envUrl = import.meta.env.VITE_API_URL as string | undefined;
  return (envUrl || LOCAL_API_URL).replace(/\/+$/, "");
}

export function setApiBaseUrl(url: string): void {
  localStorage.setItem(API_BASE_STORAGE_KEY, url.replace(/\/+$/, ""));
}

export function getLastPatientPhone(): string {
  return localStorage.getItem(LAST_PHONE_STORAGE_KEY) || "+526670000001";
}

export function setLastPatientPhone(phone: string): void {
  localStorage.setItem(LAST_PHONE_STORAGE_KEY, phone);
}

export function getOrCreateWebSessionId(): string {
  let sid = localStorage.getItem(WEB_SESSION_STORAGE_KEY);
  if (!sid) {
    sid = `web_${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(WEB_SESSION_STORAGE_KEY, sid);
  }
  return sid;
}

// Almacenamiento separado de JWT por rol para poder usar Admin y Call Center sin colisiones
export function getStaffToken(role: StaffRole): string | null {
  return localStorage.getItem(`sd_token_${role}`);
}

export function getStaffUser(role: StaffRole): StaffUser | null {
  const raw = localStorage.getItem(`sd_user_${role}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StaffUser;
  } catch {
    return null;
  }
}

export function saveStaffSession(role: StaffRole, data: LoginResponse): void {
  localStorage.setItem(`sd_token_${role}`, data.token);
  localStorage.setItem(`sd_user_${role}`, JSON.stringify(data.user));
}

export function clearStaffSession(role: StaffRole): void {
  localStorage.removeItem(`sd_token_${role}`);
  localStorage.removeItem(`sd_user_${role}`);
}

// Almacenamiento de sesión de cuenta de paciente (Portal Público)
export function getPatientToken(): string | null {
  return localStorage.getItem("sd_patient_token");
}

export function getStoredPatient(): PatientProfile | null {
  const raw = localStorage.getItem("sd_patient_profile");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PatientProfile;
  } catch {
    return null;
  }
}

export function savePatientSession(data: PatientAuthResponse): void {
  localStorage.setItem("sd_patient_token", data.token);
  localStorage.setItem("sd_patient_profile", JSON.stringify(data.patient));
  if (data.patient.telefono) {
    setLastPatientPhone(data.patient.telefono);
  }
  if (typeof data.syncedCasesCount === "number" && data.syncedCasesCount > 0) {
    sessionStorage.setItem("sd_patient_synced_cases_count", String(data.syncedCasesCount));
  }
  window.dispatchEvent(new Event("sd-patient-auth-change"));
}

export function consumeLastSyncedCasesCount(): number {
  const raw = sessionStorage.getItem("sd_patient_synced_cases_count");
  if (!raw) return 0;
  sessionStorage.removeItem("sd_patient_synced_cases_count");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function clearPatientSession(): void {
  localStorage.removeItem("sd_patient_token");
  localStorage.removeItem("sd_patient_profile");
  window.dispatchEvent(new Event("sd-patient-auth-change"));
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const { token, headers, ...rest } = options;
  const url = `${getApiBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { message: text };
    }
  }

  if (!res.ok) {
    const msg =
      (json.message as string) ||
      (json.error as string) ||
      `Error HTTP ${res.status} al consultar ${path}`;
    throw new ApiError(res.status, msg, json.error as string | undefined);
  }

  return json as T;
}

export const api = {
  getHealth: () => request<HealthResponse>("/health"),

  getCatalog: () =>
    request<{ studies: StudyItem[]; clinics: ClinicItem[] }>("/api/catalog"),

  login: (email: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  // Canal 1: Sitio Web
  registerWebPatient: (payload: {
    nombres?: string;
    apellido_paterno?: string;
    apellido_materno?: string;
    fecha_nacimiento?: string;
    genero?: string;
    estado_nacimiento?: string;
    pais?: string;
    curp?: string;
    telefono?: string;
    email?: string;
    webSessionId?: string;
  }) =>
    request<{ patient: { id: string }; webSessionId: string }>("/api/channels/web/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  quoteWebStudy: (payload: {
    caseId?: string;
    expectedVersion?: number;
    webSessionId?: string;
    telefono?: string;
    curp?: string;
    nombres?: string;
    apellido_paterno?: string;
    studyCode: string;
    clinicId?: string;
    preferredSlot?: { date: string; time: string };
    forThirdParty?: boolean;
    relationship?: string;
    thirdPartyConsent?: boolean;
    beneficiary?: {
      nombres: string;
      apellido_paterno: string;
      apellido_materno?: string;
      fecha_nacimiento?: string;
      genero?: string;
      estado_nacimiento?: string;
      pais?: string;
      curp: string;
    };
  }) =>
    request<{
      case: ServiceCase;
      patientId: string;
      requesterPatientId?: string;
      isThirdParty?: boolean;
      relationshipLabel?: string;
      webSessionId: string;
      correlationId: string;
    }>("/api/channels/web/quote", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  resumeWebCase: (caseId: string) =>
    request<{ case: ServiceCase; correlationId?: string; alreadyConfirmed?: boolean }>(
      `/api/channels/web/cases/${caseId}/resume`,
      { method: "POST" }
    ),

  confirmWebCase: (
    caseId: string,
    payload: { expectedVersion: number; paymentMethod: "online" | "oxxo" | "clinic" }
  ) =>
    request<{ case: ServiceCase; folio: string; qrPayload: string; correlationId: string }>(
      `/api/channels/web/cases/${caseId}/confirm`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  getWhatsAppGatewayStatus: () =>
    request<{ connectedGateways: number; transport: string }>("/api/gateways/whatsapp/status"),

  abandonWebCase: (payload: {
    caseId: string;
    expectedVersion: number;
    reason?: string;
  }) =>
    request<{ case: ServiceCase; correlationId: string }>("/api/channels/web/abandon", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  lookupWebCase: (params: { telefono?: string; curp?: string; webSessionId?: string }) => {
    const qs = new URLSearchParams();
    if (params.telefono) qs.set("telefono", params.telefono);
    if (params.curp) qs.set("curp", params.curp);
    if (params.webSessionId) qs.set("webSessionId", params.webSessionId);
    return request<{
      patient: {
        id: string;
        nombres: string | null;
        apellido_paterno: string | null;
        apellido_materno: string | null;
        telefono: string | null;
      };
      case: ServiceCase | null;
    }>(`/api/channels/web/case?${qs.toString()}`);
  },

  // Canal 2: Simulador WhatsApp
  simulateWhatsApp: (payload: { fromPhone: string; text: string; wamid?: string }) =>
    request<{
      duplicate: boolean;
      wamid: string;
      correlationId?: string;
      reply?: string;
      message?: string;
      history?: WhatsAppChatMessage[];
    }>("/api/channels/whatsapp/simulate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getWhatsAppHistory: (phone: string) =>
    request<{ phone: string; history: WhatsAppChatMessage[] }>(
      `/api/channels/whatsapp/history/${encodeURIComponent(phone)}`
    ),

  // Seguridad Step-Up OTP (Consola 2FA externa)
  getOtpInbox: () =>
    request<{ count: number; items: OtpInboxItem[] }>("/api/otp-2fa/inbox"),

  // Canal 3: Call Center
  getCallCenterQueue: (token: string) =>
    request<{ count: number; cases: CallCenterCaseItem[] }>("/api/call-center/queue", {
      token,
    }),

  assignCallCenterCase: (token: string, caseId: string, expectedVersion: number) =>
    request<{ case: ServiceCase; correlationId: string }>(
      `/api/call-center/cases/${caseId}/assign`,
      {
        method: "POST",
        token,
        body: JSON.stringify({ expectedVersion }),
      }
    ),

  confirmCallCenterCase: (
    token: string,
    caseId: string,
    payload: {
      expectedVersion: number;
      preferredDate?: string;
      preferredTime?: string;
      advisorNotes?: string;
    }
  ) =>
    request<{
      case: ServiceCase;
      folio: string;
      qrPayload: string;
      correlationId: string;
    }>(`/api/call-center/cases/${caseId}/confirm`, {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),

  // Cuenta de Paciente (Portal Público)
  registerPatientAccount: (payload: {
    nombres: string;
    apellido_paterno: string;
    apellido_materno?: string;
    fecha_nacimiento: string;
    genero: string;
    estado_nacimiento: string;
    pais: string;
    curp: string;
    telefono: string;
    email: string;
    password: string;
    webSessionId?: string;
  }) =>
    request<PatientAuthResponse>("/api/patients/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  loginPatientAccount: (identifier: string, password: string) =>
    request<PatientAuthResponse>("/api/patients/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    }),

  getPatientMe: (token: string) =>
    request<PatientMeResponse>("/api/patients/me", { token }),

  requestChannelLink: (token: string, payload: { phone?: string; folio?: string }) =>
    request<{
      ok: boolean;
      message: string;
      casesFound?: number;
      destinationMasked?: string;
      ttlSeconds?: number;
    }>("/api/patients/me/link-channel/request", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),

  verifyChannelLink: (token: string, otpCode: string) =>
    request<{
      ok: boolean;
      message: string;
      syncedCasesCount?: number;
    }>("/api/patients/me/link-channel/verify", {
      method: "POST",
      token,
      body: JSON.stringify({ otpCode }),
    }),

  // Rol Administrador (Observabilidad)
  getAdminOverview: (token: string) =>
    request<AdminOverviewResponse>("/api/admin/overview", { token }),

  lookupAdminUsers: (token: string, q: string) =>
    request<AdminUserLookupResponse>(
      `/api/admin/users/lookup?q=${encodeURIComponent(q)}`,
      { token }
    ),

  getCaseTimeline: (token: string, caseId: string) =>
    request<{ caseId: string; count: number; events: JourneyEventItem[] }>(
      `/api/admin/cases/${caseId}/timeline`,
      { token }
    ),

  resetDemo: (token: string) =>
    request<{ status: string; message: string }>("/api/admin/reset-demo", {
      method: "POST",
      token,
    }),
};
