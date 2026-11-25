export type CaseState =
  | "INICIADO"
  | "COTIZANDO"
  | "CLINICA_ELEGIDA"
  | "PAUSADO_PENDIENTE"
  | "EN_PROGRESO"
  | "DUDAS_ABIERTAS"
  | "EN_ATENCION_ASESOR"
  | "CITA_CONFIRMADA";

export type Channel = "WEB" | "WHATSAPP" | "CALL_CENTER" | "APP" | "SYSTEM";

export type StaffRole = "ADMIN" | "ASESOR";

export type Gender = "MASCULINO" | "FEMENINO" | "OTRO" | "NO_ESPECIFICADO";

export type RelationshipType =
  | "SELF"
  | "HIJO_A"
  | "PADRE_MADRE"
  | "CONYUGE"
  | "ABUELO_A"
  | "FAMILIAR"
  | "CONOCIDO";

export interface StudyItem {
  code: string;
  name: string;
  category: string;
  price: number;
  prep: string;
}

export interface ClinicItem {
  id: string;
  name: string;
  city: string;
  address: string;
  hours: string;
}

export interface CaseContextJson {
  study?: {
    code: string;
    name: string;
    price: number;
    prep: string;
  };
  clinic?: {
    id: string;
    name: string;
    city?: string;
    address?: string;
  };
  preferred_slot?: {
    date: string;
    time: string;
  };
  open_questions?: string[];
  appointment_folio?: string | null;
  qr_payload?: string | null;
  otp_verified_channels?: string[];
  handoff_summary?: string;
}

export interface ServiceCase {
  id: string;
  journeyId: string;
  patientId: string;
  currentState: CaseState;
  currentChannel: Channel;
  contextJson: CaseContextJson;
  assignedAdvisorId?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface JourneyEventItem {
  id: string;
  caseId: string;
  patientId: string;
  journeyId: string;
  correlationId: string;
  channel: Channel;
  actorRole: string;
  eventType: string;
  prevState: CaseState | null;
  nextState: CaseState | null;
  payloadJson?: Record<string, unknown>;
  createdAt: string;
}

export interface IdentityLinkSummary {
  identifierType: string;
  identifierMasked: string;
  verified: boolean;
}

export interface AdminSanitizedCase {
  id: string;
  journeyId: string;
  patientMasked: string;
  requesterMasked?: string | null;
  isThirdParty?: boolean;
  relationshipLabel?: string;
  identities: IdentityLinkSummary[];
  currentState: CaseState;
  currentChannel: Channel;
  version: number;
  eventsCount: number;
  contextSummary: CaseContextJson;
  updatedAt: string;
}

export interface QueueCounts {
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
}

export interface AdminOverviewResponse {
  kpis: {
    totalCases: number;
    confirmedAppointments: number;
    recoveredAbandonedFlows: number;
    otpFailedAttemptsAudited: number;
    totalEventsRecorded: number;
    activeSseSubscribers: number;
  };
  queues: {
    whatsappInbound: QueueCounts;
    whatsappDlq: QueueCounts;
  };
  cases: AdminSanitizedCase[];
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  postgres: string;
  redis: string;
  queues: {
    whatsappInbound?: QueueCounts;
    whatsappDlq?: QueueCounts;
  };
}

export interface StaffUser {
  id: string;
  email: string;
  fullName: string;
  role: StaffRole;
}

export interface LoginResponse {
  token: string;
  user: StaffUser;
}

export interface CallCenterCaseItem extends ServiceCase {
  patient: {
    id: string;
    firstName: string | null;
    paternalLastName: string | null;
    maternalLastName: string | null;
    phone: string | null;
    curp: string | null;
    birthState: string | null;
  };
  assignedAdvisor: {
    id: string;
    fullName: string;
    email: string;
  } | null;
  journeyEvents: JourneyEventItem[];
}

export interface OtpInboxItem {
  patientId: string;
  patientMasked: string;
  destinationMasked: string;
  code: string;
  channel: string;
  caseId?: string;
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
}

export interface WhatsAppChatMessage {
  id?: string;
  direction: "inbound" | "outbound";
  text: string;
  timestamp: string;
  wamid?: string;
}

export interface PatientProfile {
  id: string;
  nombres: string | null;
  apellido_paterno: string | null;
  apellido_materno: string | null;
  fecha_nacimiento: string | null;
  genero: Gender | null;
  estado_nacimiento: string | null;
  pais: string | null;
  curp: string | null;
  telefono: string | null;
  email: string | null;
  createdAt?: string;
}

export interface PatientAuthResponse {
  token: string;
  patient: PatientProfile;
  syncedCasesCount?: number;
}

export interface PatientBeneficiaryItem {
  relationshipId: string;
  relationship: RelationshipType;
  relationshipLabel: string;
  beneficiaryId: string;
  nombres: string | null;
  apellido_paterno: string | null;
  apellido_materno: string | null;
  fecha_nacimiento: string | null;
  genero: Gender | null;
  estado_nacimiento: string | null;
  pais: string | null;
  curpMasked: string | null;
  curp: string | null;
}

export interface PatientCaseWithEvents extends ServiceCase {
  isThirdParty?: boolean;
  beneficiaryDisplay?: string;
  relationshipLabel?: string;
  privacyNotice?: string | null;
  journeyEvents?: JourneyEventItem[];
}

export interface PatientMeResponse {
  patient: PatientProfile;
  beneficiaries?: PatientBeneficiaryItem[];
  cases: PatientCaseWithEvents[];
  syncedCasesCount?: number;
}

export interface AdminUserLookupItem {
  patientId: string;
  patientMasked: string;
  hasAccount: boolean;
  birthState: string | null;
  createdAt: string;
  identities: Array<IdentityLinkSummary & { verifiedAt?: string | null }>;
  cases: Array<{
    id: string;
    journeyId: string;
    currentState: CaseState;
    currentChannel: Channel;
    version: number;
    isThirdParty?: boolean;
    relationshipLabel?: string;
    beneficiaryMasked?: string;
    requesterMasked?: string | null;
    contextSummary: CaseContextJson;
    updatedAt: string;
    events: JourneyEventItem[];
  }>;
}

export interface AdminUserLookupResponse {
  count: number;
  results: AdminUserLookupItem[];
}
