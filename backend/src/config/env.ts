import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  BACKEND_PORT: z.coerce.number().optional(),
  HOST: z.string().default("0.0.0.0"),
  FRONTEND_URL: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  REDIS_URL: z.string().min(1, "REDIS_URL es obligatoria"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  PII_HASH_PEPPER: z.string().min(8, "PII_HASH_PEPPER es obligatorio"),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WAMID_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  // Firma digital extremo a extremo (HMAC-SHA256) entre Gateway Baileys Local <-> Cerebro Orquestador
  WHATSAPP_GATEWAY_SECRET: z
    .string()
    .min(16, "WHATSAPP_GATEWAY_SECRET debe tener al menos 16 caracteres")
    .default("sd_e2e_gateway_hmac_secret_2026_local"),
  GATEWAY_SIGNATURE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Plugin opcional de IA (OpenAI Function Calling + STT/Resumen de llamadas) con fallback deterministico
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_STT_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(18000),
  OPENAI_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Error en variables de entorno:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  PORT: parsed.data.BACKEND_PORT ?? parsed.data.PORT,
};
