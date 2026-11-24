# Salud Digna × HackaTec Nacional 2026 — Beta v2
## Orquestación Omnicanal de Atención: *"Un paciente, una sola conversación"*

Prototipo productivo de arquitectura omnicanal determinística (**sin lógica Bot-Bot** y **sin dependencias de Meta Cloud API**) con soporte **Multibeneficiario** (un mismo teléfono/cuenta puede agendar para familiares o conocidos respetando la privacidad clínica LFPDPPP), **Gateway WhatsApp propio (Baileys local) con firma digital HMAC-SHA256 extremo a extremo**, **rastreo visual en vivo tipo envío (Amazon / Mercado Libre)** y **continuidad de N-saltos bidireccionales** entre Sitio Web, WhatsApp y Call Center.

---

## Arquitectura del Sistema (Beta v2)

| Capa | Tecnología | Rol |
| --- | --- | --- |
| **Frontend SPA (4 Entornos Aislados)** | React 18 + TypeScript + Vite + Tailwind CSS + Nginx | Portal Público de Pacientes (cuenta propia + familiares + tracker en vivo), Back-Office Admin (KPIs + Consulta Usuario + Vista Bus en vivo), Call Center y Laboratorio QA |
| **Gateway WhatsApp Local** | Node.js 20 + `@whiskeysockets/baileys` (WebSocket sin Chromium) | Conecta un número real propio de WhatsApp por QR y se comunica con AWS mediante **firma digital HMAC-SHA256 bidireccional** + ventana anti-replay (`300s`) |
| **Cerebro Orquestador** | Node.js 20 LTS + TypeScript + Fastify v5 + Prisma ORM | Máquina de estados determinística (8 estados, N-saltos), Identity Resolution Multibeneficiario (`Titular ≠ Beneficiario`), Lock Optimista (`version` → HTTP 409) y JWT segregado (`PATIENT` vs `STAFF`) |
| **Persistencia Transaccional** | PostgreSQL 16 (AWS RDS / Docker) | 6 tablas: `patients`, `patient_relationships`, `identity_links`, `service_cases` (`patient_id` Beneficiario + `requester_patient_id` Titular + `JSONB`), `journey_events` y `users_staff` |
| **Bus de Datos y Estado Efímero** | Redis 7 / AWS ElastiCache Valkey | Colas **BullMQ** (`prefix: "{bull}"`) + **DLQ**, idempotencia `SETNX` (24h), Step-Up **OTP** (5m), menú activo familiar (`wa:active_case`), y **Pub/Sub** (`journey:events` + `whatsapp:outbound`) → **SSE** |

> Diagramas de alta resolución disponibles en [`docs/diagramas/fig1_bus_datos_modulos_v4.png`](docs/diagramas/fig1_bus_datos_modulos_v4.png) y [`docs/diagramas/fig3_modelo_er_multibeneficiario_v4.png`](docs/diagramas/fig3_modelo_er_multibeneficiario_v4.png).

---

## Entorno Productivo en Vivo (AWS `us-east-2`)

- **Backend API (ECS Fargate):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws`
- **Healthcheck:** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/health`
- **Documentación OpenAPI (Swagger):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/docs`
- **Estado del Gateway Baileys:** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/api/gateways/whatsapp/status`

---

## Inicio Rápido

### 1. Stack Backend + Frontend (Docker Compose o Dev local)

```powershell
# Opción A: Stack completo en Docker
docker compose up -d --build

# Opción B: Frontend en vivo apuntando a AWS
cd frontend
npm install
$env:VITE_API_URL="https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws"
npm run dev
```

### 2. Gateway WhatsApp Local (Baileys con número propio y firma E2E HMAC-SHA256)

```powershell
cd whatsapp-gateway
Copy-Item .env.example .env
# Asegúrate de que WHATSAPP_GATEWAY_SECRET coincida exactamente con el del backend
npm install
npm run dev
```
Escanea el código **QR** en tu terminal desde **WhatsApp → Dispositivos vinculados**. A partir de ese instante, todo mensaje entrante y saliente viaja firmado criptográficamente (`X-Gateway-Signature` + `X-Gateway-Timestamp`) hacia tu Cerebro Orquestador en AWS.

---

## Rutas y 4 Entornos Independientes

| Entorno | Rutas | Descripción | Acceso |
| --- | --- | --- | --- |
| **1. Portal Público de Pacientes** | `/`, `/registro`, `/login`, `/laboratorio`, `/mi-cuenta`, `/privacy` | Cuenta propia (`bcrypt`/JWT), citas para **Titular o Familiar/Conocido** con privacidad clínica, **tracking en vivo estilo Amazon/Mercado Libre (SSE)** y botón para retomar solicitudes tras N-saltos. | Registro libre o `ana@saluddigna.demo` / `Paciente2026!` |
| **2. Back-Office Administrador** | **`/admin`** | Aislado con 3 vistas: **Estadísticas del Servicio**, **Consultar Usuario (Tracking estilo envío)** y **Arquitectura y Bus de Datos en tiempo real**. | `admin@saluddigna.demo` / `Admin2026!` |
| **3. Estación Call Center** | `/call-center` | Consola de asesores con Screen-Pop SSE, Resumen Handoff (Titular/Beneficiario) y confirmación con Folio + QR + aviso firmado a WhatsApp. | `asesor@saluddigna.demo` / `Asesor2026!` |
| **4. Laboratorio QA / Simuladores** | `/lab`, `/lab/whatsapp`, `/lab/otp-2fa` | Consola 2FA externa (códigos OTP 6 dígitos) + Simulador WhatsApp de respaldo + selector `Local / AWS Live`. | Uso interno QA |

---

## Pruebas Automatizadas de Confiabilidad (`>= 1,000 pacientes/día`)

```powershell
cd backend
npm run test:reliability
```
Valida firma digital HMAC-SHA256 E2E (rechazo HTTP 401), idempotencia `SETNX` (10 paralelos → 1/9), bloqueo optimista (`HTTP 409`), Step-Up OTP out-of-band (`OTP_VALIDATION_FAILED`) y ráfaga concurrente con 0% errores 5xx.
