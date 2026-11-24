import crypto from "crypto";
import jwt from "jsonwebtoken";
import { IdentifierType, StaffRole } from "@prisma/client";
import { env } from "../config/env";

export interface StaffTokenPayload {
  sub: string;
  email: string;
  role: StaffRole;
  fullName: string;
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
    .update(value.trim().toLowerCase())
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
 * Valida la firma criptografica X-Hub-Signature-256 enviada por Meta WhatsApp Cloud API
 * sobre el rawBody exacto usando comparacion en tiempo constante (anti timing-attack).
 */
export function verifyMetaSignature(
  rawBody: string | Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const sigBuf = Buffer.from(signatureHeader, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export function signStaffJwt(payload: StaffTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
}

export function verifyStaffJwt(token: string): StaffTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as StaffTokenPayload;
}
