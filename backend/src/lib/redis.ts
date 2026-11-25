import Redis from "ioredis";
import { env } from "../config/env";

export const JOURNEY_PUBSUB_CHANNEL = "journey:events";
export const WHATSAPP_OUTBOUND_PUBSUB_CHANNEL = "whatsapp:outbound";
export const WEBRTC_SIGNALING_PUBSUB_CHANNEL = "webrtc:signaling";

/**
 * Cliente Redis principal para operaciones atomicas (SETNX, OTP TTL, Publish).
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

/**
 * Cliente Redis dedicado a suscripcion Pub/Sub para difusion SSE stateless
 * (Admin, Pacientes y Gateway WhatsApp Baileys).
 */
export const redisSubscriber = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

/**
 * Crea una conexion dedicada compatible con BullMQ (requiere maxRetriesPerRequest: null).
 */
export function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

redis.on("error", (err) => {
  console.error("[Redis] Error en conexion principal:", err.message);
});

redisSubscriber.on("error", (err) => {
  console.error("[Redis Sub] Error en conexion Pub/Sub:", err.message);
});
