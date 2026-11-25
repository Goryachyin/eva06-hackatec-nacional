# 02 — Flujos de Datos Críticos (Extremo a Extremo)

Este documento reconstruye los seis flujos de datos críticos del sistema a partir de la ejecución real observada en `frontend/`, `backend/` y `whatsapp-gateway/`. Cada diagrama muestra cómo se valida, transforma, persiste y difunde la información desde su origen hasta su destino final.

---

## Flujo 1 — Registro, Autenticación y Reconciliación Omnicanal (Pacientes y Staff)

Cubre los dos esquemas de autenticación segregados por `scope` de JWT (`PATIENT` vs `STAFF`) y la fusión automática de expedientes sombra (creados previamente en WhatsApp, Call Center o sesión web invitada) al registrarse, iniciar sesión o consultar `/api/patients/me`.

```mermaid
flowchart TD
    subgraph PAC["Flujo de Cuenta de Paciente"]
        P_UI["PatientRegisterPage o PatientLoginPage"]
        P_REG["POST /api/patients/auth/register"]
        P_LOG["POST /api/patients/auth/login"]
        P_ZOD["Zod patientRegisterSchema o patientLoginSchema"]
        P_RES["resolveOrCreatePatient y pickCanonicalMaster"]
        P_BCRYPT["bcrypt hash o compare"]
        P_REC["reconcilePatientOmnichannelHistory"]
        P_MERGE["mergePatientProfiles transaccion Prisma"]
        P_JWT["signPatientJwt scope PATIENT 7d"]
        P_STORE["localStorage sd_patient_token y evento DOM"]
    end

    subgraph STF["Flujo de Staff RBAC"]
        S_UI["AdminDashboard o CallCenterPage"]
        S_LOG["POST /api/auth/login"]
        S_ZOD["Zod loginSchema"]
        S_DB["Consulta users_staff y bcrypt compare"]
        S_JWT["signStaffJwt scope STAFF 12h"]
        S_STORE["localStorage sd_token_ADMIN o sd_token_ASESOR"]
    end

    PG["PostgreSQL patients identity_links service_cases journey_events"]
    BUS["recordAndPublishEvent Redis journey:events"]

    P_UI -->|Payload registro 9 campos + email + pass| P_REG
    P_UI -->|identifier correo tel o CURP + pass| P_LOG
    P_REG --> P_ZOD
    P_LOG --> P_ZOD
    P_ZOD -->|Registro| P_RES
    P_RES --> P_BCRYPT
    P_BCRYPT -->|Actualiza email y passwordHash| PG
    P_BCRYPT --> P_REC
    P_ZOD -->|Login consulta users| PG
    PG -->|Valida bcrypt| P_REC
    P_REC -->|Si hay expedientes sombra compatibles| P_MERGE
    P_MERGE -->|Reasigna casos eventos links relaciones y borra sombras| PG
    P_MERGE -->|Si syncedCasesCount mayor a 0 emite IDENTITY_LINKED| BUS
    P_REC --> P_JWT
    P_JWT -->|Token + perfil + syncedCasesCount| P_STORE

    S_UI -->|email y password| S_LOG
    S_LOG --> S_ZOD
    S_ZOD --> S_DB
    S_DB --> S_JWT
    S_JWT -->|Token + StaffUser| S_STORE
```

### Traza paso a paso (evidencia real)
1. **Registro de paciente:** `PatientRegisterPage.tsx` genera la CURP determinísticamente con `generateDeterministicCurp` (`frontend/src/lib/curp.ts`) y envía los 9 campos más correo, contraseña y `webSessionId` a `POST /api/patients/auth/register` (`backend/src/routes/patientAuth.ts`).
2. **Validación y resolución:** `patientRegisterSchema.parse` valida el payload. Si el correo no tiene `passwordHash`, `resolveOrCreatePatient` (`backend/src/core/identityService.ts`) busca candidatos por `CURP`, `PHONE`, `EMAIL` y `WEB_SESSION`, selecciona el expediente maestro (`pickCanonicalMaster`) y fusiona registros compatibles (`canSafelyMergePatients` impide fusionar dos CURPs diferentes o dos cuentas con `passwordHash`).
3. **Persistencia de credenciales y reconciliación:** Se calcula `bcrypt.hash(password, 10)`, se actualiza `patients`, se crea `identity_links` (`EMAIL`, `verified: true`) y se ejecuta `reconcilePatientOmnichannelHistory` -> `mergePatientProfiles` dentro de `prisma.$transaction`, reasignando `service_cases`, `journey_events`, `identity_links` y `patient_relationships` y borrando los registros sombra. Si hubo casos sincronizados, publica `IDENTITY_LINKED` vía `recordAndPublishEvent`.
4. **Login de paciente:** `POST /api/patients/auth/login` resuelve al paciente por correo, CURP (18 chars) o teléfono normalizado con `passwordHash != null`, valida `bcrypt.compare`, ejecuta `reconcilePatientOmnichannelHistory` y devuelve `signPatientJwt` (`expiresIn: "7d"`, `scope: "PATIENT"`). En el navegador, `savePatientSession` (`frontend/src/lib/api.ts`) guarda en `localStorage` y dispara `window.dispatchEvent(new Event("sd-patient-auth-change"))`.
5. **Login de Staff (RBAC):** `POST /api/auth/login` (`backend/src/routes/auth.ts`) autentica contra `users_staff` (`active: true`), verifica `bcrypt.compare` y emite `signStaffJwt` (`expiresIn: "12h"`, `scope: "STAFF"`). El middleware `requireStaffRole` (`backend/src/middleware/rbac.ts`) valida rol (`ADMIN` o `ASESOR`) desde header `Authorization: Bearer` o query `?token=`.

