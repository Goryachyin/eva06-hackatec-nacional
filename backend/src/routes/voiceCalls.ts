import crypto from "crypto";
import { FastifyInstance, FastifyReply } from "fastify";
import { ActorRole, CaseState, Channel, EventType, StaffRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { redis, redisSubscriber, WEBRTC_SIGNALING_PUBSUB_CHANNEL } from "../lib/redis";
import { verifyPatientJwt } from "../lib/crypto";
import { requireStaffRole } from "../middleware/rbac";
import { resolveOrCreatePatient } from "../core/identityService";
import { CaseContextJson, transitionServiceCase } from "../core/stateMachine";
import { recordAndPublishEvent } from "../core/eventBus";

export interface VoiceCallSession {
  callId: string;
  caseId: string;
  patientId: string;
  patientName: string;
  patientPhone?: string | null;
  studyName?: string | null;
  clinicName?: string | null;
  status: "ringing" | "active" | "ended" | "rejected";
  offerSdp: Record<string, unknown>;
  answerSdp?: Record<string, unknown>;
  advisorId?: string;
  advisorName?: string;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
}

interface SignalingBroadcast {
  target: "advisors" | "patient";
  callId: string;
  event: "incoming_call" | "call_answered" | "ice_candidate" | "call_ended" | "call_rejected";
  data: Record<string, unknown>;
}

const CALL_KEY = (callId: string) => `webrtc:call:${callId}`;
const RINGING_SET_KEY = "webrtc:calls:ringing";
const CALL_TTL_SECONDS = 3600;

const createCallSchema = z.object({
  offerSdp: z.object({
    type: z.string(),
    sdp: z.string().min(10),
  }),
  caseId: z.string().uuid().optional(),
  webSessionId: z.string().optional(),
  phone: z.string().optional(),
  patientName: z.string().optional(),
});

const answerCallSchema = z.object({
  answerSdp: z.object({
    type: z.string(),
    sdp: z.string().min(10),
  }),
});

const iceSchema = z.object({
  role: z.enum(["patient", "advisor"]),
  candidate: z.record(z.unknown()),
});

const endCallSchema = z.object({
  reason: z.enum(["ended", "rejected"]).default("ended"),
});

const advisorSseClients = new Set<FastifyReply>();
const patientSseClients = new Map<string, Set<FastifyReply>>();
let signalingBridgeReady = false;

async function ensureSignalingBridge() {
  if (signalingBridgeReady) return;
  signalingBridgeReady = true;

  await redisSubscriber.subscribe(WEBRTC_SIGNALING_PUBSUB_CHANNEL);
  redisSubscriber.on("message", (channel, raw) => {
    if (channel !== WEBRTC_SIGNALING_PUBSUB_CHANNEL) return;
    try {
      const msg = JSON.parse(raw) as SignalingBroadcast;
      const frame = `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;

      if (msg.target === "advisors") {
        for (const client of advisorSseClients) {
          try {
            client.raw.write(frame);
          } catch {
            advisorSseClients.delete(client);
          }
        }
      } else if (msg.target === "patient") {
        const set = patientSseClients.get(msg.callId);
        if (!set) return;
        for (const client of set) {
          try {
            client.raw.write(frame);
          } catch {
            set.delete(client);
          }
        }
      }
    } catch {
      // Ignorar mensaje no JSON
    }
  });
}

async function publishSignal(msg: SignalingBroadcast) {
  await redis.publish(WEBRTC_SIGNALING_PUBSUB_CHANNEL, JSON.stringify(msg));
}

async function getCallSession(callId: string): Promise<VoiceCallSession | null> {
  const raw = await redis.get(CALL_KEY(callId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VoiceCallSession;
  } catch {
    return null;
  }
}

async function saveCallSession(session: VoiceCallSession) {
  await redis.set(CALL_KEY(session.callId), JSON.stringify(session), "EX", CALL_TTL_SECONDS);
}

export async function voiceCallsRoutes(app: FastifyInstance) {
  await ensureSignalingBridge();
  const advisorGuard = requireStaffRole([StaffRole.ASESOR, StaffRole.ADMIN]);

  /**
   * 1. Paciente inicia llamada de voz WebRTC hacia Call Center (crea/vincula ServiceCase y dispara Screen-Pop)
   */
  app.post(
    "/api/voice/calls",
    {
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "Inicia una llamada WebRTC desde el portal del paciente hacia Call Center",
      },
    },
    async (request, reply) => {
      const body = createCallSchema.parse(request.body);

      // Resolver identidad del paciente (JWT paciente si está autenticado, o caseId / teléfono / webSessionId)
      let jwtPatientId: string | null = null;
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          jwtPatientId = verifyPatientJwt(authHeader.slice(7).trim()).sub;
        } catch {
          jwtPatientId = null;
        }
      }

      let serviceCase = body.caseId
        ? await prisma.serviceCase.findUnique({
            where: { id: body.caseId },
            include: { patient: true },
          })
        : null;

      let patient = serviceCase?.patient ?? null;

      if (!patient && jwtPatientId) {
        patient = await prisma.patient.findUnique({ where: { id: jwtPatientId } });
      }

      if (!patient) {
        patient = await resolveOrCreatePatient({
          phone: body.phone && body.phone.replace(/\D/g, "").length >= 10 ? body.phone : undefined,
          webSessionId: body.webSessionId || `web_voice_${crypto.randomUUID().slice(0, 8)}`,
          firstName: body.patientName?.trim() || undefined,
        });
      }

      if (!serviceCase) {
        serviceCase = await prisma.serviceCase.findFirst({
          where: {
            OR: [{ patientId: patient.id }, { requesterPatientId: patient.id }],
            currentState: { not: CaseState.CITA_CONFIRMADA },
          },
          include: { patient: true },
          orderBy: { updatedAt: "desc" },
        });
      }

      if (!serviceCase) {
        const created = await prisma.serviceCase.create({
          data: {
            patientId: patient.id,
            requesterPatientId: patient.id,
            relationshipLabel: "Titular",
            thirdPartyConsent: false,
            currentState: CaseState.DUDAS_ABIERTAS,
            currentChannel: Channel.CALL_CENTER,
            contextJson: {
              otp_verified_channels: ["WEB"],
              open_questions: ["Llamada WebRTC iniciada hacia Call Center"],
            },
          },
          include: { patient: true },
        });
        serviceCase = created;

        await recordAndPublishEvent({
          caseId: created.id,
          patientId: patient.id,
          journeyId: created.journeyId,
          channel: Channel.CALL_CENTER,
          actorRole: ActorRole.PATIENT,
          eventType: EventType.SESSION_STARTED,
          prevState: null,
          nextState: CaseState.DUDAS_ABIERTAS,
          payload: { via: "webrtc_voice_call" },
        });
      }

      const ctx = (serviceCase.contextJson ?? {}) as CaseContextJson;
      const patientDisplayName =
        [patient.firstName, patient.paternalLastName].filter(Boolean).join(" ").trim() ||
        body.patientName?.trim() ||
        (patient.phone ? `Paciente ${patient.phone}` : "Paciente Web");

      const callId = crypto.randomUUID();
      const session: VoiceCallSession = {
        callId,
        caseId: serviceCase.id,
        patientId: patient.id,
        patientName: patientDisplayName,
        patientPhone: patient.phone,
        studyName: ctx.study?.name ?? null,
        clinicName: ctx.clinic?.name ?? null,
        status: "ringing",
        offerSdp: body.offerSdp,
        createdAt: new Date().toISOString(),
      };

      await saveCallSession(session);
      await redis.sadd(RINGING_SET_KEY, callId);
      await redis.expire(RINGING_SET_KEY, CALL_TTL_SECONDS);

      await publishSignal({
        target: "advisors",
        callId,
        event: "incoming_call",
        data: session as unknown as Record<string, unknown>,
      });

      return reply.status(201).send({
        callId,
        caseId: serviceCase.id,
        status: session.status,
      });
    }
  );

  /**
   * 2. Stream SSE para el paciente durante la llamada WebRTC
   */
  app.get(
    "/api/voice/stream/patient/:callId",
    {
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "Stream SSE de señalización WebRTC para el paciente llamante",
      },
    },
    async (request, reply) => {
      const { callId } = request.params as { callId: string };
      const existing = await getCallSession(callId);
      if (!existing) {
        return reply.status(404).send({ error: "CALL_NOT_FOUND", message: "Llamada no encontrada." });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ callId, status: existing.status })}\n\n`
      );

      // Si el asesor ya contestó antes de que conectara el SSE, enviar respuesta inmediata
      if (existing.status === "active" && existing.answerSdp) {
        reply.raw.write(
          `event: call_answered\ndata: ${JSON.stringify({
            callId,
            answerSdp: existing.answerSdp,
            advisorName: existing.advisorName,
          })}\n\n`
        );
      }

      let set = patientSseClients.get(callId);
      if (!set) {
        set = new Set();
        patientSseClients.set(callId, set);
      }
      set.add(reply);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          set?.delete(reply);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        const s = patientSseClients.get(callId);
        if (s) {
          s.delete(reply);
          if (s.size === 0) patientSseClients.delete(callId);
        }
      });

      return reply;
    }
  );

  /**
   * 3. Stream SSE autenticado para asesores de Call Center (recibe llamadas entrantes + ICE)
   */
  app.get(
    "/api/voice/stream/advisor",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "Stream SSE de señalización WebRTC para asesores de Call Center",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({
          status: "advisor_voice_ready",
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      // Enviar cualquier llamada en espera (ringing) al conectar el asesor
      const ringingIds = await redis.smembers(RINGING_SET_KEY);
      for (const cid of ringingIds) {
        const call = await getCallSession(cid);
        if (call && call.status === "ringing") {
          reply.raw.write(`event: incoming_call\ndata: ${JSON.stringify(call)}\n\n`);
        } else {
          await redis.srem(RINGING_SET_KEY, cid);
        }
      }

      advisorSseClients.add(reply);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          advisorSseClients.delete(reply);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        advisorSseClients.delete(reply);
      });

      return reply;
    }
  );

  /**
   * 4. Asesor contesta la llamada WebRTC (envía answerSdp y asigna el caso automáticamente)
   */
  app.post(
    "/api/voice/calls/:callId/answer",
    {
      preHandler: advisorGuard,
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "El asesor contesta la llamada WebRTC con su SDP de respuesta",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { callId } = request.params as { callId: string };
      const body = answerCallSchema.parse(request.body);
      const advisor = request.staffUser!;

      const session = await getCallSession(callId);
      if (!session) {
        return reply.status(404).send({ error: "CALL_NOT_FOUND", message: "Llamada no encontrada." });
      }
      if (session.status !== "ringing") {
        return reply.status(409).send({
          error: "CALL_NOT_RINGING",
          message: `La llamada ya se encuentra en estado: ${session.status}.`,
        });
      }

      session.status = "active";
      session.answerSdp = body.answerSdp;
      session.advisorId = advisor.sub;
      session.advisorName = advisor.fullName;
      session.answeredAt = new Date().toISOString();

      await saveCallSession(session);
      await redis.srem(RINGING_SET_KEY, callId);

      // Asignar automáticamente el expediente al asesor si no está confirmado aún
      const existingCase = await prisma.serviceCase.findUnique({ where: { id: session.caseId } });
      if (existingCase && existingCase.currentState !== CaseState.CITA_CONFIRMADA) {
        await transitionServiceCase({
          caseId: existingCase.id,
          expectedVersion: existingCase.version,
          nextState: CaseState.EN_ATENCION_ASESOR,
          channel: Channel.CALL_CENTER,
          actorRole: ActorRole.ADVISOR,
          eventType: EventType.ADVISOR_ASSIGNED,
          assignedAdvisorId: advisor.sub,
          eventPayload: {
            advisorId: advisor.sub,
            advisorName: advisor.fullName,
            callId,
            via: "webrtc_voice_call",
          },
        }).catch(() => {});
      }

      await publishSignal({
        target: "patient",
        callId,
        event: "call_answered",
        data: {
          callId,
          answerSdp: body.answerSdp,
          advisorName: advisor.fullName,
        },
      });

      return { ok: true, callId, caseId: session.caseId, status: session.status };
    }
  );

  /**
   * 5. Intercambio de candidatos ICE entre paciente y asesor
   */
  app.post(
    "/api/voice/calls/:callId/ice",
    {
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "Intercambia candidatos ICE para establecer conexión P2P WebRTC",
      },
    },
    async (request, reply) => {
      const { callId } = request.params as { callId: string };
      const body = iceSchema.parse(request.body);
      const session = await getCallSession(callId);
      if (!session) {
        return reply.status(404).send({ error: "CALL_NOT_FOUND", message: "Llamada no encontrada." });
      }

      await publishSignal({
        target: body.role === "patient" ? "advisors" : "patient",
        callId,
        event: "ice_candidate",
        data: {
          callId,
          fromRole: body.role,
          candidate: body.candidate,
        },
      });

      return { ok: true };
    }
  );

  /**
   * 6. Colgar o rechazar llamada WebRTC
   */
  app.post(
    "/api/voice/calls/:callId/end",
    {
      schema: {
        tags: ["Canal 3: Voz WebRTC en Tiempo Real"],
        summary: "Finaliza o rechaza una llamada WebRTC activa o entrante",
      },
    },
    async (request) => {
      const { callId } = request.params as { callId: string };
      const body = endCallSchema.parse(request.body ?? {});
      const session = await getCallSession(callId);

      await redis.srem(RINGING_SET_KEY, callId);

      if (session) {
        session.status = body.reason;
        session.endedAt = new Date().toISOString();
        await saveCallSession(session);
      }

      const eventName = body.reason === "rejected" ? "call_rejected" : "call_ended";
      await Promise.all([
        publishSignal({
          target: "patient",
          callId,
          event: eventName,
          data: { callId, reason: body.reason },
        }),
        publishSignal({
          target: "advisors",
          callId,
          event: eventName,
          data: { callId, reason: body.reason },
        }),
      ]);

      return { ok: true, callId, status: body.reason };
    }
  );
}
