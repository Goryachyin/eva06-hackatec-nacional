import crypto from "crypto";
import jwt from "jsonwebtoken";
import { IdentifierType, StaffRole } from "@prisma/client";
import { env } from "../config/env";

export interface StaffTokenPayload {
  sub: string;
  email: string;
  role: StaffRole;
  fullName: string;
  scope?: "STAFF";
}

export interface PatientTokenPayload {
  sub: string;
  email: string;
  scope: "PATIENT";
}

/**
 * Elimina acentos/diacríticos y colapsa espacios repetidos para comparación/normalización canónica.
 */
export function stripAccents(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza nombres y apellidos a MAYÚSCULAS sin acentos (estándar clínico / RENAPO)
 * para evitar divergencias en la vinculación omnicanal inteligente.
 */
export function normalizePersonName(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const clean = stripAccents(raw).toUpperCase();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Normaliza estados o países a MAYÚSCULAS sin acentos.
 */
export function normalizePlaceName(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const clean = stripAccents(raw).toUpperCase();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Normaliza correos electrónicos a minúsculas sin acentos ni espacios laterales.
 */
export function normalizeEmail(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const clean = stripAccents(raw).replace(/\s+/g, "").toLowerCase();
  return clean.includes("@") ? clean : undefined;
}

/**
 * Normaliza CURP a MAYÚSCULAS sin espacios ni acentos.
 */
export function normalizeCurp(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const clean = stripAccents(raw).replace(/\s+/g, "").toUpperCase();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Normaliza un numero telefonico a formato E.164 basico (Mexico por defecto si son 10 digitos).
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+52${digits}`;
  if (digits.startsWith("521") && digits.length === 13) return `+52${digits.slice(3)}`;
  if (digits.startsWith("52") && digits.length === 12) return `+${digits}`;
  return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

export function hashIdentifier(value: string): string {
  return crypto
    .createHmac("sha256", env.PII_HASH_PEPPER)
    .update(stripAccents(value).toLowerCase())
    .digest("hex");
}

export function maskIdentifier(type: IdentifierType, value: string): string {
  const v = value.trim();
  switch (type) {
    case IdentifierType.PHONE: {
      const digits = v.replace(/\D/g, "");
      return `***-***-${digits.slice(-4)}`;
    }
    case IdentifierType.EMAIL: {
      const [user, domain = "***"] = v.split("@");
      return `${user.slice(0, 2)}***@${domain}`;
    }
    case IdentifierType.CURP:
      return `${v.slice(0, 4)}**********${v.slice(-4)}`;
    case IdentifierType.WEB_SESSION:
    case IdentifierType.APP:
    default:
      return `${v.slice(0, 4)}****${v.slice(-4)}`;
  }
}

export function maskPatientName(
  firstName?: string | null,
  paternalLastName?: string | null
): string {
  const first = firstName?.trim() || "Paciente";
  const pat = paternalLastName?.trim();
  if (!pat) return `${first} ****`;
  return `${first} ${pat[0]}****`;
}

export function generateOtp6(): string {
  const num = crypto.randomInt(100000, 1000000);
  return String(num);
}

export function hashOtp(patientId: string, otp: string): string {
  return crypto
    .createHmac("sha256", env.PII_HASH_PEPPER)
    .update(`${patientId}:${otp.trim()}`)
    .digest("hex");
}

/**
 * Genera firma digital HMAC-SHA256 extremo a extremo sobre "<timestamp>.<payload>"
 * utilizada bidireccionalmente entre el Gateway Baileys local y el Orquestador AWS.
 */
export function signGatewayPayload(
  timestamp: string,
  payload: string | Buffer,
  secret: string
): string {
  const bodyStr = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${bodyStr}`)
    .digest("hex");
  return `v1=${mac}`;
}

/**
 * Valida la firma digital HMAC-SHA256 y la ventana temporal anti-replay (por defecto 300s)
 * usando comparacion en tiempo constante (crypto.timingSafeEqual).
 */
export function verifyGatewaySignature(params: {
  rawBody: string | Buffer | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  maxSkewSeconds?: number;
}): { ok: boolean; reason?: string } {
  const { rawBody, signatureHeader, timestampHeader, secret, maxSkewSeconds = 300 } = params;

  if (!secret) return { ok: false, reason: "WHATSAPP_GATEWAY_SECRET no configurado." };
  if (rawBody === undefined || !signatureHeader || !timestampHeader) {
    return {
      ok: false,
      reason: "Faltan cabeceras criptográficas X-Gateway-Signature o X-Gateway-Timestamp.",
    };
  }
  if (!signatureHeader.startsWith("v1=")) {
    return { ok: false, reason: "Formato de firma inválido (se requiere prefijo v1=)." };
  }

  const tsNum = Number(timestampHeader);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "Timestamp criptográfico inválido." };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > maxSkewSeconds) {
    return { ok: false, reason: "Firma expirada (fuera de ventana anti-replay)." };
  }

  const expected = signGatewayPayload(timestampHeader, rawBody, secret);
  const sigBuf = Buffer.from(signatureHeader, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: "Firma digital HMAC-SHA256 inválida." };
  }

  const match = crypto.timingSafeEqual(sigBuf, expBuf);
  return match ? { ok: true } : { ok: false, reason: "Firma digital HMAC-SHA256 inválida." };
}

export function signStaffJwt(payload: StaffTokenPayload): string {
  return jwt.sign({ ...payload, scope: "STAFF" }, env.JWT_SECRET, { expiresIn: "12h" });
}

export function verifyStaffJwt(token: string): StaffTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as StaffTokenPayload;
  if (decoded.scope === ("PATIENT" as unknown)) {
    throw new Error("Token de paciente no autorizado para endpoints de staff.");
  }
  return decoded;
}

export function signPatientJwt(payload: Omit<PatientTokenPayload, "scope">): string {
  return jwt.sign({ ...payload, scope: "PATIENT" }, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyPatientJwt(token: string): PatientTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as PatientTokenPayload;
  if (decoded.scope !== "PATIENT") {
    throw new Error("Token inválido para cuenta de paciente.");
  }
  return decoded;
}
