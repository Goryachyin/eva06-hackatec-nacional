import "dotenv/config";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { signGatewayPayload, verifyOrchestratorSignature } from "./crypto";

const ORCHESTRATOR_API_URL = (
  process.env.ORCHESTRATOR_API_URL || "http://localhost:3000"
).replace(/\/+$/, "");

const WHATSAPP_GATEWAY_SECRET =
  process.env.WHATSAPP_GATEWAY_SECRET || "sd_e2e_gateway_hmac_secret_2026_local";

const WA_AUTH_DIR = process.env.WA_AUTH_DIR || "./auth_info";

interface SignedOutboundEnvelope {
  id: string;
  toPhone: string;
  remoteJid?: string;
  text: string;
  correlationId: string;
  timestamp: string;
  signature: string;
}

let activeSock: WASocket | null = null;
const lastKnownJidByPhone = new Map<string, string>();
const lidToPhoneMap = new Map<string, string>();

function registerLidPhoneMapping(lid?: string | null, phoneJid?: string | null) {
  if (!lid || !phoneJid) return;
  if (!lid.endsWith("@lid") || !phoneJid.endsWith("@s.whatsapp.net")) return;
  const phoneDigits = normalizeDigits(phoneJid.split("@")[0]);
  if (phoneDigits.length >= 10 && phoneDigits.length <= 13) {
    lidToPhoneMap.set(lid, `+${phoneDigits}`);
    lastKnownJidByPhone.set(phoneDigits, lid);
  }
}

function normalizeDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  if (digits.startsWith("521") && digits.length === 13) return `52${digits.slice(3)}`;
  return digits;
}

function extractTextMessage(msg: {
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    buttonsResponseMessage?: { selectedDisplayText?: string | null } | null;
    listResponseMessage?: { title?: string | null } | null;
  } | null;
}): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

/**
 * Envia un mensaje entrante desde WhatsApp hacia el Cerebro Orquestador
 * firmado extremo a extremo con HMAC-SHA256 + timestamp anti-replay.
 */
