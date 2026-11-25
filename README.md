# Salud Digna × HackaTec Nacional 2026 — Orquestación Omnicanal de Atención
### *"Un paciente, una sola conversación"*

Plataforma productiva de **orquestación y trazabilidad omnicanal** diseñada bajo una arquitectura de **Monolito Modular stateless**, que garantiza la continuidad bidireccional de citas y estudios clínicos (*N-saltos* sin repetir datos) entre **Sitio Web**, **WhatsApp** y **Call Center con Voz WebRTC**.

---

## Descripción del Proyecto

En la atención clínica multicanal, los pacientes frecuentemente cotizan un estudio en el sitio web, continúan sus dudas por WhatsApp y concluyen su cita por teléfono, perdiendo contexto en cada salto. Esta solución centraliza el estado y la trazabilidad del viaje del paciente (*Patient Journey*) mediante un **Cerebro Orquestador** determinístico:

- **Continuidad omnicanal de N-saltos:** un único trámite (`service_cases` con `journey_id`) conserva estudio, clínica, horario, dudas, forma de pago, resúmenes de llamadas y folio entre Web, WhatsApp y Call Center.
- **Soporte Multibeneficiario con privacidad clínica (LFPDPPP):** un mismo titular/teléfono puede gestionar citas propias o de familiares/conocidos manteniendo expedientes clínicos separados por `CURP` (`patients` + `patient_relationships`) y consentimiento auditado.
- **Seguridad por diseño:** verificación **Step-Up OTP out-of-band** (TTL 5 min, máx. 3 intentos en Redis), bloqueo optimista de concurrencia (`service_cases.version` → HTTP `409`), idempotencia atómica `SETNX` (24h), JWT segregado (`PATIENT` vs `STAFF`) y enmascaramiento estricto de PII en el panel administrativo.
- **Gateway WhatsApp propio sin dependencias de Meta Cloud API:** conector local basado en `@whiskeysockets/baileys` vinculado por QR con firma criptográfica **HMAC-SHA256 bidireccional** y ventana anti-replay (`300s`), más un simulador QA integrado que ejecuta exactamente el mismo motor.
- **Call Center con Voz WebRTC en tiempo real + Resumen IA:** llamadas de voz P2P directamente desde el portal del paciente hacia la estación del asesor (señalización sobre Redis Pub/Sub + SSE), grabación dual-track (Web Audio API + `MediaRecorder`), transcripción STT y resumen estructurado con OpenAI (`gpt-4o-mini-transcribe` / fallback `whisper-1` + `gpt-4o-mini`) con **fallback determinístico automático** si no hay `OPENAI_API_KEY`.
- **Observabilidad en vivo (SSE):** seguimiento visual tipo envío para el paciente en `/mi-cuenta` y consola administrativa con KPIs, búsqueda de expedientes y telemetría de colas BullMQ/DLQ en `/admin`.

---

## Arquitectura de la Solución

![Arquitectura Monolito Modular — Salud Digna Omnicanal](docs/diagramas/arquitectura-monolito-modular.jpg)

> Versión interactiva con zoom y exportación SVG/PNG 3x disponible en [`docs/diagramas/arquitectura-monolito-modular.html`](docs/diagramas/arquitectura-monolito-modular.html).

### Stack Tecnológico

| Capa | Tecnología | Rol en el sistema |
| --- | --- | --- |
| **Front-end Web (4 Entornos SPA)** | React 18 + TypeScript + Vite 6 + Tailwind CSS + Nginx / Vercel | Portal Público (con Voz WebRTC y tracking SSE), Estación Call Center (Screen-Pop, Voz Dual-Track y Resúmenes IA), Back-Office Admin y Laboratorio QA |
| **Gateway WhatsApp Local** | Node.js 20 + `@whiskeysockets/baileys` | Proceso separado que vincula un número real por QR y conversa con el backend vía `POST /inbound` + `SSE /outbound/stream` firmados con **HMAC-SHA256** |
| **Monolito Modular (Backend)** | Node.js 20 LTS + TypeScript + Fastify v5 (`bodyLimit: 18 MB`) + Prisma ORM + BullMQ + Zod | Unifica en un contenedor: Identidad/OTP, Orquestación (8 estados + lock optimista + señalización WebRTC), Mensajería/IA (Worker BullMQ + Bot NLU + STT/Resumen) y Auditoría/SSE |
| **Base de Datos Relacional** | PostgreSQL 16 (Amazon RDS / Docker) | 6 tablas (`patients`, `patient_relationships`, `identity_links`, `service_cases` con `JSONB` + `version`, `journey_events` inmutable y `users_staff`) |
| **Bus de Datos y Tiempo Real** | Redis 7 / AWS ElastiCache Valkey (`AOF`, `noeviction`) | Colas BullMQ (`{bull}:whatsapp-inbound`, `whatsapp-dlq`), idempotencia `SETNX` (24h), retos OTP (5m), sesiones WebRTC (1h) y Pub/Sub (`journey:events`, `whatsapp:outbound`, `webrtc:signaling`) |
| **Servicios Externos Opcionales** | OpenAI API + STUN WebRTC (`stun.l.google.com:19302`) | NLU de WhatsApp y transcripción/resumen de llamadas (con fallback determinístico sin costo si `OPENAI_API_KEY` está vacía) + negociación ICE para audio P2P |

