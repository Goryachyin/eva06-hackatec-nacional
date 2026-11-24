# Documentación Técnica de Avance y Alcance Actual
## Reto Salud Digna × TecNM HackaTec 2026 — Orquestación Omnicanal de Atención

> **Fecha de corte:** 24 de noviembre de 2026  
> **Estado global:** **Backend / Cerebro Orquestador 100% desarrollado, probado (5/5) y desplegado en producción real sobre AWS (`us-east-2` — Ohio).**  
> **URL Pública HTTPS (AWS ECS):** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws`  
> **OpenAPI / Swagger en vivo:** `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/docs`

---

## 1. Resumen Ejecutivo del Avance Real

El núcleo del reto —el **Cerebro Orquestador Omnicanal determinístico, stateless y escalable** (sin enfoque *Bot-Bot*)— está construido, validado contra concurrencia/seguridad y operando en vivo en la nube de AWS con PostgreSQL 16 y Valkey/Redis gestionados.

| Área del Proyecto | Avance | Estado Actual |
| :--- | :---: | :--- |
| **Documentación Maestra de Fases 1, 2 y 3 (Word + PDF v3)** | **100%** | Generada y verificada con 4 diagramas (C4, Secuencia OTP, Modelo ER y Flujo Canónico). |
| **Base de Datos Relacional (PostgreSQL 16 + Prisma)** | **100%** | 5 tablas, 7 enums, 9 campos de registro en `patients`, migración SQL y `seed.ts` probados. |
| **Cerebro Orquestador Backend (Node.js TS + Fastify)** | **100%** | 16 endpoints, máquina de 8 estados, bloqueo optimista, BullMQ/DLQ, SSE/PubSub, HMAC y OTP 2FA. |
| **Suite Automatizada de Confiabilidad y Capacidad** | **100%** | 5/5 pruebas aprobadas (`73.5 req/s`, 0% 5xx, idempotencia `wamid`, `409 Conflict`, OTP 2FA). |
| **Despliegue Cloud-Native en AWS (`us-east-2`)** | **95%** | ECR + ECS Express Mode + RDS + ElastiCache + HTTPS activos; pendiente solo seed en RDS y prueba contra URL AWS. |
| **Conexión Webhook Real Meta WhatsApp Cloud API** | **70%** | Código 100% listo (`GET` verify + `POST` HMAC-SHA256 + `wamid` + Graph API); falta cargar variables Meta en ECS y validar en panel Meta. |
| **Frontend de Visualización (`frontend/` — Programador 1)** | **0%** | Pendiente construir vistas ligeras React/Vite (`/web`, `/whatsapp-sim`, `/otp-2fa`, `/call-center`, `/admin`, `/privacy`). |
| **Manual Técnico, Manual de Usuario y `README.md` (Programador 2)** | **25%** | Base técnica documentada en este archivo y en la Plantilla v3; falta redactar manuales finales y capturas de Fase 2. |

---

## 2. Infraestructura Real Desplegada en AWS (`us-east-2` — Ohio)

Toda la infraestructura de nube fue probada y validada dentro de los límites de permisos organizacionales (SCP) de la cuenta AWS `032619915922` en la región **`us-east-2`**:

```mermaid
flowchart LR
    USER["Navegador / Frontend / Meta WhatsApp"] -->|"HTTPS 443 (Certificado AWS ACM)"| ALB["ALB Express Gateway (us-east-2)"]
    ALB -->|"HTTP :3000 (/health)"| ECS["Amazon ECS Express Mode (Fargate)\neva06-docker-b546\nImagen ECR: eva06-docker:latest"]
    ECS -->|"TCP :5432 (SSL require)\nVPC 172.31.0.0/16"| RDS[("Amazon RDS\nPostgreSQL 16\nsd-omnicanal-db")]
    ECS -->|"TCP :6379 (prefix {bull})\nVPC 172.31.0.0/16"| CACHE[("Amazon ElastiCache\nValkey / Redis\nsd-omnicanal-redis")]
    ECS -.->|"Logs estructurados"| CW["Amazon CloudWatch\n/aws/ecs/default/eva06-docker-b546-ef7c"]