---

## Flujo 2 — Cotización Web, Soporte Multibeneficiario, Pausa y Confirmación

Cubre el wizard de 3 pasos en `LaboratorioPage.tsx` (incluyendo agendamiento para un tercero con expediente separado) y la reanudación bidireccional de trámites en Web.

```mermaid
flowchart TD
    UI["LaboratorioPage Wizard 3 pasos"]
    DRAFT["localStorage sd_omnicanal_booking_drafts_v1"]
    REG["POST /api/channels/web/register"]
    QUOTE["POST /api/channels/web/quote"]
    CAT["findStudyByCode y findClinicById en catalog.ts"]
    HOLDER["resolveOrCreatePatient Titular"]
    DEC_3P{"forThirdParty y beneficiary?"}
    CONSENT["Valida thirdPartyConsent true"]
    BENEF["resolveOrCreateBeneficiary CURP y PatientRelationship"]
    CASE_OP["Busca o crea ServiceCase INICIADO"]
    SM_Q["transitionServiceCase COTIZANDO y CLINICA_ELEGIDA"]
    ABANDON["POST /api/channels/web/abandon"]
    SM_P["transitionServiceCase PAUSADO_PENDIENTE"]
    RESUME["POST /api/channels/web/cases/:caseId/resume"]
    SM_R["transitionServiceCase EN_PROGRESO"]
    CONFIRM["POST /api/channels/web/cases/:caseId/confirm"]
    SM_C["transitionServiceCase CITA_CONFIRMADA Folio y QR"]
    PG["PostgreSQL patients service_cases journey_events"]
    BUS["Redis PubSub journey:events"]
    WA_OUT["publishSignedGatewayOutbound Redis whatsapp:outbound"]

    UI <-->|Guarda y rehidrata borrador local| DRAFT
    UI -->|Paso 2 Titular| REG
    REG --> HOLDER
    UI -->|Paso 1 y Paso 2| QUOTE
    QUOTE --> CAT
    CAT --> HOLDER
    HOLDER --> DEC_3P
    DEC_3P -->|Si| CONSENT
    CONSENT --> BENEF
    BENEF --> CASE_OP
    DEC_3P -->|No| CASE_OP
    CASE_OP --> SM_Q
    SM_Q -->|Lock optimista version +1| PG
    SM_Q -->|Emite STUDY_QUOTED CLINIC_SELECTED| BUS

    UI -->|Guardar para despues| ABANDON
    ABANDON --> SM_P
    SM_P -->|FLOW_INTERRUPTED| PG
    SM_P --> BUS

    UI -->|Retomar desde Mi Cuenta| RESUME
    RESUME --> SM_R
    SM_R -->|CHANNEL_SWITCH_DETECTED y CONTEXT_REHYDRATED| PG
    SM_R --> BUS

    UI -->|Paso 3 Confirmar cita| CONFIRM
    CONFIRM --> SM_C
    SM_C -->|APPOINTMENT_CONFIRMED| PG
    SM_C --> BUS
    SM_C -->|Si hay telefono de titular o paciente| WA_OUT
```

### Traza paso a paso (evidencia real)
1. **Carga inicial y rehidratación:** Al montar `LaboratorioPage.tsx`, consulta `GET /api/catalog` y, si hay JWT de paciente, `GET /api/patients/me` (o `GET /api/channels/web/case?webSessionId=...` si es invitado). Si recibe `?resumeCaseId=`, `hydrateFromCase` combina `serviceCase.contextJson` con `getBookingDraft(caseId)` de `localStorage` e invoca `inferResumeStep` (`frontend/src/lib/bookingContext.ts`).
2. **Paso 1 y 2 (`POST /api/channels/web/quote`):** `backend/src/routes/webChannel.ts` valida el payload con `quoteSchema`, busca estudio y clínica en `backend/src/data/catalog.ts` y resuelve al titular con `resolveOrCreatePatient`.
3. **Bifurcación Multibeneficiario:** Si `forThirdParty && beneficiary`, exige `thirdPartyConsent === true` (si no, responde `400 CONSENT_REQUIRED`) y ejecuta `resolveOrCreateBeneficiary` (`backend/src/core/identityService.ts`), que crea/actualiza un registro independiente en `patients` indexado solo por su propia `CURP` en `identity_links` (sin apropiarse del `PHONE` del titular) y hace upsert en `patient_relationships`.
4. **Transición con bloqueo optimista:** Se crea el `ServiceCase` (`patientId = beneficiario`, `requesterPatientId = titular`) o se detecta salto de canal (`CHANNEL_SWITCH_DETECTED`). Luego `transitionServiceCase` (`backend/src/core/stateMachine.ts`) actualiza `service_cases` con `WHERE id = ? AND version = expectedVersion` (`version: { increment: 1 }`). Si otro canal modificó la fila antes, `updateResult.count === 0` lanza `OptimisticLockError` -> HTTP `409 OPTIMISTIC_LOCK_CONFLICT`.
5. **Pausa, reanudación y confirmación:**
   - `POST /api/channels/web/abandon` transiciona a `PAUSADO_PENDIENTE` (`FLOW_INTERRUPTED`).
   - `POST /api/channels/web/cases/:caseId/resume` emite `CHANNEL_SWITCH_DETECTED` (si venía de otro canal) y transiciona a `EN_PROGRESO` (`CONTEXT_REHYDRATED`).
   - `POST /api/channels/web/cases/:caseId/confirm` genera `folio = SD-2026-XXXX` y `qr_payload`, transiciona a `CITA_CONFIRMADA`, limpia el borrador local (`clearBookingDraft`) y llama a `publishSignedGatewayOutbound` para enviar confirmación firmada al teléfono del titular/paciente vía WhatsApp.

