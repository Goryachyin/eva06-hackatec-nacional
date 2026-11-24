import Redis from "ioredis";
import { env } from "../config/env";

export const JOURNEY_PUBSUB_CHANNEL = "journey:events";

/**
 * Cliente Redis principal para operaciones atomicas (SETNX wamid, OTP TTL, Publish).
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

/**
 * Cliente Redis dedicado a suscripcion Pub/Sub para difusion SSE stateless.
 * En Redis un cliente en modo SUBSCRIBE no puede ejecutar otros comandos.
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
