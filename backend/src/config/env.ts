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

  WHATSAPP_API_VERSION: z.string().default("v21.0"),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default("salud_digna_webhook_verify_2026"),
  META_APP_SECRET: z.string().default(""),
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
