import { ActorRole, Channel, EventType, Gender, IdentifierType, Patient } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import {
  generateOtp6,
  hashIdentifier,
  hashOtp,
  maskIdentifier,
  maskPatientName,
  normalizePhone,
} from "../lib/crypto";
import { recordAndPublishEvent } from "./eventBus";

export interface RegisterPatientInput {
  firstName?: string;
  paternalLastName?: string;
  maternalLastName?: string;
  birthDate?: string;
  gender?: Gender;
  birthState?: string;
  country?: string;
  curp?: string;
  phone?: string;
  email?: string;
  webSessionId?: string;
}

const OTP_KEY = (patientId: string) => `otp:challenge:${patientId}`;
const OTP_OUTBOX_KEY = "demo:otp:outbox";

export interface OtpChallengeRecord {
  otpHash: string;
  caseId: string;
  journeyId: string;
  channel: Channel;
  attempts: number;
  createdAt: string;
}

export interface OutboxOtpEntry {
  patientId: string;
  patientMasked: string;
  destinationMasked: string;
  code: string;
  channel: Channel;
  caseId: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Vincula un identificador (PHONE, EMAIL, CURP, WEB_SESSION, APP) a un paciente
 * almacenando siempre hash HMAC y mascara PII.
 */
export async function upsertIdentityLink(
  patientId: string,
  identifierType: IdentifierType,
  rawValue: string,
  verified = false
) {
  const normalized =
    identifierType === IdentifierType.PHONE
      ? normalizePhone(rawValue)
      : rawValue.trim().toUpperCase();

  const identifierHash = hashIdentifier(normalized);
  const identifierMasked = maskIdentifier(identifierType, normalized);

  return prisma.identityLink.upsert({
    where: {
      uq_identity_type_hash: {
        identifierType,
        identifierHash,
      },
    },
    update: {
      patientId,
      verified: verified ? true : undefined,
      verifiedAt: verified ? new Date() : undefined,
    },
    create: {
      patientId,
      identifierType,
      identifierHash,
      identifierMasked,
      verified,
      verifiedAt: verified ? new Date() : null,
    },
  });
}

/**
 * Busca un paciente por cualquier identificador soportado (Identity Resolution).
 */
export async function findPatientByIdentifier(
  identifierType: IdentifierType,
  rawValue: string
): Promise<Patient | null> {
  const normalized =
    identifierType === IdentifierType.PHONE
      ? normalizePhone(rawValue)
      : rawValue.trim().toUpperCase();

  const identifierHash = hashIdentifier(normalized);

  const link = await prisma.identityLink.findUnique({
    where: {
      uq_identity_type_hash: {
        identifierType,
        identifierHash,
      },
    },
    include: { patient: true },
  });

  if (link?.patient) return link.patient;

  // Respaldo directo en tabla patients si vino por phone o curp
  if (identifierType === IdentifierType.PHONE) {
    return prisma.patient.findUnique({ where: { phone: normalized } });
  }
  if (identifierType === IdentifierType.CURP) {
    return prisma.patient.findUnique({ where: { curp: normalized } });
  }
  return null;
}

/**
 * Identity Stitching progresivo: busca por CURP -> PHONE -> WEB_SESSION -> EMAIL;
 * si existe, enriquece el perfil faltante; si no existe, crea el registro maestro.
 */
export async function resolveOrCreatePatient(input: RegisterPatientInput): Promise<Patient> {
  const normalizedPhone = input.phone ? normalizePhone(input.phone) : undefined;
  const normalizedCurp = input.curp ? input.curp.trim().toUpperCase() : undefined;

  let patient: Patient | null = null;

  if (normalizedCurp) {
    patient = await findPatientByIdentifier(IdentifierType.CURP, normalizedCurp);
  }
  if (!patient && normalizedPhone) {
    patient = await findPatientByIdentifier(IdentifierType.PHONE, normalizedPhone);
  }
  if (!patient && input.webSessionId) {
    patient = await findPatientByIdentifier(IdentifierType.WEB_SESSION, input.webSessionId);
  }
  if (!patient && input.email) {
    patient = await findPatientByIdentifier(IdentifierType.EMAIL, input.email);
  }

  const profileData = {
    ...(input.firstName ? { firstName: input.firstName.trim() } : {}),
    ...(input.paternalLastName ? { paternalLastName: input.paternalLastName.trim() } : {}),
    ...(input.maternalLastName ? { maternalLastName: input.maternalLastName.trim() } : {}),
    ...(input.birthDate ? { birthDate: new Date(input.birthDate) } : {}),
    ...(input.gender ? { gender: input.gender } : {}),
    ...(input.birthState ? { birthState: input.birthState.trim() } : {}),
    ...(input.country ? { country: input.country.trim() } : {}),
    ...(normalizedCurp ? { curp: normalizedCurp } : {}),
    ...(normalizedPhone ? { phone: normalizedPhone } : {}),
  };

  if (!patient) {
    patient = await prisma.patient.create({
      data: profileData,
    });
  } else if (Object.keys(profileData).length > 0) {
    patient = await prisma.patient.update({
      where: { id: patient.id },
      data: profileData,
    });
  }

  // Vincular todos los identificadores proporcionados
  if (normalizedPhone) {
    await upsertIdentityLink(patient.id, IdentifierType.PHONE, normalizedPhone, false);
  }
  if (normalizedCurp) {
    await upsertIdentityLink(patient.id, IdentifierType.CURP, normalizedCurp, false);
  }
  if (input.email) {
    await upsertIdentityLink(patient.id, IdentifierType.EMAIL, input.email, false);
  }
  if (input.webSessionId) {
    await upsertIdentityLink(patient.id, IdentifierType.WEB_SESSION, input.webSessionId, false);
  }

  return patient;
}

/**
 * Emite un reto Step-Up OTP en Redis con TTL (300s por defecto).
 * El codigo NUNCA se devuelve en la respuesta del canal solicitante:
 * se deposita en la Consola 2FA externa (/otp-2fa) para demostrar 2FA out-of-band.
 */
export async function issueOtpChallenge(params: {
  patient: Patient;
  caseId: string;
  journeyId: string;
  channel: Channel;
  correlationId?: string;
}) {
  const code = generateOtp6();
  const otpHash = hashOtp(params.patient.id, code);
  const ttl = env.OTP_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  const record: OtpChallengeRecord = {
    otpHash,
    caseId: params.caseId,
    journeyId: params.journeyId,
    channel: params.channel,
    attempts: 0,
    createdAt: now.toISOString(),
  };

  await redis.set(OTP_KEY(params.patient.id), JSON.stringify(record), "EX", ttl);

  // Bandeja externa simulada de SMS/Correo (Consola 2FA independiente)
  const outboxEntry: OutboxOtpEntry = {
    patientId: params.patient.id,
    patientMasked: maskPatientName(params.patient.firstName, params.patient.paternalLastName),
    destinationMasked: params.patient.phone
      ? maskIdentifier(IdentifierType.PHONE, params.patient.phone)
      : "***-***-****",
    code,
    channel: params.channel,
    caseId: params.caseId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await redis.hset(OTP_OUTBOX_KEY, params.patient.id, JSON.stringify(outboxEntry));

  await recordAndPublishEvent({
    caseId: params.caseId,
    patientId: params.patient.id,
    journeyId: params.journeyId,
    correlationId: params.correlationId,
    channel: Channel.SYSTEM,
    actorRole: ActorRole.SYSTEM,
    eventType: EventType.OTP_CHALLENGE_SENT,
    payload: {
      targetChannel: params.channel,
      ttlSeconds: ttl,
      destinationMasked: outboxEntry.destinationMasked,
    },
  });

  return { expiresAt: expiresAt.toISOString(), ttlSeconds: ttl };
}

/**
 * Verifica el codigo OTP en Redis.
 * Si falla o expira, audita obligatoriamente OTP_VALIDATION_FAILED en journey_events.
 */
export async function verifyOtpChallenge(params: {
  patientId: string;
  caseId: string;
  journeyId: string;
  channel: Channel;
  code: string;
  correlationId?: string;
}): Promise<{ ok: boolean; reason?: string; attemptsRemaining?: number }> {
  const raw = await redis.get(OTP_KEY(params.patientId));

  if (!raw) {
    await recordAndPublishEvent({
      caseId: params.caseId,
      patientId: params.patientId,
      journeyId: params.journeyId,
      correlationId: params.correlationId,
      channel: params.channel,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.OTP_VALIDATION_FAILED,
      payload: { reason: "OTP_EXPIRED_OR_NOT_FOUND" },
    });
    return { ok: false, reason: "El código OTP expiró o no existe. Solicita uno nuevo." };
  }

  const record = JSON.parse(raw) as OtpChallengeRecord;
  const candidateHash = hashOtp(params.patientId, params.code);

  if (candidateHash !== record.otpHash) {
    const nextAttempts = record.attempts + 1;
    const remaining = Math.max(0, env.OTP_MAX_ATTEMPTS - nextAttempts);

    if (nextAttempts >= env.OTP_MAX_ATTEMPTS) {
      await redis.del(OTP_KEY(params.patientId));
      await redis.hdel(OTP_OUTBOX_KEY, params.patientId);
    } else {
      const ttlLeft = await redis.ttl(OTP_KEY(params.patientId));
      await redis.set(
        OTP_KEY(params.patientId),
        JSON.stringify({ ...record, attempts: nextAttempts }),
        "EX",
        Math.max(10, ttlLeft)
      );
    }

    await recordAndPublishEvent({
      caseId: params.caseId,
      patientId: params.patientId,
      journeyId: params.journeyId,
      correlationId: params.correlationId,
      channel: params.channel,
      actorRole: ActorRole.PATIENT,
      eventType: EventType.OTP_VALIDATION_FAILED,
      payload: {
        reason: remaining === 0 ? "MAX_ATTEMPTS_EXCEEDED" : "INVALID_CODE",
        attempts: nextAttempts,
        attemptsRemaining: remaining,
      },
    });

    return {
      ok: false,
      reason:
        remaining === 0
          ? "Máximo de intentos excedido. El reto OTP fue revocado por seguridad."
          : `Código OTP incorrecto. Intentos restantes: ${remaining}.`,
      attemptsRemaining: remaining,
    };
  }

  // OTP valido: consumir reto inmediatamente (single-use)
  await redis.del(OTP_KEY(params.patientId));
  await redis.hdel(OTP_OUTBOX_KEY, params.patientId);

  await prisma.identityLink.updateMany({
    where: { patientId: params.patientId, identifierType: IdentifierType.PHONE },
    data: { verified: true, verifiedAt: new Date() },
  });

  await recordAndPublishEvent({
    caseId: params.caseId,
    patientId: params.patientId,
    journeyId: params.journeyId,
    correlationId: params.correlationId,
    channel: params.channel,
    actorRole: ActorRole.PATIENT,
    eventType: EventType.IDENTITY_VERIFIED_OTP,
    payload: { verifiedChannel: params.channel },
  });

  return { ok: true };
}

/**
 * Devuelve los codigos OTP activos para la Consola 2FA externa (/otp-2fa).
 */
export async function listActiveOtpOutbox(): Promise<Array<OutboxOtpEntry & { ttlSeconds: number }>> {
  const all = await redis.hgetall(OTP_OUTBOX_KEY);
  const results: Array<OutboxOtpEntry & { ttlSeconds: number }> = [];

  for (const [patientId, raw] of Object.entries(all)) {
    const ttl = await redis.ttl(OTP_KEY(patientId));
    if (ttl <= 0) {
      await redis.hdel(OTP_OUTBOX_KEY, patientId);
      continue;
    }
    const parsed = JSON.parse(raw) as OutboxOtpEntry;
    results.push({ ...parsed, ttlSeconds: ttl });
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