---

## Flujo 3 — Ingesta Asíncrona WhatsApp (Gateway Baileys HMAC-SHA256, BullMQ y Salida SSE)

Muestra el transporte bidireccional cifrado/firmado entre `whatsapp-gateway/` y `backend/`, incluyendo idempotencia atómica, reintentos, Dead Letter Queue (DLQ) y el camino paralelo síncrono del Simulador QA.

```mermaid
flowchart TD
    subgraph WA_LOCAL["whatsapp-gateway Proceso Local"]
        WA_IN["Evento Baileys messages.upsert"]
        LID["Resolucion LID y normalizeDigits"]
        SIGN_IN["signGatewayPayload HMAC-SHA256 + ts"]
        SSE_CLI["startOutboundSseLoop GET /outbound/stream"]
        VER_OUT["verifyOrchestratorSignature tiempo constante"]
        WA_SEND["activeSock.sendMessage a targetJid"]
    end

    subgraph SIM["Camino Paralelo QA"]
        SIM_UI["WhatsAppSimPage"]
        SIM_EP["POST /api/channels/whatsapp/simulate"]
    end

    subgraph ORQ["Backend Fastify y Worker BullMQ"]
        IN_EP["POST /api/gateways/whatsapp/inbound rawBody"]
        VER_IN["verifyGatewaySignature ventana 300s"]
        IDEMP["claimMessageId Redis SETNX wamid 24h"]
        Q_IN["Cola BullMQ whatsapp-inbound"]
        WORK["Worker concurrencia 10 processWhatsAppInbound"]
        Q_DLQ["Cola BullMQ whatsapp-dlq tras 3 fallos"]
        PUB_OUT["publishSignedGatewayOutbound firma HMAC"]
        SSE_EP["GET /api/gateways/whatsapp/outbound/stream"]
    end

    subgraph REDIS_BUS["Redis 7"]
        R_SETNX["Llave wamid:messageId TTL 86400s"]
        R_PS["PubSub whatsapp:outbound"]
        R_PEND["Lista gw:wa:outbound:pending TTL 1800s"]
    end

    WA_IN --> LID
    LID --> SIGN_IN
    SIGN_IN -->|HTTP POST + X-Gateway-Signature| IN_EP
    IN_EP --> VER_IN
    VER_IN -->|Invalida HTTP 401| SIGN_IN
    VER_IN -->|Valida| IDEMP
    IDEMP <--> R_SETNX
    IDEMP -->|Primera vez encola y ACK 202 firmado| Q_IN
    Q_IN --> WORK
    WORK -->|Error tras 3 intentos| Q_DLQ
    WORK -->|source == baileys| PUB_OUT
    PUB_OUT -->|Publica SignedOutboundEnvelope| R_PS
    PUB_OUT -->|Si receivers == 0 respalda| R_PEND
    R_PS -->|Difunde frame outbound_message| SSE_EP
    R_PEND -->|Drena hasta 50 al reconectar| SSE_EP
    SSE_EP -->|SSE firmado HMAC| SSE_CLI
    SSE_CLI --> VER_OUT
    VER_OUT -->|Firma OK| WA_SEND

    SIM_UI -->|POST sin auth| SIM_EP
    SIM_EP -->|SETNX wamid| IDEMP
    SIM_EP -->|Ejecucion sincrona omite BullMQ| WORK
```

