import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { whatsappDlqQueue, whatsappInboundQueue } from "../queues/whatsappQueue";
import { CLINICS_CATALOG, STUDIES_CATALOG } from "../data/catalog";

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["Sistema"],
        summary: "Healthcheck de PostgreSQL 16, Redis 7 y colas BullMQ/DLQ",
      },
    },
    async (_request, reply) => {
      const checks: Record<string, unknown> = {
        status: "ok",
        timestamp: new Date().toISOString(),
        postgres: "unknown",
        redis: "unknown",
        queues: {},
      };

      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = "connected";
      } catch (err) {
        checks.status = "degraded";
        checks.postgres = `error: ${(err as Error).message}`;
      }

      try {
        const pong = await redis.ping();
        checks.redis = pong === "PONG" ? "connected" : pong;
        const [inboundCounts, dlqCounts] = await Promise.all([
          whatsappInboundQueue.getJobCounts("waiting", "active", "completed", "failed"),
          whatsappDlqQueue.getJobCounts("waiting", "failed"),
        ]);
        checks.queues = {
          whatsappInbound: inboundCounts,
          whatsappDlq: dlqCounts,
        };
      } catch (err) {
        checks.status = "degraded";
        checks.redis = `error: ${(err as Error).message}`;
      }

      const code = checks.status === "ok" ? 200 : 503;
      return reply.status(code).send(checks);
    }
  );

  app.get(
    "/api/catalog",
    {
      schema: {
        tags: ["Catálogo"],
        summary: "Obtiene el catálogo oficial de estudios y clínicas de Salud Digna",
      },
    },
    async () => {
      return {
        studies: STUDIES_CATALOG,
        clinics: CLINICS_CATALOG,
      };
    }
  );

  app.get(
    "/privacy",
    {
      schema: {
        tags: ["Sistema"],
        summary: "Política de Privacidad pública del ecosistema omnicanal Salud Digna",
      },
    },
    async (_request, reply) => {
      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Política de Privacidad — Salud Digna Omnicanal (HackaTec 2026)</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #1e293b; line-height: 1.6; }
    h1 { color: #005a2b; border-bottom: 2px solid #00843d; padding-bottom: 8px; }
    h2 { color: #00843d; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Política de Privacidad — Prototipo Omnicanal (HackaTec 2026)</h1>
  <p><strong>Última actualización:</strong> Noviembre 2026</p>
  <p>Esta aplicación corresponde a un prototipo tecnológico académico desarrollado en el marco del HackaTec Nacional 2026 (TecNM × Salud Digna) para demostrar continuidad omnicanal de atención al paciente.</p>
  <h2>1. Datos tratados</h2>
  <p>Únicamente se procesan datos de prueba proporcionados voluntariamente durante la demostración (nombre de prueba, número telefónico y selección de estudios simulados) para conservar el contexto del trámite entre canales.</p>
  <h2>2. Seguridad y privacidad</h2>
  <p>Los identificadores se almacenan mediante hash criptográfico HMAC-SHA256, el acceso entre canales requiere verificación Step-Up OTP temporal (TTL 5 minutos) y las vistas administrativas muestran datos enmascarados (PII protegida).</p>
  <h2>3. Eliminación de datos</h2>
  <p>Los datos de prueba pueden eliminarse en cualquier momento mediante el reinicio de demostración o solicitándolo al equipo participante.</p>
</body>
</html>`;
      return reply.status(200).type("text/html; charset=utf-8").send(html);
    }
  );
}