---

## Entorno Productivo en Vivo (AWS `us-east-2`)

- **Backend API (ECS Fargate):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws`
- **Healthcheck (PostgreSQL + Redis + BullMQ):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/health`
- **Documentación OpenAPI (Swagger UI):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/docs`
- **Estado del Gateway Baileys:** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/api/gateways/whatsapp/status`

---

## Requisitos Previos

- **Opción recomendada (Docker):** [Docker Desktop](https://www.docker.com/products/docker-desktop/) con `docker compose` v2.
- **Opción desarrollo local / Gateway WhatsApp / Pruebas QA:** [Node.js 20 LTS](https://nodejs.org/) y `npm` 10+.
- **Opcional:** una clave `OPENAI_API_KEY` si deseas habilitar el asistente NLU en WhatsApp y la transcripción STT/resumen de llamadas con OpenAI (sin esta clave, el sistema opera 100% en modo determinístico sin errores).

---

## Instalación y Ejecución (Guía para el Jurado)

### 1. Clonar el repositorio y configurar `.env`

```powershell
git clone <URL_DEL_REPOSITORIO>
cd eva06-nacional
```

Crea un archivo `.env` en la raíz del proyecto (puedes copiar `.env.example` si está presente o usar esta plantilla lista para pruebas locales):

```env
# --- Entorno General ---
NODE_ENV=development
BACKEND_PORT=3000
FRONTEND_PORT=5173
FRONTEND_URL=http://localhost:5173
VITE_API_URL=http://localhost:3000

# --- PostgreSQL 16 ---
POSTGRES_USER=saluddigna
POSTGRES_PASSWORD=saluddigna_dev_pass
POSTGRES_DB=omnicanal
POSTGRES_PORT=5433
DATABASE_URL=postgresql://saluddigna:saluddigna_dev_pass@localhost:5433/omnicanal?schema=public

# --- Redis 7 ---
REDIS_PORT=6379
REDIS_PASSWORD=redis_dev_pass
REDIS_URL=redis://:redis_dev_pass@localhost:6379

# --- Seguridad (JWT, PII, OTP e Idempotencia) ---
JWT_SECRET=salud_digna_jwt_secret_eval_2026_seguro
PII_HASH_PEPPER=salud_digna_pepper_eval_2026
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=3
WAMID_TTL_SECONDS=86400

# --- Gateway WhatsApp Local (HMAC-SHA256 E2E) ---
WHATSAPP_GATEWAY_SECRET=sd_e2e_gateway_hmac_secret_2026_local
GATEWAY_SIGNATURE_TTL_SECONDS=300

# --- Plugin Opcional OpenAI (dejar OPENAI_API_KEY vacío para modo determinístico) ---
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_STT_MODEL=gpt-4o-mini-transcribe
OPENAI_TIMEOUT_MS=6500
OPENAI_CALL_TIMEOUT_MS=30000
```

---

### 2A. Opción Recomendada — Levantar todo el stack en 1 comando (Docker Compose)

Levanta **PostgreSQL 16 + Redis 7 + Backend (aplica migraciones Prisma y seed automático) + Frontend Nginx**:

```powershell
docker compose up -d --build
```

Verifica que los servicios estén saludables:

```powershell
curl http://localhost:3000/health
```

- **Frontend SPA:** `http://localhost:5173`
- **Backend API:** `http://localhost:3000`
- **Swagger OpenAPI:** `http://localhost:3000/docs`

Para detener el stack:

```powershell
docker compose down
```

---

### 2B. Opción Alternativa — Desarrollo Local Manual (Hot Reload)

Si prefieres correr Backend y Frontend directamente con Node.js 20 (usando solo PostgreSQL y Redis en Docker):

```powershell
# 1. Levantar únicamente PostgreSQL 16 y Redis 7
docker compose up -d postgres redis

# 2. Instalar dependencias, migrar BD, sembrar datos demo e iniciar Backend
cd backend
npm install
npm run prisma:generate
npm run prisma:deploy
npm run prisma:seed
npm run dev
```

En una segunda terminal, inicia el Frontend:

```powershell
cd frontend
npm install
npm run dev
```

> **Tip para probar el Frontend local contra el Backend productivo en AWS:**  
> Antes de ejecutar `npm run dev` en `frontend/`, define `$env:VITE_API_URL="https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws"` (o usa el selector **`Local / AWS Live`** dentro de `/lab`).

---

### 3. Opcional — Conectar un número real de WhatsApp (Gateway Baileys Local)

No requiere Meta Cloud API ni Chromium; funciona mediante WebSocket y firma digital HMAC-SHA256:

```powershell
cd whatsapp-gateway
Copy-Item .env.example .env
# Verifica en whatsapp-gateway/.env que ORCHESTRATOR_API_URL (http://localhost:3000 o AWS)
# y WHATSAPP_GATEWAY_SECRET coincidan exactamente con el backend.
npm install
npm run dev
```

Escanea el código **QR** en tu terminal desde **WhatsApp → Dispositivos vinculados**. Si prefieres evaluar sin vincular un teléfono físico, utiliza el **Simulador WhatsApp** en `http://localhost:5173/lab/whatsapp`.

---

## Entornos de la Plataforma y Credenciales de Prueba

El archivo `backend/prisma/seed.ts` siembra automáticamente estas cuentas al iniciar el backend:

| Entorno | Rutas | Descripción | Acceso / Credenciales Demo |
| --- | --- | --- | --- |
| **1. Portal Público de Pacientes** | `/`, `/registro`, `/login`, `/laboratorio`, `/mi-cuenta`, `/privacy` | Catálogo, wizard de 3 pasos (Titular o Familiar con privacidad), **llamada de voz WebRTC**, tracking en vivo tipo envío (SSE) y botón para retomar trámites. | Registro libre o `ana@saluddigna.demo` / `Paciente2026!` *(Tel: `+526670000001`)* |
| **2. Estación Call Center** | `/call-center` | Consola de asesores con Screen-Pop SSE, **recepción de llamadas WebRTC + grabación dual-track + resumen IA**, aplicación de entidades y confirmación con Folio + QR + aviso a WhatsApp. | `asesor@saluddigna.demo` / `Asesor2026!` |
| **3. Back-Office Administrador** | `/admin` | 3 vistas: **Estadísticas del Servicio** (KPIs + BullMQ/DLQ), **Consultar Usuario** (PII enmascarada) y **Arquitectura y Bus en vivo**. | `admin@saluddigna.demo` / `Admin2026!` |
| **4. Laboratorio QA / Simuladores** | `/lab`, `/lab/whatsapp`, `/lab/otp-2fa` | **Consola 2FA externa** (códigos OTP de 6 dígitos con TTL) + **Simulador WhatsApp** (mismo motor e idempotencia `SETNX`) + selector `Local / AWS Live`. | Acceso directo QA (sin login) |

---

## Guion de Prueba Omnicanal Sugerido (5 minutos)

1. **Inicio y pausa en Web (`/login` → `/laboratorio`):** Inicia sesión con `ana@saluddigna.demo` / `Paciente2026!`, selecciona un estudio (ej. *Ultrasonido Obstétrico*) y clínica (*Culiacán Centro*) y pulsa **"Guardar para continuar después"** (`PAUSADO_PENDIENTE`).
2. **Salto a WhatsApp + Step-Up OTP (`/lab/whatsapp` y `/lab/otp-2fa`):** Envía *"Hola, quiero continuar con mi estudio"* desde `+526670000001`. El bot detecta el salto de canal y solicita el código OTP. Consulta el código de 6 dígitos en `/lab/otp-2fa` (en otra pestaña) y envíalo al chat para rehidratar el contexto (`CONTEXT_REHYDRATED`).
3. **Duda clínica o llamada WebRTC en vivo:** Escribe una duda (*"¿Necesito ir en ayuno?"*) en WhatsApp, o abre `/call-center` en otra pestaña (`asesor@saluddigna.demo`) y pulsa **"Llamar a un asesor"** desde `/laboratorio` o `/mi-cuenta` para probar el audio P2P WebRTC y el resumen IA automático al colgar (también cuenta con respaldo **"Subir audio / texto"** sin micrófono).
4. **Confirmación en Call Center (`/call-center`):** Asigna el caso, aplica entidades detectadas si usaste llamada/resumen y confirma la cita en 1 clic (`CITA_CONFIRMADA` con Folio + QR).
5. **Verificación en tiempo real (`/mi-cuenta` y `/admin`):** Comprueba que `/mi-cuenta` actualizó el tracker al 100% con el Folio, QR y resumen de llamada vía SSE, y revisa en `/admin` (`admin@saluddigna.demo`) los KPIs, colas BullMQ y la línea de tiempo con PII enmascarada.

---

## Estructura del Repositorio y Documentación Técnica

```text
eva06-nacional/
├── backend/                 # Monolito Modular (Fastify v5, Prisma, BullMQ, WebRTC, OpenAI)
├── frontend/                # SPA React 18 + Vite + Tailwind (4 entornos, WebRTC, Nginx/Vercel)
├── whatsapp-gateway/        # Conector local independiente Baileys + HMAC-SHA256
├── docs/
│   ├── DOCUMENTACION_FASE_II_PROTOTIPO.md         # Documento integral de arquitectura y prototipo
│   ├── architecture/
│   │   ├── 01-overview-and-boundaries.md          # Fronteras, módulos y dependencias reales
│   │   ├── 02-data-flows.md                       # 7 flujos de datos E2E en Mermaid
│   │   └── 03-data-models-and-state.md            # Modelo ER, estados, Redis y variables
│   └── diagramas/
│       ├── arquitectura-monolito-modular.jpg      # Diagrama técnico mostrado en este README
│       └── arquitectura-monolito-modular.html     # Visor interactivo (SVG + PNG 3x)
└── docker-compose.yml       # Stack reproducible: PostgreSQL 16 + Redis 7 + Backend + Frontend
```