async function forwardInboundToOrchestrator(params: {
  messageId: string;
  fromPhone: string;
  remoteJid: string;
  whatsappLid?: string;
  isUnresolvedLid?: boolean;
  text: string;
}) {
  const bodyObj = {
    messageId: params.messageId,
    fromPhone: params.fromPhone,
    remoteJid: params.remoteJid,
    ...(params.whatsappLid ? { whatsappLid: params.whatsappLid } : {}),
    ...(params.isUnresolvedLid ? { isUnresolvedLid: true } : {}),
    text: params.text,
    receivedAt: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(bodyObj);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signGatewayPayload(timestamp, rawBody, WHATSAPP_GATEWAY_SECRET);

  const res = await fetch(`${ORCHESTRATOR_API_URL}/api/gateways/whatsapp/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Timestamp": timestamp,
      "X-Gateway-Signature": signature,
    },
    body: rawBody,
  });

  const respText = await res.text();
  if (!res.ok) {
    console.error(`[Gateway -> Orquestador] Error HTTP ${res.status}: ${respText}`);
    return;
  }

  // Verificar tambien la firma digital del ACK devuelto por el Orquestador
  const ackSig = res.headers.get("x-orchestrator-signature") || undefined;
  const ackTs = res.headers.get("x-orchestrator-timestamp") || undefined;
  if (ackSig && ackTs) {
    const check = verifyOrchestratorSignature({
      payload: respText,
      signature: ackSig,
      timestamp: ackTs,
      secret: WHATSAPP_GATEWAY_SECRET,
    });
    if (!check.ok) {
      console.warn(`[Gateway] Advertencia verificando firma ACK del Orquestador: ${check.reason}`);
    }
  }

  console.log(
    `[Gateway -> Orquestador] Mensaje ${params.messageId} enviado con firma E2E (HTTP ${res.status})`
  );
}

/**
 * Entrega por Baileys un mensaje saliente recibido del Orquestador
 * SOLO despues de verificar su firma criptografica HMAC-SHA256.
 */
async function handleSignedOutbound(envelope: SignedOutboundEnvelope) {
  const corePayload = JSON.stringify({
    id: envelope.id,
    toPhone: envelope.toPhone,
    remoteJid: envelope.remoteJid,
    text: envelope.text,
    correlationId: envelope.correlationId,
  });

  const check = verifyOrchestratorSignature({
    payload: corePayload,
    signature: envelope.signature,
    timestamp: envelope.timestamp,
    secret: WHATSAPP_GATEWAY_SECRET,
  });

  if (!check.ok) {
    console.error(`[Orquestador -> Gateway] Firma digital RECHAZADA: ${check.reason}`);
    return;
  }

  if (!activeSock) {
    console.warn("[Gateway] Socket Baileys aún no está listo; omitiendo entrega.");
    return;
  }

  const normalized = normalizeDigits(envelope.toPhone);
  const targetJid =
    envelope.remoteJid ||
    lastKnownJidByPhone.get(normalized) ||
    `${normalized}@s.whatsapp.net`;

  try {
    await activeSock.sendMessage(targetJid, { text: envelope.text });
    console.log(
      `[Orquestador -> WhatsApp] Respuesta firmada entregada a ${targetJid} (cid=${envelope.correlationId.slice(0, 8)})`
    );
  } catch (err) {
    console.error(`[Gateway] Error enviando mensaje via Baileys a ${targetJid}:`, err);
  }
}

/**
 * Suscripcion SSE persistente (con reconexion automatica) al canal saliente firmado del Orquestador.
 */
async function startOutboundSseLoop() {
  const streamPath = "/api/gateways/whatsapp/outbound/stream";

  while (true) {
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signGatewayPayload(
        timestamp,
        `GET:${streamPath}`,
        WHATSAPP_GATEWAY_SECRET
      );

      console.log(`[Gateway SSE] Conectando al stream firmado en ${ORCHESTRATOR_API_URL}${streamPath}...`);
      const res = await fetch(`${ORCHESTRATOR_API_URL}${streamPath}`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "X-Gateway-Timestamp": timestamp,
          "X-Gateway-Signature": signature,
        },
      });

      if (!res.ok || !res.body) {
        const errTxt = await res.text().catch(() => "");
        console.error(`[Gateway SSE] Conexión rechazada (HTTP ${res.status}): ${errTxt}`);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      console.log("[Gateway SSE] ✅ Conectado al canal saliente firmado E2E.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (currentEvent === "outbound_message" && dataStr) {
              try {
                const envMsg = JSON.parse(dataStr) as SignedOutboundEnvelope;
                await handleSignedOutbound(envMsg);
              } catch (err) {
                console.error("[Gateway SSE] Error parseando mensaje saliente:", err);
              }
            }
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }
    } catch (err) {
      console.error("[Gateway SSE] Desconectado, reintentando en 4s...", (err as Error).message);
    }

    await new Promise((r) => setTimeout(r, 4000));
  }
}

/**
 * Conexion local al numero propio de WhatsApp mediante Baileys (WebSocket nativo sin Chromium).
 */
async function startBaileysClient() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Salud Digna Gateway E2E", "Chrome", "120.0"],
  });

  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  // Alimentar tabla LID <-> telefono real a partir de eventos de contactos de Baileys
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts as Array<{ id?: string; lid?: string; phoneNumber?: string }>) {
      if (c.lid && c.id) registerLidPhoneMapping(c.lid, c.id);
      if (c.id?.endsWith("@lid") && c.phoneNumber) {
        registerLidPhoneMapping(c.id, `${normalizeDigits(c.phoneNumber)}@s.whatsapp.net`);
      }
    }
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const c of updates as Array<{ id?: string; lid?: string; phoneNumber?: string }>) {
      if (c.lid && c.id) registerLidPhoneMapping(c.lid, c.id);
      if (c.id?.endsWith("@lid") && c.phoneNumber) {
        registerLidPhoneMapping(c.id, `${normalizeDigits(c.phoneNumber)}@s.whatsapp.net`);
      }
    }
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n==================================================================");
      console.log("📱 ESCANEA ESTE CÓDIGO QR EN TU WHATSAPP (Dispositivos vinculados):");
      console.log("==================================================================\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("\n✅ [Baileys] Conectado exitosamente a tu número propio de WhatsApp.");
      console.log(`🔐 [E2E] Firma digital HMAC-SHA256 activa hacia: ${ORCHESTRATOR_API_URL}\n`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.warn(
        `[Baileys] Conexión cerrada (code=${statusCode}). Reintentando: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        setTimeout(() => {
          startBaileysClient().catch((e) => console.error("[Baileys] Error reconectando:", e));
        }, 3000);
      } else {
        console.error(
          "[Baileys] Sesión cerrada desde el teléfono. Borra la carpeta auth_info y vuelve a escanear el QR."
        );
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid || "";
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
        continue;
      }

      const text = extractTextMessage(msg)?.trim();
      if (!text) continue;

      // Resolucion inteligente de LID (@lid) de WhatsApp moderno hacia el telefono real
      const keyAny = msg.key as unknown as {
        remoteJid?: string;
        remoteJidAlt?: string;
        participantAlt?: string;
      };
      const isLidJid = remoteJid.endsWith("@lid");
      const altJid = keyAny.remoteJidAlt || keyAny.participantAlt;
      if (isLidJid && altJid) {
        registerLidPhoneMapping(remoteJid, altJid);
      }

      const mappedPhone = isLidJid ? lidToPhoneMap.get(remoteJid) : undefined;
      const phoneSourceJid = isLidJid && altJid ? altJid : remoteJid;
      const phoneDigits = phoneSourceJid.split("@")[0].replace(/\D/g, "");
      if (!phoneDigits && !mappedPhone) continue;

      const isUnresolvedLid = isLidJid && !altJid && !mappedPhone;
      const fromPhone = mappedPhone || `+${normalizeDigits(phoneDigits)}`;
      const whatsappLid = isLidJid ? remoteJid : undefined;

      if (!isUnresolvedLid) {
        lastKnownJidByPhone.set(normalizeDigits(fromPhone), remoteJid);
      }

      console.log(
        `[WhatsApp -> Gateway] Mensaje de ${fromPhone} (jid=${remoteJid}${
          isUnresolvedLid ? ", LID sin resolver" : ""
        }): "${text}"`
      );
      await forwardInboundToOrchestrator({
        messageId: msg.key.id || `baileys_${Date.now()}`,
        fromPhone,
        remoteJid,
        whatsappLid,
        isUnresolvedLid,
        text,
      });
    }
  });
}

async function main() {
  console.log("==================================================================");
  console.log("  SALUD DIGNA OMNICANAL — GATEWAY WHATSAPP LOCAL (BAILEYS + HMAC)");
  console.log("==================================================================");
  console.log(`  Orquestador destino: ${ORCHESTRATOR_API_URL}`);
  console.log("  Cero dependencias de Meta Cloud API · Firma E2E HMAC-SHA256 activa\n");

  void startOutboundSseLoop();
  await startBaileysClient();
}

main().catch((err) => {
  console.error("Error fatal en Gateway WhatsApp:", err);
  process.exit(1);
});
