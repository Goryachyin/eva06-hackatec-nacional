import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import rawBody from "fastify-raw-body";
import { ZodError } from "zod";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { redis, redisSubscriber } from "./lib/redis";
import { InvalidStateTransitionError, OptimisticLockError } from "./core/stateMachine";
import { startWhatsAppWorker } from "./queues/whatsappQueue";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { patientAuthRoutes } from "./routes/patientAuth";
import { webChannelRoutes } from "./routes/webChannel";
import { whatsappGatewayRoutes } from "./routes/whatsappGateway";
import { otp2faRoutes } from "./routes/otp2fa";
import { callCenterRoutes } from "./routes/callCenter";
import { voiceCallsRoutes } from "./routes/voiceCalls";
import { adminRoutes } from "./routes/admin";

async function buildServer() {
  const app = Fastify({
    bodyLimit: 18 * 1024 * 1024,
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "info",
    },
    ajv: {
      customOptions: {
        keywords: ["example"],
      },
    },
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Captura rawBody exacto solo en rutas que lo solicitan (POST /webhooks/whatsapp para HMAC-SHA256)
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  // Documentacion interactiva OpenAPI 3 / Swagger en /docs (para evaluacion por Tech Leads)
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Salud Digna — Cerebro Orquestador Omnicanal API",
        description:
          "API REST, Gateway WhatsApp Baileys firmado extremo a extremo (HMAC-SHA256 + idempotencia Redis + BullMQ/DLQ), Multibeneficiario con privacidad clínica y Streaming SSE (Redis Pub/Sub). Arquitectura determinística y stateless — Beta v2.",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // Manejo centralizado de errores tipados (409 Optimistic Lock, 400 Zod / StateMachine)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OptimisticLockError) {
      return reply.status(409).send({
        error: "OPTIMISTIC_LOCK_CONFLICT",
        message: error.message,
      });
    }
    if (error instanceof InvalidStateTransitionError) {
      return reply.status(400).send({
        error: "INVALID_STATE_TRANSITION",
        message: error.message,
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: error.flatten().fieldErrors,
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    app.log.error(error);
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
      message: error instanceof Error ? error.message : "Error inesperado",
    });
  });

  // Registro modular de rutas
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(patientAuthRoutes);
  await app.register(webChannelRoutes);
  await app.register(whatsappGatewayRoutes);
  await app.register(otp2faRoutes);
  await app.register(callCenterRoutes);
  await app.register(voiceCallsRoutes);
  await app.register(adminRoutes);

  return app;
}

async function start() {
  const app = await buildServer();
  const worker = startWhatsAppWorker();

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Cerebro Orquestador activo en http://localhost:${env.PORT}`);
  app.log.info(`Documentacion OpenAPI/Swagger disponible en http://localhost:${env.PORT}/docs`);

  const shutdown = async (signal: string) => {
    app.log.info(`Recibido ${signal}, cerrando conexiones limpiamente...`);
    await worker.close();
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
    redisSubscriber.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Fallo fatal iniciando Cerebro Orquestador:", err);
  process.exit(1);
});
