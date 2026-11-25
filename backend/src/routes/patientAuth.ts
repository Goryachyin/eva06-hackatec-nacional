import { FastifyInstance, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { Channel, Gender, IdentifierType, Patient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { JOURNEY_PUBSUB_CHANNEL, redisSubscriber } from "../lib/redis";
import {
  maskIdentifier,
  maskPatientName,
  normalizeCurp,
  normalizeEmail,
  normalizePersonName,
  normalizePhone,
  normalizePlaceName,
  signPatientJwt,
} from "../lib/crypto";
import {
  reconcilePatientOmnichannelHistory,
  RELATIONSHIP_LABELS,
  requestChannelLinkChallenge,
  resolveOrCreatePatient,
  upsertIdentityLink,
  verifyChannelLinkChallenge,
} from "../core/identityService";
import { requirePatientAuth } from "../middleware/rbac";

const patientRegisterSchema = z.object({
  nombres: z.string().min(2),
  apellido_paterno: z.string().min(2),
  apellido_materno: z.string().optional(),
  fecha_nacimiento: z.string().min(10),
  genero: z.nativeEnum(Gender),
  estado_nacimiento: z.string().min(2),
  pais: z.string().default("MÉXICO"),
  curp: z.string().length(18),
  telefono: z.string().min(10),
  email: z.string().email(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  webSessionId: z.string().optional(),
});

const patientLoginSchema = z.object({
  identifier: z.string().min(4, "Ingresa tu correo electrónico, teléfono o CURP"),
  password: z.string().min(4),
});

const requestChannelLinkSchema = z
  .object({
    phone: z.string().min(10).optional(),
    folio: z.string().min(5).optional(),
  })
  .refine((d) => Boolean(d.phone || d.folio), {
    message: "Debes proporcionar un teléfono o un folio de cita.",
  });

const verifyChannelLinkSchema = z.object({
  otpCode: z.string().regex(/^\d{6}$/, "El código OTP debe tener 6 dígitos."),
});

// Clientes SSE de pacientes autenticados (filtrado estricto por patientId/requesterPatientId)
const patientSseClients = new Map<FastifyReply, string>();
let patientPubSubReady = false;

async function ensurePatientPubSubBridge() {
  if (patientPubSubReady) return;
  patientPubSubReady = true;

  await redisSubscriber.subscribe(JOURNEY_PUBSUB_CHANNEL);
  redisSubscriber.on("message", (channel, message) => {
    if (channel !== JOURNEY_PUBSUB_CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as {
        patientId?: string;
        requesterPatientId?: string;
      };
      const frame = `event: journey_event\ndata: ${message}\n\n`;
      for (const [client, subscribedPatientId] of patientSseClients.entries()) {
        if (
          parsed.patientId === subscribedPatientId ||
          parsed.requesterPatientId === subscribedPatientId
        ) {
          try {
            client.raw.write(frame);
          } catch {
            patientSseClients.delete(client);
          }
        }
      }
    } catch {
      // Ignorar mensaje no JSON
    }
  });
}

function formatPublicPatient(p: Patient) {
  return {
    id: p.id,
    nombres: p.firstName,
    apellido_paterno: p.paternalLastName,
    apellido_materno: p.maternalLastName,
    fecha_nacimiento: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
    genero: p.gender,
    estado_nacimiento: p.birthState,
    pais: p.country,
    curp: p.curp,
    telefono: p.phone,
    email: p.email,
    createdAt: p.createdAt,
  };
}

export async function patientAuthRoutes(app: FastifyInstance) {
  await ensurePatientPubSubBridge();

  app.post(
    "/api/patients/auth/register",
    {
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Crea una cuenta de paciente con los 9 campos oficiales y vincula identidades omnicanal",
      },
    },
    async (request, reply) => {
      const body = patientRegisterSchema.parse(request.body);
      const cleanEmail = normalizeEmail(body.email) ?? body.email.trim().toLowerCase();
      const cleanCurp = normalizeCurp(body.curp) ?? body.curp.trim().toUpperCase();
      const cleanPhone = normalizePhone(body.telefono);

      const existingByEmail = await prisma.patient.findFirst({
        where: { email: { equals: cleanEmail, mode: "insensitive" } },
      });
      if (existingByEmail && existingByEmail.passwordHash) {
        return reply.status(409).send({
          error: "ACCOUNT_ALREADY_EXISTS",
          message: "Ya existe una cuenta registrada con este correo electrónico. Inicia sesión.",
        });
      }

      const patient = await resolveOrCreatePatient({
        firstName: normalizePersonName(body.nombres) ?? body.nombres,
        paternalLastName: normalizePersonName(body.apellido_paterno) ?? body.apellido_paterno,
        maternalLastName: normalizePersonName(body.apellido_materno),
        birthDate: body.fecha_nacimiento,
        gender: body.genero,
        birthState: normalizePlaceName(body.estado_nacimiento) ?? body.estado_nacimiento,
        country: normalizePlaceName(body.pais) ?? "MEXICO",
        curp: cleanCurp,
        phone: cleanPhone,
        email: cleanEmail,
        webSessionId: body.webSessionId,
      });

      if (patient.passwordHash && patient.email && patient.email !== cleanEmail) {
        return reply.status(409).send({
          error: "IDENTITY_ALREADY_REGISTERED",
          message: "Este teléfono o CURP ya tiene una cuenta activa. Inicia sesión con tu contraseña.",
        });
      }

      const passwordHash = await bcrypt.hash(body.password, 10);

      const updated = await prisma.patient.update({
        where: { id: patient.id },
        data: {
          email: cleanEmail,
          passwordHash,
        },
      });

      await upsertIdentityLink(updated.id, IdentifierType.EMAIL, cleanEmail, true);

      // Vinculación inteligente: absorber cualquier expediente sombra previo (WhatsApp / Call Center)
      await reconcilePatientOmnichannelHistory(updated.id, {
        webSessionId: body.webSessionId,
        channel: Channel.WEB,
      });

      const priorCasesCount = await prisma.serviceCase.count({
        where: {
          OR: [{ patientId: updated.id }, { requesterPatientId: updated.id }],
        },
      });

      const token = signPatientJwt({
        sub: updated.id,
        email: cleanEmail,
      });

      return reply.status(201).send({
        token,
        patient: formatPublicPatient(updated),
        syncedCasesCount: priorCasesCount,
      });
    }
  );

  app.post(
    "/api/patients/auth/login",
    {
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Inicia sesión como paciente (correo, teléfono o CURP + contraseña) y devuelve JWT",
      },
    },
    async (request, reply) => {
      const { identifier, password } = patientLoginSchema.parse(request.body);
      const raw = identifier.trim();

      let patient: Patient | null = null;
      if (raw.includes("@")) {
        const cleanEmail = normalizeEmail(raw) ?? raw.toLowerCase();
        patient = await prisma.patient.findFirst({
          where: { email: { equals: cleanEmail, mode: "insensitive" } },
        });
      } else if (/^[A-Za-z0-9]{18}$/.test(raw)) {
        const cleanCurp = normalizeCurp(raw) ?? raw.toUpperCase();
        patient = await prisma.patient.findUnique({ where: { curp: cleanCurp } });
      } else {
        patient = await prisma.patient.findFirst({
          where: { phone: normalizePhone(raw), passwordHash: { not: null } },
          orderBy: { createdAt: "asc" },
        });
      }

      if (!patient || !patient.passwordHash) {
        return reply.status(401).send({
          error: "INVALID_CREDENTIALS",
          message: "Credenciales incorrectas o cuenta aún sin contraseña registrada.",
        });
      }

      const valid = await bcrypt.compare(password, patient.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          error: "INVALID_CREDENTIALS",
          message: "Credenciales incorrectas.",
        });
      }

      // Reconciliación inteligente al iniciar sesión para sincronizar citas hechas en WhatsApp/Call Center
      const reconciliation = await reconcilePatientOmnichannelHistory(patient.id, {
        channel: Channel.WEB,
      });

      const token = signPatientJwt({
        sub: reconciliation.patient.id,
        email:
          reconciliation.patient.email ??
          reconciliation.patient.phone ??
          reconciliation.patient.id,
      });

      return {
        token,
        patient: formatPublicPatient(reconciliation.patient),
        syncedCasesCount: reconciliation.syncedCasesCount,
      };
    }
  );

  /**
   * Perfil + Beneficiarios guardados + Citas propias y gestionadas para terceros
   * (respetando privacidad clinica LFPDPPP en citas de terceros)
   */
  app.get(
    "/api/patients/me",
    {
      preHandler: requirePatientAuth,
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Obtiene el perfil, beneficiarios familiares y citas con línea de tiempo en vivo",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const patientId = request.patientUser!.sub;

      // Reconciliación automática antes de consultar el historial (absorbe citas sombra de WhatsApp/Call Center)
      const reconciled = await reconcilePatientOmnichannelHistory(patientId, {
        channel: Channel.WEB,
      }).catch(() => ({ syncedCasesCount: 0 }));

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: {
          managedBeneficiaries: {
            include: {
              beneficiary: {
                select: {
                  id: true,
                  firstName: true,
                  paternalLastName: true,
                  maternalLastName: true,
                  birthDate: true,
                  gender: true,
                  birthState: true,
                  country: true,
                  curp: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!patient) {
        return reply.status(404).send({
          error: "PATIENT_NOT_FOUND",
          message: "Cuenta de paciente no encontrada.",
        });
      }

      // Casos propios (donde es beneficiario) + casos gestionados por el titular para familiares
      const allCases = await prisma.serviceCase.findMany({
        where: {
          OR: [{ patientId }, { requesterPatientId: patientId }],
        },
        include: {
          patient: {
            select: { id: true, firstName: true, paternalLastName: true, maternalLastName: true },
          },
          journeyEvents: {
            orderBy: { createdAt: "asc" },
            take: 30,
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });

      const formattedCases = allCases.map((c) => {
        const isThirdParty = c.patientId !== patientId;
        const beneficiaryDisplay = isThirdParty
          ? maskPatientName(c.patient.firstName, c.patient.paternalLastName)
          : [c.patient.firstName, c.patient.paternalLastName, c.patient.maternalLastName]
              .filter(Boolean)
              .join(" ") || "Titular";

        return {
          ...c,
          isThirdParty,
          beneficiaryDisplay,
          relationshipLabel: c.relationshipLabel || (isThirdParty ? "Familiar" : "Titular"),
          privacyNotice: isThirdParty
            ? "Vista operativa limitada por privacidad clínica: solo se muestra el seguimiento de la cita gestionada."
            : null,
        };
      });

      const beneficiaries = patient.managedBeneficiaries.map((rel) => ({
        relationshipId: rel.id,
        relationship: rel.relationship,
        relationshipLabel: RELATIONSHIP_LABELS[rel.relationship] || "Familiar",
        beneficiaryId: rel.beneficiary.id,
        nombres: rel.beneficiary.firstName,
        apellido_paterno: rel.beneficiary.paternalLastName,
        apellido_materno: rel.beneficiary.maternalLastName,
        fecha_nacimiento: rel.beneficiary.birthDate
          ? rel.beneficiary.birthDate.toISOString().slice(0, 10)
          : null,
        genero: rel.beneficiary.gender,
        estado_nacimiento: rel.beneficiary.birthState,
        pais: rel.beneficiary.country,
        curpMasked: rel.beneficiary.curp
          ? maskIdentifier(IdentifierType.CURP, rel.beneficiary.curp)
          : null,
        curp: rel.beneficiary.curp,
      }));

      return {
        patient: formatPublicPatient(patient),
        beneficiaries,
        cases: formattedCases,
        syncedCasesCount: reconciled.syncedCasesCount,
      };
    }
  );

  /**
   * Solicitar vinculación manual de citas previas (otro número de WhatsApp/teléfono o folio) con reto OTP
   */
  app.post(
    "/api/patients/me/link-channel/request",
    {
      preHandler: requirePatientAuth,
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Solicita vinculación de citas previas de WhatsApp/Call Center por teléfono o folio (emite OTP)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const patientId = request.patientUser!.sub;
      const body = requestChannelLinkSchema.parse(request.body);
      const res = await requestChannelLinkChallenge({
        masterPatientId: patientId,
        phone: body.phone,
        folio: body.folio,
      });
      if (!res.ok) {
        return reply.status(404).send({ error: "NO_CASES_TO_LINK", message: res.message });
      }
      return res;
    }
  );

  /**
   * Confirmar vinculación manual con código OTP de 6 dígitos
   */
  app.post(
    "/api/patients/me/link-channel/verify",
    {
      preHandler: requirePatientAuth,
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Verifica el código OTP y fusiona las citas previas al perfil autenticado",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const patientId = request.patientUser!.sub;
      const body = verifyChannelLinkSchema.parse(request.body);
      const res = await verifyChannelLinkChallenge({
        masterPatientId: patientId,
        otpCode: body.otpCode,
      });
      if (!res.ok) {
        return reply.status(400).send({ error: "OTP_LINK_FAILED", message: res.message });
      }
      return res;
    }
  );

  /**
   * Stream SSE en tiempo real para el paciente autenticado (actualiza su tracker estilo Amazon/ML en vivo)
   */
  app.get(
    "/api/patients/me/stream",
    {
      preHandler: requirePatientAuth,
      schema: {
        tags: ["Cuenta de Paciente (Portal Público)"],
        summary: "Stream SSE en vivo con eventos de los trámites propios o gestionados del paciente",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const patientId = request.patientUser!.sub;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({
          status: "subscribed",
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      patientSseClients.set(reply, patientId);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          patientSseClients.delete(reply);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        patientSseClients.delete(reply);
      });

      return reply;
    }
  );
}
