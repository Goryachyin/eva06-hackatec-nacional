# ============================================================================
# Multi-stage Dockerfile — Node.js 20 LTS (Produccion / AWS / Evaluacion)
# Fija runtime LTS para reproducibilidad total independiente del SO anfitrion.
# ============================================================================

FROM node:20-slim AS builder
WORKDIR /app

# OpenSSL requerido por motores nativos de Prisma en Linux Debian slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx prisma/seed.ts && node dist/index.js"]