### Traza paso a paso (evidencia real)
1. **Recepción y mapeo LID en el Gateway (`whatsapp-gateway/src/index.ts`):** El listener `messages.upsert` descarta mensajes propios (`fromMe`), grupos (`@g.us`) y estados (`status@broadcast`), extrae texto con `extractTextMessage`, intenta mapear JIDs `@lid` usando `remoteJidAlt`/`participantAlt` o `lidToPhoneMap` (alimentado por `contacts.upsert`/`contacts.update`) y marca `isUnresolvedLid` si no hay teléfono visible.
2. **Firma E2E entrante:** `forwardInboundToOrchestrator` firma `${timestamp}.${rawBody}` con `signGatewayPayload` (`v1=<hmac_sha256_hex>`) y envía `POST /api/gateways/whatsapp/inbound` con headers `X-Gateway-Timestamp` y `X-Gateway-Signature`.
3. **Verificación, idempotencia y encolado (`backend/src/routes/whatsappGateway.ts`):** La ruta activa `config: { rawBody: true }`, valida firma y ventana anti-replay (`GATEWAY_SIGNATURE_TTL_SECONDS`, default `300s`) con `crypto.timingSafeEqual`, reclama el mensaje con `redis.set("wamid:" + id, "1", "EX", WAMID_TTL_SECONDS, "NX")` (si ya existe responde `200 duplicate_ignored`), agrega el job a `whatsappInboundQueue` y responde `202 Accepted` con ACK firmado (`X-Orchestrator-Signature` y `X-Orchestrator-Timestamp`).
4. **Procesamiento asíncrono y DLQ (`backend/src/queues/whatsappQueue.ts`):** `startWhatsAppWorker` consume `whatsapp-inbound` con `concurrency: 10`, hasta `3` intentos con backoff exponencial (`1000ms`). Al agotarse los reintentos, el listener `failed` mueve el payload a `whatsappDlqQueue` (`whatsapp-dlq`).
5. **Entrega saliente firmada y buffer de reconexión:** `replyToPatient` guarda siempre la burbuja en Redis (`sim:wa:chat:<phone>`, máx. 50 mensajes, TTL 24h) y, cuando `source === "baileys"`, llama a `publishSignedGatewayOutbound`, que firma el sobre y publica en Redis Pub/Sub `whatsapp:outbound`. Si `receivers === 0`, lo resguarda en `gw:wa:outbound:pending` (hasta 100 elementos, TTL 1800s), drenado por `drainPendingGatewayOutbound` (hasta 50 mensajes por reconexión) cuando el gateway abre `GET /api/gateways/whatsapp/outbound/stream` firmando `GET:/api/gateways/whatsapp/outbound/stream`.
6. **Diferencia del Simulador QA:** `POST /api/channels/whatsapp/simulate` comparte `claimMessageId` (`SETNX`), pero invoca `processWhatsAppInbound` de forma síncrona (sin pasar por BullMQ) y devuelve `{ reply, history }` en la misma respuesta HTTP.

---

## Flujo 4 — Orquestación Interna de WhatsApp: Multibeneficiario, Step-Up OTP e IA / Fallback

Detalla la lógica interna de `processWhatsAppInbound` (`backend/src/queues/whatsappQueue.ts`) y `runSmartWhatsAppAssistant` (`backend/src/core/aiAssistant.ts`).

```mermaid
flowchart TD
    START["processWhatsAppInbound jobData"]
    CHAT_IN["Guarda burbuja inbound en Redis sim:wa:chat"]
    HOLD["Resuelve titular por PHONE o APP LID"]
    OPEN["Consulta casos abiertos en PostgreSQL"]
    CMD{"Comando MENU o mas de 1 caso sin elegir?"}
    MENU["Responde lista numerada y limpia o fija wa:active_case TTL 30m"]
    NO_CASE{"No hay caso activo?"}
    NEW_CASE["Crea ServiceCase INICIADO y SESSION_STARTED"]
    OTP_CHK{"needsStepUpOtp? otro canal pausado o tercero"}
    IS_6D{"Texto son 6 digitos?"}
    ISSUE["Emite CHANNEL_SWITCH_DETECTED e issueOtpChallenge Redis 300s"]
    OUTBOX["Escribe codigo en demo:otp:outbox GET /api/otp-2fa/inbox"]
    VERIFY["verifyOtpChallenge hash HMAC max 3 intentos"]
    OTP_FAIL["OTP_VALIDATION_FAILED y responde error"]
    OTP_OK["IDENTITY_VERIFIED_OTP y CONTEXT_REHYDRATED EN_PROGRESO"]
    AI_CHK{"OPENAI_API_KEY configurada?"}
    SCRUB["scrubPotentialPii oculta CURP y 6 digitos"]
    LLM["OpenAI Chat Completions hasta 2 rondas 12 tools"]
    TOOLS["Ejecuta tools sobre stateMachine e identityService"]
    FALLBACK["Motor deterministico regex catalog.ts y BOT_TEMPLATES"]
    REPLY["replyToPatient guarda outbound y publica a Gateway"]

    START --> CHAT_IN
    CHAT_IN --> HOLD
    HOLD --> OPEN
    OPEN --> CMD
    CMD -->|Si| MENU
    MENU --> REPLY
    CMD -->|No| NO_CASE
    NO_CASE -->|Si| NEW_CASE
    NEW_CASE --> AI_CHK
    NO_CASE -->|No| OTP_CHK
    OTP_CHK -->|Si| IS_6D
    IS_6D -->|No| ISSUE
    ISSUE --> OUTBOX
    ISSUE --> REPLY
    IS_6D -->|Si| VERIFY
    VERIFY -->|Invalido o expirado| OTP_FAIL
    OTP_FAIL --> REPLY
    VERIFY -->|Valido| OTP_OK
    OTP_OK --> REPLY
    OTP_CHK -->|No| AI_CHK
    AI_CHK -->|Si| SCRUB
    SCRUB --> LLM
    LLM <-->|Tool calls| TOOLS
    LLM -->|Texto valido| REPLY
    LLM -->|Error timeout o null| FALLBACK
    AI_CHK -->|No| FALLBACK
    FALLBACK --> REPLY
```

