import {
  ActorRole,
  Channel,
  EventType,
  Gender,
  IdentifierType,
  Patient,
  RelationshipType,
} from "@prisma/client";
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

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  SELF: "Titular",
  HIJO_A: "Hijo/a",
  PADRE_MADRE: "Padre / Madre",
  CONYUGE: "Cónyuge",
  ABUELO_A: "Abuelo/a",
  FAMILIAR: "Familiar",
  CONOCIDO: "Conocido",
};

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
  whatsappLid?: string;
}

const OTP_KEY = (patientId: string) => `otp:challenge:${patientId}`;
const OTP_OUTBOX_KEY = "demo:otp:outbox";
const CHANNEL_LINK_OTP_KEY = (patientId: string) => `otp:channel_link:${patientId}`;

export interface OtpChallengeRecord {
  otpHash: string;
  caseId: string;
  journeyId: string;
  channel: Channel;
  attempts: number;
  createdAt: string;
}

export interface ChannelLinkOtpRecord {
  otpHash: string;
  targetPatientIds: string[];
  targetCaseIds: string[];
  phone?: string;
  folio?: string;
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

export function formatLidIdentifier(rawLid: string): string {
  const digits = rawLid.replace(/\D/g, "");
  return `LID:${digits || rawLid.trim().toUpperCase()}`;
}

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

  if (identifierType === IdentifierType.PHONE) {
    return prisma.patient.findFirst({
      where: { phone: normalized },
      orderBy: [{ passwordHash: "asc" }, { createdAt: "asc" }],
    });
  }
  if (identifierType === IdentifierType.CURP) {
    return prisma.patient.findUnique({ where: { curp: normalized } });
  }
  if (identifierType === IdentifierType.EMAIL) {
    return prisma.patient.findUnique({ where: { email: rawValue.trim().toLowerCase() } });
  }
  return null;
}

/**
 * Determina si dos expedientes Patient son compatibles para fusionarse (mismo titular).
 * Protege estrictamente la arquitectura Multibeneficiario (LFPDPPP):
 * NUNCA fusiona dos pacientes que tengan CURPs distintas ni dos cuentas con contraseñas distintas.
 */
function canSafelyMergePatients(primary: Patient, candidate: Patient): boolean {
  if (primary.id === candidate.id) return false;
  if (primary.passwordHash && candidate.passwordHash) return false;
  if (
    primary.curp &&
    candidate.curp &&
    primary.curp.trim().toUpperCase() !== candidate.curp.trim().toUpperCase()
  ) {
    return false;
  }
  return true;
}

/**
 * Elige el expediente canónico maestro entre varios candidatos compatibles:
 * Prioridad: (1) Cuenta web con passwordHash -> (2) Tiene CURP -> (3) Más antiguo.
 */