```

### Inventario de Recursos AWS Activos
- **Región activa:** `us-east-2` (US East — Ohio)
- **Red privada (VPC):** `vpc-0e12c96e4fc6fe571` (`172.31.0.0/16`, 3 subredes en `us-east-2a`, `2b`, `2c`)
- **Security Group:** `sg-0f7d5acad8f3a0fa7` (`default`) con reglas internas privadas únicamente desde `172.31.0.0/16` hacia puertos **`5432`** (PostgreSQL) y **`6379`** (Valkey/Redis).
- **Registro de contenedores (ECR):** `032619915922.dkr.ecr.us-east-2.amazonaws.com/eva06-docker:latest`
- **Cómputo Serverless (ECS Express Mode / Fargate):** servicio `eva06-docker-b546` en clúster `default`, arquitectura `X86_64` (`linux/amd64`), puerto `3000`, healthcheck `/health`, despliegue continuo **Zero-Downtime Rolling Update** verificado.
- **Base de datos relacional (RDS):** `sd-omnicanal-db` (PostgreSQL 16, Capa Gratuita, base `omnicanal`, autenticación por contraseña + `sslmode=require`).
- **Caché / Colas / Bus (ElastiCache):** `sd-omnicanal-redis` (Valkey `cache.t4g.micro`, compatible Redis 7, operando con BullMQ `prefix: "{bull}"`).
- **Certificado TLS y Balanceador:** AWS Certificate Manager (ACM) + Application Load Balancer (`ecs-express-gateway-alb-ee6daed5`) → HTTPS nativo en `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws`.

---

## 3. Inventario Completo de Archivos Desarrollados

### Raíz del Repositorio
| Archivo | Propósito |
| :--- | :--- |
| `docker-compose.yml` | Orquestación local reproducible: PostgreSQL 16 (puerto host `5433:5432`), Redis 7 (`AOF` + `maxmemory-policy noeviction`), `backend` y `frontend`. |
| `.env` / `.env.example` | Variables locales (protegidas por `.gitignore`) y plantilla pública segura para GitHub. |
| `.gitignore` | Evita filtrar `.env`, `node_modules/`, `dist/` y temporales. |
| `Plantilla_Completa_Reto_Salud_Digna_HackaTec.docx` | Plantilla editable Word v3 (Fases 1, 2 y 3 + 4 diagramas embebidos). |
| `Plantilla_Completa_Reto_Salud_Digna_HackaTec_v3.pdf` | Versión PDF v3 verificada visualmente (15 páginas). |

### Backend — Cerebro Orquestador (`backend/`)
| Archivo | Responsabilidad Técnica |
| :--- | :--- |
| `backend/Dockerfile` + `.dockerignore` | Build multi-stage sobre **`node:20-slim` (LTS)** con OpenSSL, `prisma generate`, compilación TS y ejecución automática de `prisma migrate deploy` al iniciar. |
| `backend/prisma/schema.prisma` | 5 modelos (`patients` con los 9 campos de registro, `identity_links`, `service_cases`, `journey_events`, `users_staff`) + 7 enums canónicos. |
| `backend/prisma/migrations/20261124042007_init_omnicanal/migration.sql` | Migración SQL oficial versionada y aplicada tanto en local como automáticamente en AWS RDS. |
| `backend/prisma/seed.ts` | Seed idempotente: usuarios RBAC (`asesor@saluddigna.demo` / `admin@saluddigna.demo`) y paciente demo **Ana Sofía Morales Ramírez** con sus `identity_links` (`PHONE` y `CURP`). |
| `backend/src/config/env.ts` | Validación estricta de variables de entorno al arranque con `zod`. |
| `backend/src/lib/prisma.ts` | Cliente singleton de PostgreSQL/Prisma. |
| `backend/src/lib/redis.ts` | Clientes separados `ioredis` (comandos atómicos/publish, suscriptor dedicado Pub/Sub SSE y fábrica BullMQ). |
| `backend/src/lib/crypto.ts` | Normalización E.164 de teléfonos, hash HMAC-SHA256 con pepper, enmascaramiento PII, validación `X-Hub-Signature-256` con `timingSafeEqual`, OTP de 6 dígitos y JWT. |
| `backend/src/data/catalog.ts` | Catálogo realista de 6 estudios Salud Digna (precios y preparación) y 4 clínicas. |
| `backend/src/core/stateMachine.ts` | **Máquina de estados determinística** (8 estados canónicos), **bloqueo optimista (`version` → HTTP 409)** y generador determinístico de `handoff_summary`. |
| `backend/src/core/identityService.ts` | **Identity Stitching** progresivo (CURP → PHONE → WEB_SESSION → EMAIL) + **Step-Up OTP** en Redis (`TTL 300s`, máx. 3 intentos, `OTP_VALIDATION_FAILED`, bandeja 2FA externa). |
| `backend/src/core/eventBus.ts` | Registro inmutable en `journey_events` (`journey_id` + `correlation_id`) + publicación en Redis Pub/Sub con PII enmascarada. |
| `backend/src/queues/whatsappQueue.ts` | Colas **BullMQ** (`whatsapp-inbound` con 3 reintentos exponenciales + `whatsapp-dlq`) con `prefix: "{bull}"` (Cluster-safe), worker determinístico de WhatsApp y cliente Meta Graph API. |
| `backend/src/middleware/rbac.ts` | Guard JWT para roles `ASESOR` y `ADMIN` (soporta `Authorization: Bearer` y `?token=` para SSE). |
| `backend/src/routes/*.ts` | 7 módulos de rutas (`health`, `auth`, `webChannel`, `whatsappWebhook`, `otp2fa`, `callCenter`, `admin`) documentados en OpenAPI 3 (`/docs`). |
| `backend/src/index.ts` | Bootstrap Fastify v5 + CORS + `fastify-raw-body` + Swagger/OpenAPI + Worker BullMQ + error handler + graceful shutdown. |
| `backend/src/scripts/testReliability.ts` | Suite automatizada de 5 pruebas de seguridad, idempotencia, concurrencia optimista, OTP y ráfaga de carga (`npm run test:reliability`). |

---

## 4. Decisiones de Arquitectura Documentadas (ADRs Resueltas en Campo)

Esta bitácora está lista para que el **Programador 2** la incluya en `docs/MANUAL_TECNICO.md` ante los Tech Leads de Salud Digna:

1. **ADR-01 — Núcleo Determinístico (Anti *Bot-Bot*):** El estado de los trámites se rige por una máquina de estados finita tipada (8 estados canónicos) en PostgreSQL 16, y el resumen para Call Center (`handoff_summary`) se construye determinísticamente desde `context_json`. Cero alucinaciones, cero latencia de LLM y cero costo por token en el flujo crítico.
2. **ADR-02 — Persistencia Híbrida (PostgreSQL 16 + Redis 7):** Los datos transaccionales y de auditoría inmutable viven en PostgreSQL (`service_cases` con `JSONB` + `version`, `journey_events` con `correlation_id`), mientras que el estado efímero y el bus de eventos viven en Redis (`SETNX` con TTL 24h para `wamid`, TTL 5 min para OTP, BullMQ/DLQ y Pub/Sub para SSE). Esto mantiene los nodos de Node.js **100% stateless**.
3. **ADR-03 — Runtime Fijado en Docker `node:20-slim` (LTS):** En desarrollo local sobre Windows con Node v26 (*Current*) se detectaron bloqueos de scripts nativos y cortes TLS al descargar binarios de Prisma. Encapsular el build en un `Dockerfile` multi-stage sobre **Node 20 LTS** eliminó la dependencia del entorno del desarrollador y garantizó despliegue idéntico en local y en AWS ECS.
4. **ADR-04 — Compatibilidad BullMQ con AWS ElastiCache Valkey Cluster Mode:** Al desplegar en AWS ElastiCache Valkey (`us-east-2`), los scripts Lua multi-clave de BullMQ arrojaron `ReplyError: CROSSSLOT`. Se aplicó el patrón oficial `prefix: "{bull}"` (Redis Hash Tags) y eliminación individual de claves en `reset-demo`, logrando 100% compatibilidad tanto en Redis standalone (Docker local) como en Valkey Cluster Mode (AWS).
5. **ADR-05 — Seguridad Perimetral y Privacidad Clínica (PII):** Firma criptográfica `X-Hub-Signature-256` validada sobre `rawBody` con `timingSafeEqual`; idempotencia atómica `wamid`; Step-Up OTP entregado fuera de banda en `/api/otp-2fa/inbox` con auditoría `OTP_VALIDATION_FAILED`; RBAC JWT para `ASESOR`/`ADMIN`; PII enmascarada en el Tablero Admin; y aislamiento de RDS (`5432`) y ElastiCache (`6379`) al CIDR privado de la VPC (`172.31.0.0/16`).
6. **ADR-06 — Región AWS `us-east-2` y Zero-Downtime Rolling Updates:** Se respetó la Service Control Policy organizacional operando íntegramente en `us-east-2` (Ohio), comprobando actualizaciones sin interrupción en ECS Express Mode (levantando tarea nueva y drenando la anterior tras pasar `/health`).

---

## 5. Catálogo de Endpoints Operativos (Contrato para Frontend — Programador 1)

Todos los endpoints están documentados e interactuables en vivo en **`/docs`** (Swagger UI):

| Método | Ruta | Auth / Seguridad | Propósito |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Pública | Verifica conexión a PostgreSQL, Redis y métricas de colas BullMQ/DLQ. |
| `GET` | `/docs` | Pública | Documentación interactiva OpenAPI 3 / Swagger UI. |
| `GET` | `/api/catalog` | Pública | Devuelve catálogo de estudios (precios/preparación) y clínicas. |
| `POST` | `/api/auth/login` | Pública | Autentica `ASESOR` o `ADMIN` y entrega token JWT (12h). |
| `POST` | `/api/channels/web/register` | Pública | Registra/enriquece paciente (9 campos) y vincula `identity_links`. |
| `POST` | `/api/channels/web/quote` | Pública | Cotiza estudio y selecciona clínica (`COTIZANDO` / `CLINICA_ELEGIDA`, con `version`). |
| `POST` | `/api/channels/web/abandon` | Pública | Registra abandono parcial (`FLOW_INTERRUPTED` → `PAUSADO_PENDIENTE`). |
| `GET` | `/api/channels/web/case` | Pública | Recupera trámite por `?telefono=`, `?curp=` o `?webSessionId=` (salto inverso WA → Web). |
| `GET` | `/webhooks/whatsapp` | `hub.verify_token` | Verificación inicial del Webhook en Meta for Developers. |
| `POST` | `/webhooks/whatsapp` | `X-Hub-Signature-256` | Recepción segura de mensajes reales Meta + `SETNX wamid` + BullMQ (`200 OK` `<200ms`). |
| `POST` | `/api/channels/whatsapp/simulate` | Idempotencia `wamid` | Simulador Dual WhatsApp conectado a la misma lógica del orquestador. |
| `GET` | `/api/channels/whatsapp/history/:phone` | Pública (Demo) | Devuelve burbujas del chat simulado para visualizar en Frontend. |
| `GET` | `/api/otp-2fa/inbox` | Pública (Consola 2FA) | Bandeja externa de códigos OTP activos en Redis con TTL restante. |
| `GET` | `/api/call-center/queue` | JWT (`ASESOR`/`ADMIN`) | Bandeja del Asesor con `handoff_summary`, contexto y últimos eventos. |
| `POST` | `/api/call-center/cases/:caseId/assign` | JWT (`ASESOR`/`ADMIN`) | Asigna caso (`ADVISOR_ASSIGNED` → `EN_ATENCION_ASESOR`) y dispara Screen-Pop SSE. |
| `POST` | `/api/call-center/cases/:caseId/confirm` | JWT (`ASESOR`/`ADMIN`) | Confirma cita en 1 clic (`APPOINTMENT_CONFIRMED` → `CITA_CONFIRMADA`), genera folio y QR. |
| `GET` | `/api/admin/overview` | JWT (`ADMIN`) | KPIs en vivo, estado BullMQ/DLQ y lista de casos con **PII enmascarada**. |
| `GET` | `/api/admin/cases/:caseId/timeline` | JWT (`ASESOR`/`ADMIN`) | Línea de tiempo inmutable (`journey_events`) con `correlation_id`. |
| `GET` | `/api/stream/events` | JWT (`header` o `?token=`) | Stream **Server-Sent Events (SSE)** en tiempo real respaldado por Redis Pub/Sub. |
| `POST` | `/api/admin/reset-demo` | JWT (`ADMIN`) | Limpia casos/eventos y claves Redis temporales para reiniciar demo ante el jurado. |

---

## 6. Evidencia de Pruebas Ejecutadas Hasta Hoy

### A. Suite de Confiabilidad (`npm run test:reliability` — 5/5 Aprobadas)
- **Seguridad Webhook HMAC:** petición con firma inválida rechazada antes de tocar BullMQ.
- **Idempotencia `wamid` (Redis `SETNX`):** 10 envíos paralelos del mismo `wamid` → **1 procesado, 9 descartados**.
- **Concurrencia Optimista (`version`):** 2 escrituras simultáneas con la misma versión → **1 HTTP 200, 1 HTTP 409 Conflict**.
- **Step-Up OTP Out-of-Band:** OTP inválido bloqueado y auditado (`OTP_VALIDATION_FAILED`) → OTP real leído en `/api/otp-2fa/inbox` rehidrató contexto (`CONTEXT_REHYDRATED`).
- **Capacidad bajo Ráfaga:** **60 flujos concurrentes** con **0% errores 5xx** y throughput sostenido de **73.5 req/s** (equivalente a >6 millones de solicitudes diarias frente al volumen de ~1,000 pacientes/día de Salud Digna).

### B. Validación de Producción AWS (`/health`)
Respuesta real verificada sobre `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/health`:
- `status: "ok"`, `postgres: "connected"`, `redis: "connected"`, `whatsappInbound.failed: 0`, `whatsappDlq.failed: 0`.

---

## 7. Alcance Exacto Ahora Mismo: Qué Falta para Cerrar al 100%

### 🟡 Pendientes Rápidos del Programador Líder (Backend / AWS / Meta) — ~30 min
1. **Confirmar Rolling Update en AWS y correr `test:reliability` contra la URL de AWS** (guardar captura para Fase 2 y Manual Técnico).
2. **Ejecutar el `seed` contra AWS RDS** (para tener a `asesor@saluddigna.demo`, `admin@saluddigna.demo` y `Ana` cargados también en producción AWS).
3. **Configurar las 3 variables de Meta Developers en ECS** (`META_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`) y verificar el Webhook real en Meta Developers apuntando a:
   `https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws/webhooks/whatsapp`

### 🔲 Pendiente del Programador 1 (Frontend Ligero de Visualización)
Crear carpeta `frontend/` (React + Vite + TailwindCSS + `Dockerfile` Nginx) consumiendo los endpoints de la Sección 5:
- `/web`: Registro rápido (9 campos) + cotizador de estudios/clínicas + botón **"Simular cierre / abandono"**.
- `/whatsapp-sim`: Simulador Dual WhatsApp + selector de teléfono (respaldo si el jurado prueba sin WhatsApp real).
- `/otp-2fa`: Consola 2FA externa independiente (polling a `/api/otp-2fa/inbox` mostrando código + cuenta regresiva TTL).
- `/call-center`: Login Asesor + Screen-Pop en tiempo real (SSE) + tarjeta **Resumen Handoff** + Timeline + botón **"Confirmar cita en 1 clic"**.
- `/admin`: Login Admin + **Tablero Patient Journey SSE en vivo** + KPIs + métricas BullMQ/DLQ + PII enmascarada + botón **"Reset Demo"**.
- `/privacy`: Página estática de Política de Privacidad (requisito para publicar app en Meta Developers).
- `/app` *(Stretch Goal — solo si los 3 canales Core están 100% estables)*: Vista móvil con folio confirmado y código QR.

### 🔲 Pendiente del Programador 2 (Documentación Final y GitHub — Cierre Día 3, 11:00 AM)
- Redactar `/README.md` raíz (instalación Docker, credenciales por rol, comandos y pasos exactos del demo).
- Redactar `/docs/MANUAL_TECNICO.md` (ampliando este documento con capturas de CloudWatch, ECS, RDS, ElastiCache y `test:reliability` en AWS).
- Redactar `/docs/MANUAL_USUARIO.md` (guía visual paso a paso por rol).
- Completar los campos `[COMPLETAR: ...]` y las 4 capturas de Fase 2 en `Plantilla_Completa_Reto_Salud_Digna_HackaTec.docx` y exportar la versión final a PDF.

---

## 8. Comandos de Referencia Rápida (Operación Diaria)

```powershell
# --- DESARROLLO LOCAL ---
docker compose up -d postgres redis
cd backend && npm run dev
npm run test:reliability

# --- ACTUALIZAR IMAGEN EN AWS ECR Y REDESPLEGAR EN ECS (us-east-2) ---
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 032619915922.dkr.ecr.us-east-2.amazonaws.com
docker build --platform linux/amd64 -t eva06-docker:latest ./backend
docker tag eva06-docker:latest 032619915922.dkr.ecr.us-east-2.amazonaws.com/eva06-docker:latest
docker push 032619915922.dkr.ecr.us-east-2.amazonaws.com/eva06-docker:latest
aws ecs update-service --cluster default --service eva06-docker-b546 --force-new-deployment --region us-east-2

# --- LOGS EN VIVO DE AWS CLOUDWATCH ---
aws logs tail /aws/ecs/default/eva06-docker-b546-ef7c --region us-east-2 --follow

# --- PROBAR SUITE DE CONFIABILIDAD CONTRA AWS ---
$env:TEST_BASE_URL="https://ev-d0aa51b63f3f44759887677b237d298f.ecs.us-east-2.on.aws"
npm --prefix backend run test:reliability
```
