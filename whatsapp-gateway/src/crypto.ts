import crypto from "crypto";

/**
 * Firma digital HMAC-SHA256 extremo a extremo sobre "<timestamp>.<payload>".
 */
export function signGatewayPayload(timestamp: string, payload: string, secret: string): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `v1=${mac}`;
}

/**
 * Verifica la firma digital HMAC-SHA256 enviada por el Cerebro Orquestador (AWS)
 * usando comparacion en tiempo constante y ventana anti-replay de 300 segundos.
 */
export function verifyOrchestratorSignature(params: {
  payload: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  maxSkewSeconds?: number;
}): { ok: boolean; reason?: string } {
  const { payload, signature, timestamp, secret, maxSkewSeconds = 300 } = params;

  if (!signature || !timestamp) {
    return { ok: false, reason: "Faltan firma o timestamp del Orquestador." };
  }
  if (!signature.startsWith("v1=")) {
    return { ok: false, reason: "Prefijo de firma inválido." };
  }
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "Timestamp inválido." };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > maxSkewSeconds) {
    return { ok: false, reason: "Mensaje saliente expirado (anti-replay)." };
  }

  const expected = signGatewayPayload(timestamp, payload, secret);
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: "Firma digital HMAC-SHA256 inválida." };
  }

  return crypto.timingSafeEqual(sigBuf, expBuf)
    ? { ok: true }
    : { ok: false, reason: "Firma digital HMAC-SHA256 inválida." };
}