function pickCanonicalMaster(candidates: Patient[]): Patient {
  return [...candidates].sort((a, b) => {
    const aHasPass = a.passwordHash ? 1 : 0;
    const bHasPass = b.passwordHash ? 1 : 0;
    if (aHasPass !== bHasPass) return bHasPass - aHasPass;

    const aHasCurp = a.curp ? 1 : 0;
    const bHasCurp = b.curp ? 1 : 0;
    if (aHasCurp !== bHasCurp) return bHasCurp - aHasCurp;

    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

/**
 * Motor transaccional de fusión de expedientes (Smart Identity Stitching & Merge).
 * Reasigna service_cases, journey_events, identity_links y patient_relationships
 * de uno o más registros sombra (WhatsApp / Call Center / Invitado Web) al expediente maestro.
 */
export async function mergePatientProfiles(params: {
  masterId: string;
  secondaryIds: string[];
  channel?: Channel;
}): Promise<{
  master: Patient;
  mergedPatientIds: string[];
  syncedCasesCount: number;
}> {
  const uniqueSecondaries = Array.from(
    new Set(params.secondaryIds.filter((id) => id && id !== params.masterId))
  );

  const initialMaster = await prisma.patient.findUniqueOrThrow({
    where: { id: params.masterId },
  });

  if (uniqueSecondaries.length === 0) {
    return { master: initialMaster, mergedPatientIds: [], syncedCasesCount: 0 };
  }

  const secondaryRows = await prisma.patient.findMany({
    where: { id: { in: uniqueSecondaries } },
  });

  const safeSecondaries = secondaryRows.filter((sec) =>
    canSafelyMergePatients(initialMaster, sec)
  );

  if (safeSecondaries.length === 0) {
    return { master: initialMaster, mergedPatientIds: [], syncedCasesCount: 0 };
  }

  const safeIds = safeSecondaries.map((s) => s.id);

  const result = await prisma.$transaction(async (tx) => {
    const master = await tx.patient.findUniqueOrThrow({ where: { id: params.masterId } });
    let syncedCasesCount = 0;

    // 1. Contar y reasignar todos los trámites (propios y solicitados) hacia el expediente maestro
    const affectedCases = await tx.serviceCase.findMany({
      where: {
        OR: [{ patientId: { in: safeIds } }, { requesterPatientId: { in: safeIds } }],
      },
      select: { id: true, patientId: true, requesterPatientId: true },
    });
    syncedCasesCount = affectedCases.length;

    await tx.serviceCase.updateMany({
      where: { patientId: { in: safeIds } },
      data: { patientId: master.id },
    });

    await tx.serviceCase.updateMany({
      where: { requesterPatientId: { in: safeIds } },
      data: { requesterPatientId: master.id },
    });

    // 2. Reasignar línea de tiempo inmutable de eventos
    await tx.journeyEvent.updateMany({
      where: { patientId: { in: safeIds } },
      data: { patientId: master.id },
    });

    // 3. Consolidar identity_links evitando duplicados en uq_identity_type_hash
    const masterLinks = await tx.identityLink.findMany({
      where: { patientId: master.id },
      select: { identifierType: true, identifierHash: true },
    });
    const masterLinkSet = new Set(
      masterLinks.map((l) => `${l.identifierType}:${l.identifierHash}`)
    );

    const secondaryLinks = await tx.identityLink.findMany({
      where: { patientId: { in: safeIds } },
    });

    for (const link of secondaryLinks) {
      const key = `${link.identifierType}:${link.identifierHash}`;
      if (masterLinkSet.has(key)) {
        await tx.identityLink.delete({ where: { id: link.id } });
      } else {
        await tx.identityLink.update({
          where: { id: link.id },
          data: { patientId: master.id },
        });
        masterLinkSet.add(key);
      }
    }

    // 4. Consolidar relaciones familiares (sin duplicar ni crear auto-relaciones)
    const secRels = await tx.patientRelationship.findMany({
      where: {
        OR: [{ holderPatientId: { in: safeIds } }, { beneficiaryPatientId: { in: safeIds } }],
      },
    });

    for (const rel of secRels) {
      const nextHolderId = safeIds.includes(rel.holderPatientId)
        ? master.id
        : rel.holderPatientId;
      const nextBeneficiaryId = safeIds.includes(rel.beneficiaryPatientId)
        ? master.id
        : rel.beneficiaryPatientId;

      if (nextHolderId === nextBeneficiaryId) {
        await tx.patientRelationship.delete({ where: { id: rel.id } });
        continue;
      }

      const duplicate = await tx.patientRelationship.findUnique({
        where: {
          uq_holder_beneficiary: {
            holderPatientId: nextHolderId,
            beneficiaryPatientId: nextBeneficiaryId,
          },
        },
      });

      if (duplicate && duplicate.id !== rel.id) {
        await tx.patientRelationship.delete({ where: { id: rel.id } });
      } else {
        await tx.patientRelationship.update({
          where: { id: rel.id },
          data: {
            holderPatientId: nextHolderId,
            beneficiaryPatientId: nextBeneficiaryId,
          },
        });
      }
    }

    // 5. Completar campos faltantes en el maestro con datos útiles de los registros sombra
    const backfill: Record<string, unknown> = {};
    for (const sec of safeSecondaries) {
      if (!master.firstName && !backfill.firstName && sec.firstName) {
        backfill.firstName = sec.firstName;
      }
      if (!master.paternalLastName && !backfill.paternalLastName && sec.paternalLastName) {
        backfill.paternalLastName = sec.paternalLastName;
      }
      if (!master.maternalLastName && !backfill.maternalLastName && sec.maternalLastName) {
        backfill.maternalLastName = sec.maternalLastName;
      }
      if (!master.birthDate && !backfill.birthDate && sec.birthDate) {
        backfill.birthDate = sec.birthDate;
      }
      if (!master.gender && !backfill.gender && sec.gender) {
        backfill.gender = sec.gender;
      }
      if (!master.birthState && !backfill.birthState && sec.birthState) {
        backfill.birthState = sec.birthState;
      }
      if (!master.phone && !backfill.phone && sec.phone) {
        backfill.phone = sec.phone;
      }
      if (!master.curp && !backfill.curp && sec.curp) {
        backfill.curp = sec.curp;
      }
      if (!master.email && !backfill.email && sec.email) {
        backfill.email = sec.email;
      }
    }

    // 6. Eliminar registros sombra (antes de aplicar curp/email únicos al maestro)
    await tx.patient.deleteMany({
      where: { id: { in: safeIds } },
    });

    const updatedMaster =
      Object.keys(backfill).length > 0
        ? await tx.patient.update({
            where: { id: master.id },
            data: backfill,
          })
        : master;

    return {
      master: updatedMaster,
      mergedPatientIds: safeIds,
      syncedCasesCount,
    };
  });

  // 7. Publicar evento de vinculación en el trámite más reciente para refrescar SSE en vivo
  if (result.syncedCasesCount > 0) {
    const latestCase = await prisma.serviceCase.findFirst({
      where: { OR: [{ patientId: result.master.id }, { requesterPatientId: result.master.id }] },
      orderBy: { updatedAt: "desc" },
    });
    if (latestCase) {
      await recordAndPublishEvent({
        caseId: latestCase.id,
        patientId: result.master.id,
        journeyId: latestCase.journeyId,
        channel: params.channel ?? Channel.SYSTEM,
        actorRole: ActorRole.SYSTEM,
        eventType: EventType.IDENTITY_LINKED,
        payload: {
          smartMerge: true,
          mergedPatientCount: result.mergedPatientIds.length,
          syncedCasesCount: result.syncedCasesCount,
        },
      }).catch(() => {});
    }
  }

  return result;
}

/**
 * Busca todos los registros Patient coincidentes con un conjunto de identificadores
 * (CURP, teléfono, correo, sesión web o WhatsApp LID) sin detenerse en el primero.
 */
async function findAllCandidatePatients(input: {
  curp?: string;
  phone?: string;
  email?: string;
  webSessionId?: string;
  whatsappLid?: string;
}): Promise<Patient[]> {
  const byId = new Map<string, Patient>();

  const add = (p: Patient | null | undefined) => {
    if (p) byId.set(p.id, p);
  };

  if (input.curp) {
    add(await findPatientByIdentifier(IdentifierType.CURP, input.curp));
  }

  if (input.phone) {
    const normalizedPhone = normalizePhone(input.phone);
    add(await findPatientByIdentifier(IdentifierType.PHONE, normalizedPhone));
    // Buscar TODOS los Patient que compartan ese teléfono (incluyendo registros sombra de WhatsApp/Call Center)
    const phoneMatches = await prisma.patient.findMany({
      where: { phone: normalizedPhone },
      orderBy: { createdAt: "asc" },
      take: 15,
    });
    for (const pm of phoneMatches) add(pm);
  }

  if (input.email) {
    add(await findPatientByIdentifier(IdentifierType.EMAIL, input.email.trim().toLowerCase()));
  }

  if (input.webSessionId) {
    add(await findPatientByIdentifier(IdentifierType.WEB_SESSION, input.webSessionId));
  }

  if (input.whatsappLid) {
    add(await findPatientByIdentifier(IdentifierType.APP, formatLidIdentifier(input.whatsappLid)));
  }

  return Array.from(byId.values());
}

/**
 * Reconcilia de forma inteligente cualquier expediente sombra (creado en WhatsApp,
 * Call Center o sesión invitada Web) que comparta teléfono, CURP o correo con el paciente maestro.
 * Respeta estrictamente la separación de familiares con CURP distinta.
 */
export async function reconcilePatientOmnichannelHistory(
  masterPatientId: string,
  extra?: { webSessionId?: string; whatsappLid?: string; channel?: Channel }
): Promise<{
  patient: Patient;
  mergedPatientIds: string[];
  syncedCasesCount: number;
}> {
  const master = await prisma.patient.findUnique({ where: { id: masterPatientId } });
  if (!master) {
    throw new Error(`Paciente no encontrado: ${masterPatientId}`);
  }

  const candidates = await findAllCandidatePatients({
    curp: master.curp ?? undefined,
    phone: master.phone ?? undefined,
    email: master.email ?? undefined,
    webSessionId: extra?.webSessionId,
    whatsappLid: extra?.whatsappLid,
  });

  const compatibleSecondaryIds = candidates
    .filter((c) => canSafelyMergePatients(master, c))
    .map((c) => c.id);

  if (compatibleSecondaryIds.length === 0) {
    return { patient: master, mergedPatientIds: [], syncedCasesCount: 0 };
  }

  const merged = await mergePatientProfiles({
    masterId: master.id,
    secondaryIds: compatibleSecondaryIds,
    channel: extra?.channel ?? Channel.SYSTEM,
  });

  return {
    patient: merged.master,
    mergedPatientIds: merged.mergedPatientIds,
    syncedCasesCount: merged.syncedCasesCount,
  };
}

/**
 * Identity Stitching progresivo y Vinculación Inteligente para el Titular de la cuenta/teléfono.
 * - Si detecta múltiples registros del mismo titular (ej. WhatsApp + Web o Call Center + Web),
 *   los fusiona automáticamente en un solo expediente maestro sin perder trámites ni eventos.
 * - Respeta expedientes separados cuando existe una CURP diferente (familiares/terceros).
 */
export async function resolveOrCreatePatient(input: RegisterPatientInput): Promise<Patient> {
  const normalizedPhone = input.phone ? normalizePhone(input.phone) : undefined;
  const normalizedCurp = input.curp ? input.curp.trim().toUpperCase() : undefined;
  const normalizedEmail = input.email ? input.email.trim().toLowerCase() : undefined;

  const allCandidates = await findAllCandidatePatients({
    curp: normalizedCurp,
    phone: normalizedPhone,
    email: normalizedEmail,
    webSessionId: input.webSessionId,
    whatsappLid: input.whatsappLid,
  });

  // Filtrar candidatos compatibles con la CURP proporcionada (para nunca mezclar un familiar distinto)
  const compatibleCandidates = allCandidates.filter((c) => {
    if (
      normalizedCurp &&
      c.curp &&
      c.curp.trim().toUpperCase() !== normalizedCurp
    ) {
      return false;
    }
    return true;
  });

  let patient: Patient | null = null;

  if (compatibleCandidates.length > 0) {
    const master = pickCanonicalMaster(compatibleCandidates);
    const secondaries = compatibleCandidates
      .filter((c) => canSafelyMergePatients(master, c))
      .map((c) => c.id);

    if (secondaries.length > 0) {
      const merged = await mergePatientProfiles({
        masterId: master.id,
        secondaryIds: secondaries,
        channel: input.whatsappLid ? Channel.WHATSAPP : Channel.WEB,
      });
      patient = merged.master;
    } else {
      patient = master;
    }
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

  if (normalizedPhone) {
    await upsertIdentityLink(patient.id, IdentifierType.PHONE, normalizedPhone, false);
  }
  if (normalizedCurp) {
    await upsertIdentityLink(patient.id, IdentifierType.CURP, normalizedCurp, false);
  }
  if (normalizedEmail) {
    await upsertIdentityLink(patient.id, IdentifierType.EMAIL, normalizedEmail, false);
  }
  if (input.webSessionId) {
    await upsertIdentityLink(patient.id, IdentifierType.WEB_SESSION, input.webSessionId, false);
  }
  if (input.whatsappLid) {
    await upsertIdentityLink(
      patient.id,
      IdentifierType.APP,
      formatLidIdentifier(input.whatsappLid),
      false
    );
  }

  return patient;
}

/**
 * Resuelve o crea un expediente clinico INDEPENDIENTE para un Beneficiario (familiar/conocido)
 * sin sobreescribir nunca los datos ni la identidad PHONE del Titular.
 */
export async function resolveOrCreateBeneficiary(params: {
  holder: Patient;
  relationship: RelationshipType;
  consentAccepted: boolean;
  beneficiary: {
    firstName: string;
    paternalLastName: string;
    maternalLastName?: string;
    birthDate?: string;
    gender?: Gender;
    birthState?: string;
    country?: string;
    curp: string;
    phone?: string;
  };
}): Promise<{ beneficiary: Patient; relationshipLabel: string }> {
  const cleanCurp = params.beneficiary.curp.trim().toUpperCase();
  const contactPhone = params.beneficiary.phone
    ? normalizePhone(params.beneficiary.phone)
    : params.holder.phone ?? undefined;

  let beneficiary = await findPatientByIdentifier(IdentifierType.CURP, cleanCurp);

  const profileData = {
    firstName: params.beneficiary.firstName.trim(),
    paternalLastName: params.beneficiary.paternalLastName.trim(),
    ...(params.beneficiary.maternalLastName
      ? { maternalLastName: params.beneficiary.maternalLastName.trim() }
      : {}),
    ...(params.beneficiary.birthDate ? { birthDate: new Date(params.beneficiary.birthDate) } : {}),
    ...(params.beneficiary.gender ? { gender: params.beneficiary.gender } : {}),
    ...(params.beneficiary.birthState ? { birthState: params.beneficiary.birthState.trim() } : {}),
    country: params.beneficiary.country?.trim() || "MÉXICO",
    curp: cleanCurp,
    ...(contactPhone ? { phone: contactPhone } : {}),
  };

  if (!beneficiary) {
    beneficiary = await prisma.patient.create({ data: profileData });
  } else {
    beneficiary = await prisma.patient.update({
      where: { id: beneficiary.id },
      data: profileData,
    });
  }

  // El beneficiario queda indexado unicamente por su propia CURP (no roba el PHONE del Titular)
  await upsertIdentityLink(beneficiary.id, IdentifierType.CURP, cleanCurp, false);

  if (beneficiary.id !== params.holder.id) {
    await prisma.patientRelationship.upsert({
      where: {
        uq_holder_beneficiary: {
          holderPatientId: params.holder.id,
          beneficiaryPatientId: beneficiary.id,
        },
      },
      update: {
        relationship: params.relationship,
        consentAccepted: params.consentAccepted,
        consentAcceptedAt: new Date(),
      },
      create: {
        holderPatientId: params.holder.id,
        beneficiaryPatientId: beneficiary.id,
        relationship: params.relationship,
        consentAccepted: params.consentAccepted,
      },
    });
  }

  return {
    beneficiary,
    relationshipLabel: RELATIONSHIP_LABELS[params.relationship] || "Familiar",
  };
}

/**
 * Solicita vinculación manual de trámites previos hechos desde otro teléfono o folio
 * en WhatsApp / Call Center, emitiendo un reto Step-Up OTP en Redis (Consola 2FA).
 */
export async function requestChannelLinkChallenge(params: {
  masterPatientId: string;
  phone?: string;
  folio?: string;
}): Promise<{
  ok: boolean;
  message: string;
  casesFound?: number;
  destinationMasked?: string;
  ttlSeconds?: number;
}> {
  const master = await prisma.patient.findUnique({ where: { id: params.masterPatientId } });
  if (!master) return { ok: false, message: "Cuenta de paciente no encontrada." };

  const targetPatientIds = new Set<string>();
  const targetCaseIds = new Set<string>();
  let destinationRaw = master.phone || "";

  if (params.phone?.trim()) {
    const normPhone = normalizePhone(params.phone);
    destinationRaw = normPhone;
    const phonePatients = await prisma.patient.findMany({
      where: { phone: normPhone },
      take: 10,
    });
    for (const p of phonePatients) {
      if (canSafelyMergePatients(master, p)) {
        targetPatientIds.add(p.id);
      }
    }
    const linkMatch = await findPatientByIdentifier(IdentifierType.PHONE, normPhone);
    if (linkMatch && canSafelyMergePatients(master, linkMatch)) {
      targetPatientIds.add(linkMatch.id);
    }
  }

  if (params.folio?.trim()) {
    const cleanFolio = params.folio.trim().toUpperCase();
    const recentCases = await prisma.serviceCase.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { patient: true },
    });
    for (const c of recentCases) {
      const ctx = (c.contextJson ?? {}) as { appointment_folio?: string | null };
      if (ctx.appointment_folio?.toUpperCase() === cleanFolio) {
        if (c.patientId !== master.id) {
          targetCaseIds.add(c.id);
          if (canSafelyMergePatients(master, c.patient)) {
            targetPatientIds.add(c.patientId);
          }
          if (!destinationRaw && c.patient.phone) {
            destinationRaw = c.patient.phone;
          }
        }
      }
    }
  }

  const candidateCasesCount = await prisma.serviceCase.count({
    where: {
      OR: [
        ...(targetPatientIds.size > 0
          ? [{ patientId: { in: Array.from(targetPatientIds) } }]
          : []),
        ...(targetCaseIds.size > 0 ? [{ id: { in: Array.from(targetCaseIds) } }] : []),
      ],
    },
  });

  if (candidateCasesCount === 0 && targetPatientIds.size === 0) {
    return {
      ok: false,
      message:
        "No encontramos trámites pendientes de vincular con ese teléfono o folio (o ya forman parte de tu cuenta).",
    };
  }

  const code = generateOtp6();
  const otpHash = hashOtp(master.id, code);
  const ttl = env.OTP_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  const record: ChannelLinkOtpRecord = {
    otpHash,
    targetPatientIds: Array.from(targetPatientIds),
    targetCaseIds: Array.from(targetCaseIds),
    phone: params.phone ? normalizePhone(params.phone) : undefined,
    folio: params.folio?.trim().toUpperCase(),
    attempts: 0,
    createdAt: now.toISOString(),
  };

  await redis.set(CHANNEL_LINK_OTP_KEY(master.id), JSON.stringify(record), "EX", ttl);

  const destinationMasked = destinationRaw
    ? maskIdentifier(IdentifierType.PHONE, destinationRaw)
    : "***-***-****";

  const outboxEntry: OutboxOtpEntry = {
    patientId: master.id,
    patientMasked: maskPatientName(master.firstName, master.paternalLastName),
    destinationMasked,
    code,
    channel: Channel.WEB,
    caseId: Array.from(targetCaseIds)[0] || "LINK_CHANNEL",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await redis.hset(OTP_OUTBOX_KEY, master.id, JSON.stringify(outboxEntry));

  return {
    ok: true,
    message: `Encontramos ${candidateCasesCount} trámite(s). Enviamos un código OTP de 6 dígitos (Consola 2FA / SMS) para confirmar la vinculación.`,
    casesFound: candidateCasesCount,
    destinationMasked,
    ttlSeconds: ttl,
  };
}

/**
 * Verifica el código OTP y ejecuta la vinculación inteligente del teléfono/folio secundario
 * hacia la cuenta web autenticada.
 */
export async function verifyChannelLinkChallenge(params: {
  masterPatientId: string;
  otpCode: string;
}): Promise<{
  ok: boolean;
  message: string;
  syncedCasesCount?: number;
}> {
  const raw = await redis.get(CHANNEL_LINK_OTP_KEY(params.masterPatientId));
  if (!raw) {
    return { ok: false, message: "El código OTP expiró o no existe. Solicita uno nuevo." };
  }

  const record = JSON.parse(raw) as ChannelLinkOtpRecord;
  const candidateHash = hashOtp(params.masterPatientId, params.otpCode);

  if (candidateHash !== record.otpHash) {
    const nextAttempts = record.attempts + 1;
    const remaining = Math.max(0, env.OTP_MAX_ATTEMPTS - nextAttempts);
    if (nextAttempts >= env.OTP_MAX_ATTEMPTS) {
      await redis.del(CHANNEL_LINK_OTP_KEY(params.masterPatientId));
      await redis.hdel(OTP_OUTBOX_KEY, params.masterPatientId);
      return { ok: false, message: "Máximo de intentos excedido. Solicita un nuevo código." };
    }
    const ttlLeft = await redis.ttl(CHANNEL_LINK_OTP_KEY(params.masterPatientId));
    await redis.set(
      CHANNEL_LINK_OTP_KEY(params.masterPatientId),
      JSON.stringify({ ...record, attempts: nextAttempts }),
      "EX",
      Math.max(10, ttlLeft)
    );
    return {
      ok: false,
      message: `Código OTP incorrecto. Intentos restantes: ${remaining}.`,
    };
  }

  await redis.del(CHANNEL_LINK_OTP_KEY(params.masterPatientId));
  await redis.hdel(OTP_OUTBOX_KEY, params.masterPatientId);

  let syncedCasesCount = 0;

  if (record.targetPatientIds.length > 0) {
    const merged = await mergePatientProfiles({
      masterId: params.masterPatientId,
      secondaryIds: record.targetPatientIds,
      channel: Channel.WEB,
    });
    syncedCasesCount += merged.syncedCasesCount;
  }

  if (record.targetCaseIds.length > 0) {
    const upd = await prisma.serviceCase.updateMany({
      where: {
        id: { in: record.targetCaseIds },
        patientId: { not: params.masterPatientId },
      },
      data: {
        requesterPatientId: params.masterPatientId,
      },
    });
    syncedCasesCount += upd.count;
  }

  if (record.phone) {
    await upsertIdentityLink(params.masterPatientId, IdentifierType.PHONE, record.phone, true);
  }

  return {
    ok: true,
    message: `Vinculación completada. Se sincronizaron ${syncedCasesCount} trámite(s) a tu historial.`,
    syncedCasesCount,
  };
}

/**
 * Emite un reto Step-Up OTP en Redis con TTL (300s por defecto).
 */
export async function issueOtpChallenge(params: {
  patient: Patient;
  caseId: string;
  journeyId: string;
  channel: Channel;
  correlationId?: string;
  destinationPhone?: string | null;
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

  const targetPhone = params.destinationPhone ?? params.patient.phone;
  const outboxEntry: OutboxOtpEntry = {
    patientId: params.patient.id,
    patientMasked: maskPatientName(params.patient.firstName, params.patient.paternalLastName),
    destinationMasked: targetPhone
      ? maskIdentifier(IdentifierType.PHONE, targetPhone)
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

export async function listActiveOtpOutbox(): Promise<Array<OutboxOtpEntry & { ttlSeconds: number }>> {
  const all = await redis.hgetall(OTP_OUTBOX_KEY);
  const results: Array<OutboxOtpEntry & { ttlSeconds: number }> = [];

  for (const [patientId, raw] of Object.entries(all)) {
    const [ttlCase, ttlLink] = await Promise.all([
      redis.ttl(OTP_KEY(patientId)),
      redis.ttl(CHANNEL_LINK_OTP_KEY(patientId)),
    ]);
    const ttl = Math.max(ttlCase, ttlLink);
    if (ttl <= 0) {
      await redis.hdel(OTP_OUTBOX_KEY, patientId);
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as OutboxOtpEntry;
      results.push({ ...parsed, ttlSeconds: ttl });
    } catch {
      await redis.hdel(OTP_OUTBOX_KEY, patientId);
    }
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