### Traza paso a paso (evidencia real)
1. **Resolución de titular y selección de caso:** Si `isUnresolvedLid` es verdadero, busca por `IdentifierType.APP` (`LID:<digits>`); de lo contrario usa `resolveOrCreatePatient({ phone, whatsappLid })`. Consulta hasta 10 casos no confirmados donde el titular sea `requesterPatientId` o `patientId`.
2. **Menú multibeneficiario:** Si el usuario escribe `MENU`/`CAMBIAR`/`MIS CITAS` o existen `> 1` casos abiertos sin clave activa en Redis `wa:active_case:<phone>`, envía un menú numerado con nombres enmascarados (`maskPatientName`) y guarda la selección con TTL de `1800s`.
3. **Compuerta Step-Up OTP (`needsStepUpOtp`):** Se activa si `"WHATSAPP"` no está en `contextJson.otp_verified_channels` y además el caso proviene de otro canal (`currentChannel !== WHATSAPP`), está en `PAUSADO_PENDIENTE`, o es de un tercero (`patientId !== holder.id`).
   - Sin código de 6 dígitos: emite `CHANNEL_SWITCH_DETECTED`, ejecuta `issueOtpChallenge` (guarda `hashOtp` en `otp:challenge:<patientId>` con TTL `OTP_TTL_SECONDS`, escribe el código en `demo:otp:outbox` y audita `OTP_CHALLENGE_SENT`).
   - Con código de 6 dígitos: `verifyOtpChallenge` compara hashes; si falla incrementa `attempts` (al llegar a `OTP_MAX_ATTEMPTS = 3` revoca la llave) y audita `OTP_VALIDATION_FAILED`; si acierta borra el reto, marca `identity_links.PHONE.verified = true`, audita `IDENTITY_VERIFIED_OTP` y transiciona el caso a `EN_PROGRESO` (`CONTEXT_REHYDRATED`) agregando `"WHATSAPP"` a `otp_verified_channels`.
4. **Plugin OpenAI Function Calling (`backend/src/core/aiAssistant.ts`):** Cuando `env.OPENAI_API_KEY` está presente:
   - Extrae cualquier CURP del texto crudo en servidor (`extractCurpFromRawText`) y limpia CURPs y códigos de 6 dígitos con `scrubPotentialPii` antes de enviar los mensajes a `https://api.openai.com/v1/chat/completions` (con `AbortSignal.timeout(env.OPENAI_TIMEOUT_MS)`).
   - Expone 12 herramientas (`get_patient_context`, `search_catalog`, `quote_study`, `select_clinic_and_slot`, `update_preferred_slot`, `update_patient_profile`, `link_existing_account`, `set_payment_method`, `pause_case_for_later`, `switch_or_create_case`, `log_question_or_escalate`, `confirm_appointment`) ejecutadas hasta en 2 rondas. Todas las mutaciones pasan por `transitionServiceCase`, `resolveOrCreateBeneficiary` o `mergePatientProfiles`.
   - `confirm_appointment` valida estrictamente que existan estudio, clínica, fecha/hora, forma de pago y nombre + apellido paterno antes de generar Folio y QR.
5. **Fallback determinístico (`whatsappQueue.ts`):** Si no hay `OPENAI_API_KEY` o `runSmartWhatsAppAssistant` retorna `null`, se aplican expresiones regulares sobre `STUDIES_CATALOG`, `CLINICS_CATALOG` y `BOT_TEMPLATES` (`backend/src/data/botTemplates.ts`), permitiendo cotizar, elegir clínica, escalar a asesor (`DUDAS_ABIERTAS`), confirmar (`CONFIRMAR`/`AGENDAR`) o registrar dudas abiertas (`PATIENT_QUESTION_LOGGED`).

---

## Flujo 5 — Vinculación Manual de Teléfono o Folio Secundario con OTP (`Mi Cuenta`)

Permite a un paciente autenticado en el portal web vincular trámites históricos creados desde otro número telefónico o folio de WhatsApp/Call Center tras superar un reto OTP.

```mermaid
flowchart LR
    UI["PatientAccountPage Formulario vincular"]
    REQ["POST /api/patients/me/link-channel/request"]
    FIND["requestChannelLinkChallenge busca por phone o folio"]
    R_KEY["Redis otp:channel_link:patientId TTL 300s"]
    R_BOX["Redis hash demo:otp:outbox"]
    CON2FA["Otp2faPage polling 2s GET /api/otp-2fa/inbox"]
    VER["POST /api/patients/me/link-channel/verify"]
    CHK["verifyChannelLinkChallenge max 3 intentos"]
    MERGE["mergePatientProfiles y updateMany service_cases"]
    LINK["upsertIdentityLink PHONE verified true"]
    PG["PostgreSQL expedientes consolidados"]

    UI -->|JWT + phone o folio| REQ
    REQ --> FIND
    FIND -->|Si encuentra casos| R_KEY
    FIND --> R_BOX
    R_BOX --> CON2FA
    CON2FA -->|Usuario copia OTP 6 digitos| UI
    UI -->|JWT + otpCode| VER
    VER --> CHK
    CHK <--> R_KEY
    CHK -->|OTP valido| MERGE
    MERGE --> LINK
    LINK --> PG
    MERGE --> PG
```

### Traza paso a paso (evidencia real)
1. **Solicitud (`POST /api/patients/me/link-channel/request`):** Protegida por `requirePatientAuth` (`backend/src/routes/patientAuth.ts`). `requestChannelLinkChallenge` (`backend/src/core/identityService.ts`) busca pacientes compatibles por teléfono normalizado o inspecciona hasta los últimos 100 `service_cases` comparando `contextJson.appointment_folio`.
2. **Emisión OTP en Redis:** Guarda `ChannelLinkOtpRecord` (`otpHash`, `targetPatientIds`, `targetCaseIds`, `attempts: 0`) en `otp:channel_link:<patientId>` con TTL `OTP_TTL_SECONDS` y publica el código en `demo:otp:outbox` (visible en `Otp2faPage.tsx` mediante polling cada 2 segundos a `GET /api/otp-2fa/inbox`).
3. **Verificación y consolidación (`POST /api/patients/me/link-channel/verify`):** `verifyChannelLinkChallenge` valida el hash HMAC del OTP (máximo 3 intentos). Si es válido, elimina el reto, ejecuta `mergePatientProfiles` para los `targetPatientIds`, actualiza `requesterPatientId` en los `targetCaseIds` que pertenezcan a otro paciente y registra el `IdentityLink` de tipo `PHONE` con `verified: true`.

---

## Flujo 6 — Atención en Call Center (Screen-Pop SSE), Confirmación y Observabilidad Admin

Muestra cómo los eventos generados en cualquier canal se difunden en tiempo real vía Redis Pub/Sub hacia las sesiones SSE de Call Center, Admin y Portal de Pacientes, y cómo opera la estación del asesor.

```mermaid
flowchart TD
    MUT["Mutacion en Web WhatsApp o Call Center"]
    EB["recordAndPublishEvent backend/src/core/eventBus.ts"]
    PG_EV["PostgreSQL INSERT journey_events"]
    R_PUB["Redis PUBLISH journey:events"]
    SUB["redisSubscriber en admin.ts y patientAuth.ts"]

    SSE_STAFF["GET /api/stream/events sseClients Staff JWT"]
    SSE_PAT["GET /api/patients/me/stream patientSseClients filtrado por patientId"]

    CC_UI["CallCenterPage Screen-Pop SSE"]
    CC_Q["GET /api/call-center/queue"]
    CC_EDIT["Edicion Paso 1 y 2 usa POST /api/channels/web/*"]
    CC_ASN["POST /api/call-center/cases/:caseId/assign"]
    CC_CNF["POST /api/call-center/cases/:caseId/confirm"]

    ADM_UI["AdminDashboard 3 pestanas"]
    ADM_OV["GET /api/admin/overview PII enmascarada + BullMQ"]
    ADM_LK["GET /api/admin/users/lookup HMAC y texto"]
    ADM_TL["GET /api/admin/cases/:caseId/timeline"]

    PAT_UI["PatientAccountPage OrderJourneyTracker"]
    WA_OUT["publishSignedGatewayOutbound aviso a WhatsApp"]

    MUT --> EB
    EB --> PG_EV
    EB --> R_PUB
    R_PUB --> SUB
    SUB -->|Broadcast total PII enmascarada| SSE_STAFF
    SUB -->|Filtro patientId o requesterPatientId| SSE_PAT

    SSE_STAFF -->|Evento journey_event| CC_UI
    SSE_STAFF -->|Evento journey_event debounce 350ms| ADM_UI
    SSE_PAT -->|Evento journey_event recarga /me| PAT_UI

    CC_UI --> CC_Q
    CC_UI -->|Guarda cambios de formulario| CC_EDIT
    CC_UI -->|Asigna asesor EN_ATENCION_ASESOR| CC_ASN
    CC_UI -->|Confirma 1 clic CITA_CONFIRMADA| CC_CNF
    CC_CNF --> WA_OUT

    ADM_UI --> ADM_OV
    ADM_UI --> ADM_LK
    ADM_UI --> ADM_TL
```

### Traza paso a paso (evidencia real)
1. **Publicación centralizada (`backend/src/core/eventBus.ts`):** Cada evento de negocio llama a `recordAndPublishEvent`, que inserta un registro inmutable en `journey_events` (con `correlationId` UUID) y publica en Redis `journey:events` un JSON con `patientMasked` (nunca el nombre completo), `patientId`, `requesterPatientId`, `channel`, `eventType`, `prevState` y `nextState`.
2. **Puente Redis Pub/Sub -> SSE:**
   - `adminRoutes` (`backend/src/routes/admin.ts`) suscribe `redisSubscriber` a `journey:events` y envía `event: journey_event` a todos los sockets en `sseClients` conectados a `GET /api/stream/events` (accesible a `ASESOR` y `ADMIN`).
   - `patientAuthRoutes` (`backend/src/routes/patientAuth.ts`) escucha el mismo canal y filtra estrictamente los envíos a `patientSseClients` (`GET /api/patients/me/stream`) comparando `parsed.patientId === subscribedPatientId || parsed.requesterPatientId === subscribedPatientId`.
   - Todos los streams SSE escriben un comentario `: heartbeat <timestamp>` cada `15000ms` para mantener viva la conexión.
3. **Flujo operativo en Call Center (`frontend/src/pages/CallCenterPage.tsx` y `backend/src/routes/callCenter.ts`):**
   - Al llegar un evento SSE, muestra un banner `Screen-Pop en vivo`, selecciona automáticamente el `caseId` del evento y recarga `GET /api/call-center/queue` (últimos 30 casos con datos completos del paciente y hasta 25 eventos).
   - **Nota real del código:** Cuando el asesor edita el Paso 1, Paso 2 o pausa un borrador en `CallCenterPage.tsx`, invoca los endpoints del canal Web (`registerWebPatient`, `quoteWebStudy`, `abandonWebCase`) antes de llamar a `POST /api/call-center/cases/:caseId/assign` (`EN_ATENCION_ASESOR`, `ADVISOR_ASSIGNED`).
   - Al confirmar en `POST /api/call-center/cases/:caseId/confirm`, transiciona a `CITA_CONFIRMADA` (generando Folio y QR), registra `advisorNotes` en el evento y dispara `publishSignedGatewayOutbound` hacia el Gateway Baileys.
4. **Flujo de observabilidad en Admin (`frontend/src/pages/AdminDashboard.tsx` y `backend/src/routes/admin.ts`):**
   - Al recibir eventos por SSE, aplica un debounce de `350ms` y consulta `GET /api/admin/overview` (KPIs globales, conteos reales de `whatsappInboundQueue` y `whatsappDlqQueue`, y hasta 50 casos con `patientMasked` y `identities` enmascaradas) y `GET /api/health`.
   - En la pestaña de consulta de usuario, `GET /api/admin/users/lookup?q=` busca por UUID (`journeyId`/`caseId`/`patientId`), por hash HMAC en `identity_links` (`EMAIL`/`CURP`/`PHONE`) y por coincidencia parcial `contains` en `patients`, devolviendo expedientes con PII enmascarada.
   - Adicionalmente existe `POST /api/admin/reset-demo` (solo `ADMIN`) para vaciar `journey_events`, `service_cases` y llaves temporales seleccionadas en Redis preservando `users_staff` y el paciente semilla `Ana`.

---

## Flujo 7 — Llamada de Voz WebRTC en Tiempo Real (Portal <-> Call Center), Grabación Dual-Track y Resumen IA (STT)

Documenta la nueva integración de voz en tiempo real entre el paciente (`PatientVoiceCallBar.tsx` en `/laboratorio` y `/mi-cuenta`) y el asesor (`AdvisorVoicePanel.tsx` en `/call-center`), su señalización sobre Redis Pub/Sub + SSE (`voiceCalls.ts`), la grabación dual-track y el pipeline de transcripción + resumen estructurado (`callSummaryService.ts` + `callCenter.ts`).

```mermaid
flowchart TD
    PAT_BAR["PatientVoiceCallBar en LaboratorioPage y PatientAccountPage"]
    POST_CALL["POST /api/voice/calls offerSdp y caseId"]
    REDIS_SIG["Redis webrtc:call:callId TTL 3600s y PubSub webrtc:signaling"]
    ADV_SSE["GET /api/voice/stream/advisor SSE JWT Staff"]
    ADV_PNL["AdvisorVoicePanel Screen-Pop incoming_call"]
    POST_ANS["POST /api/voice/calls/:callId/answer answerSdp"]
    PAT_SSE["GET /api/voice/stream/patient/:callId SSE"]
    ICE_EP["POST /api/voice/calls/:callId/ice intercambio ICE"]
    P2P["Audio P2P WebRTC RTCPeerConnection via STUN"]
    REC["DualTrackAudioRecorder Web Audio API + MediaRecorder"]
    POST_END["POST /api/voice/calls/:callId/end"]
    PROC_EP["POST /api/call-center/cases/:caseId/calls/process audioBase64 o texto"]
    STT["callSummaryService OpenAI STT fallback whisper-1 y scrubCallTranscriptPii"]
    SUM["OpenAI Chat JSON o buildDeterministicFallback"]
    APPLY_EP["POST /api/call-center/cases/:caseId/calls/:summaryId/apply opcional"]
    PG_CTX["PostgreSQL service_cases context_json.call_summaries y latest_call_summary"]
    SYNC["Omnicanal: OrderJourneyTracker patientSafeSummary, handoff_summary y Bot WhatsApp aiAssistant"]

    PAT_BAR -->|offerSdp + JWT opcional| POST_CALL
    POST_CALL -->|Guarda sesion y publica incoming_call| REDIS_SIG
    REDIS_SIG -->|Notifica asesores| ADV_SSE
    ADV_SSE --> ADV_PNL
    ADV_PNL -->|Contesta con answerSdp| POST_ANS
    POST_ANS -->|Asigna caso EN_ATENCION_ASESOR y publica call_answered| REDIS_SIG
    REDIS_SIG --> PAT_SSE
    PAT_SSE --> PAT_BAR
    PAT_BAR <-->|Candidatos ICE| ICE_EP
    ADV_PNL <-->|Candidatos ICE| ICE_EP
    ICE_EP <--> REDIS_SIG
    PAT_BAR <-->|Flujo audio directo| P2P
    P2P <-->|Flujo audio directo| ADV_PNL
    ADV_PNL -->|Mezcla mic local + pista remota| REC
    ADV_PNL -->|Al colgar| POST_END
    REC -->|Blob audioBase64 webm| PROC_EP
    PROC_EP --> STT
    STT --> SUM
    SUM -->|Valida entidades contra catalog.ts| PG_CTX
    ADV_PNL -->|Aplicar entidades detectadas| APPLY_EP
    APPLY_EP --> PG_CTX
    PG_CTX -->|CONTEXT_REHYDRATED + Redis journey:events| SYNC
```

### Traza paso a paso (evidencia real)
1. **Inicio de llamada (`PatientVoiceCallBar.tsx` -> `POST /api/voice/calls`):** El navegador captura micrófono, crea `RTCPeerConnection` con `getIceServers()` (`VITE_WEBRTC_ICE_SERVERS` o STUN público de Google) y envía `offerSdp` junto con `caseId`/`webSessionId`/`phone` (y JWT paciente opcional). `backend/src/routes/voiceCalls.ts` resuelve o crea el `ServiceCase` (en `DUDAS_ABIERTAS` si no existía), guarda `VoiceCallSession` en Redis `webrtc:call:<callId>` (TTL `3600s`) y en el set `webrtc:calls:ringing`, y publica `incoming_call` en Redis Pub/Sub `webrtc:signaling`.
2. **Señalización y respuesta (`AdvisorVoicePanel.tsx` -> `POST /api/voice/calls/:callId/answer`):** El asesor conectado a `GET /api/voice/stream/advisor` (protegido con `requireStaffRole([ASESOR, ADMIN])`) recibe `incoming_call` (o llamadas en espera al reconectar). Al contestar, inicia `DualTrackAudioRecorder` (`frontend/src/lib/webrtcCall.ts`), genera `answerSdp` y lo envía a `/answer`, el cual actualiza el estado a `active`, asigna automáticamente el expediente (`EN_ATENCION_ASESOR` / `ADVISOR_ASSIGNED` con `via: "webrtc_voice_call"`) y publica `call_answered` hacia `GET /api/voice/stream/patient/:callId`.
3. **Intercambio ICE y audio P2P:** Ambos extremos intercambian candidatos ICE vía `POST /api/voice/calls/:callId/ice` -> Redis `webrtc:signaling` y establecen el canal de audio P2P directo. `DualTrackAudioRecorder` mezcla la pista local del asesor y la pista remota del paciente mediante `AudioContext` + `MediaStreamAudioDestinationNode` + `MediaRecorder`.
4. **Cierre, transcripción STT y resumen estructurado (`POST /api/call-center/cases/:caseId/calls/process`):** Al finalizar (`POST /api/voice/calls/:callId/end` o al usar el respaldo manual `audio_upload` / `transcript_text` en `AdvisorVoicePanel.tsx`), el audio en Base64 (hasta `bodyLimit: 18 MB` en `backend/src/index.ts`) se procesa en `processCallAudioAndSummarize` (`backend/src/core/callSummaryService.ts`):
   - Transcribe con `POST https://api.openai.com/v1/audio/transcriptions` (`OPENAI_STT_MODEL`, default `gpt-4o-mini-transcribe`, con reintento automático en `whisper-1`).
   - Sanitiza PII con `scrubCallTranscriptPii` (enmascara CURP, tarjetas de 13–16 dígitos y códigos OTP de 6 dígitos).
   - Genera JSON estructurado vía OpenAI Chat Completions (o `buildDeterministicFallback` si falta `OPENAI_API_KEY` o ocurre error/timeout `OPENAI_CALL_TIMEOUT_MS`) con `summary`, `patientSafeSummary`, `agreements`, `pendingActions`, `openQuestions`, `sentiment` y `extractedEntities` validadas contra `STUDIES_CATALOG` y `CLINICS_CATALOG`.
5. **Integración omnicanal y aplicación de entidades:** `callCenter.ts` guarda hasta 15 `call_summaries` y `latest_call_summary` en `service_cases.context_json`, re-lee la versión más reciente tras la llamada a OpenAI y ejecuta `transitionServiceCase` (`CONTEXT_REHYDRATED`, `via: "call_ai_summary"`). Si el asesor pulsa **"Aplicar datos al trámite"**, `POST /api/call-center/cases/:caseId/calls/:summaryId/apply` aplica estudio/clínica/horario/pago al caso. El resumen se propaga automáticamente a:
   - `OrderJourneyTracker.tsx` en `/mi-cuenta` (muestra `patientSafeSummary`).
   - `buildDeterministicHandoffSummary` en `stateMachine.ts`.
   - El prompt del bot WhatsApp y el tool `get_patient_context` en `backend/src/core/aiAssistant.ts`.
