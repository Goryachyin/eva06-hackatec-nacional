import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCheck,
  ExternalLink,
  KeyRound,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { api, getLastPatientPhone, setLastPatientPhone } from "../lib/api";
import { formatTimeShort } from "../lib/constants";
import { WhatsAppChatMessage } from "../types/api";

const QUICK_MESSAGES = [
  "Hola, quiero continuar con mi estudio",
  "¿Necesito ir en ayuno?",
  "Quiero hablar con un asesor de Call Center",
];

export const WhatsAppSimPage: React.FC = () => {
  const [phone, setPhone] = useState<string>(() => getLastPatientPhone());
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<WhatsAppChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWamid, setLastWamid] = useState<string | null>(null);
  const [lastNotice, setLastNotice] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(async (targetPhone: string) => {
    if (!targetPhone.trim()) return;
    setLoadingHistory(true);
    setError(null);
    try {
      const res = await api.getWhatsAppHistory(targetPhone.trim());
      setMessages(res.history || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadHistory(phone);
  }, [phone, loadHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (textToSend: string, forcedWamid?: string) => {
    const cleanText = textToSend.trim();
    if (!cleanText || !phone.trim()) return;

    setSending(true);
    setError(null);
    setLastNotice(null);
    setLastPatientPhone(phone.trim());

    try {
      const res = await api.simulateWhatsApp({
        fromPhone: phone.trim(),
        text: cleanText,
        ...(forcedWamid ? { wamid: forcedWamid } : {}),
      });

      if (res.duplicate) {
        setLastNotice(
          `Idempotencia activa (Redis SETNX): wamid ${res.wamid} fue descartado sin duplicar estado.`
        );
      } else {
        setLastWamid(res.wamid);
        if (res.history) {
          setMessages(res.history);
        } else {
          await loadHistory(phone.trim());
        }
        setInputText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al enviar el mensaje.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Panel izquierdo: Controles y guía del Dual Adapter */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-[#00843D] flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4" />
                Canal 2 · Dual Adapter
              </div>
              <h1 className="text-xl font-extrabold text-slate-900 mt-1">
                Simulador WhatsApp
              </h1>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Ejecuta el mismo Orquestador determinístico multibeneficiario e idempotencia{" "}
                <code className="bg-slate-100 px-1 rounded">SETNX</code> que el Gateway local
                Baileys con firma HMAC-SHA256.
              </p>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Teléfono del paciente (E.164)
              </label>
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 focus:border-[#00843D]"
                />
                <button
                  type="button"
                  onClick={() => loadHistory(phone)}
                  className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                  title="Recargar historial"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingHistory ? "animate-spin" : ""}`} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPhone("+526670000001")}
                className="mt-1.5 text-[11px] font-semibold text-[#0066B3] hover:underline"
              >
                Usar paciente semilla Ana Sofía (+526670000001)
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-[#EBF4FC] border border-blue-200/70 space-y-2">
              <div className="text-xs font-bold text-[#005291] flex items-center gap-1.5">
                <KeyRound className="w-4 h-4" />
                Verificación Step-Up OTP (Out-of-Band)
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Por seguridad, el código de 6 dígitos <strong>nunca</strong> se muestra dentro de
                este chat. Cuando el bot lo solicite, consúltalo en la Consola 2FA externa.
              </p>
              <Link
                to="/lab/otp-2fa"
                target="_blank"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-[#0066B3] hover:underline"
              >
                Abrir Consola 2FA en otra pestaña
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>

            {lastWamid && (
              <div className="pt-3 border-t border-slate-100 space-y-2">
                <div className="text-[11px] text-slate-500 font-mono truncate">
                  Último wamid: {lastWamid}
                </div>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => sendMessage("Mensaje repetido", lastWamid)}
                  className="w-full py-2 px-3 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 transition flex items-center justify-center gap-1.5"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-[#00843D]" />
                  Probar reenvío duplicado (Idempotencia)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Panel derecho: Interfaz de Chat estilo WhatsApp */}
        <div className="lg:col-span-8">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[620px]">
            {/* Cabecera verde WhatsApp / Salud Digna */}
            <div className="bg-[#075E54] text-white px-5 py-3.5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#00843D] border-2 border-emerald-300/60 flex items-center justify-center font-extrabold text-sm">
                  SD
                </div>
                <div>
                  <div className="font-bold text-sm flex items-center gap-1.5">
                    Salud Digna Atención Omnicanal
                    <ShieldCheck className="w-4 h-4 text-emerald-300" />
                  </div>
                  <div className="text-[11px] text-emerald-100 flex items-center gap-1">
                    <Smartphone className="w-3 h-3" />
                    Cuenta oficial verificada · {phone}
                  </div>
                </div>
              </div>
              <span className="text-[11px] px-2.5 py-1 rounded-full bg-white/15 font-semibold">
                Orquestador Determinístico
              </span>
            </div>

            {/* Banner de notificaciones / errores */}
            {lastNotice && (
              <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs font-semibold text-amber-800">
                {lastNotice}
              </div>
            )}
            {error && (
              <div className="bg-rose-50 border-b border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700">
                {error}
              </div>
            )}

            {/* Zona de mensajes */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 bg-[#EFEAE2]">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-6">
                  <div className="bg-white/90 rounded-2xl p-5 max-w-md shadow-sm border border-slate-200/70 space-y-2">
                    <div className="font-bold text-sm text-slate-800">
                      Inicia la conversación desde WhatsApp
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Si acabas de abandonar un trámite en <strong>Laboratorio y Citas</strong>,
                      escribe <em>"Hola, quiero continuar con mi estudio"</em> para activar la
                      verificación Step-Up OTP y rehidratar tu contexto.
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((m, idx) => {
                  const isInbound = m.direction === "inbound";
                  return (
                    <div
                      key={m.id || `${m.timestamp}-${idx}`}
                      className={`flex ${isInbound ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[82%] rounded-2xl px-4 py-2.5 shadow-sm text-sm whitespace-pre-wrap leading-relaxed ${
                          isInbound
                            ? "bg-[#D9FDD3] text-slate-900 rounded-tr-sm"
                            : "bg-white text-slate-800 rounded-tl-sm"
                        }`}
                      >
                        <div>{m.text}</div>
                        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500">
                          <span>{formatTimeShort(m.timestamp)}</span>
                          {isInbound && <CheckCheck className="w-3.5 h-3.5 text-sky-500" />}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {/* Chips de respuesta rápida */}
            <div className="bg-slate-50 border-t border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
              {QUICK_MESSAGES.map((qm) => (
                <button
                  key={qm}
                  type="button"
                  disabled={sending}
                  onClick={() => sendMessage(qm)}
                  className="shrink-0 px-3 py-1 rounded-full bg-white border border-slate-200 hover:border-[#00843D] hover:text-[#00843D] text-xs font-medium text-slate-700 transition"
                >
                  {qm}
                </button>
              ))}
            </div>

            {/* Input de envío */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage(inputText);
              }}
              className="bg-white border-t border-slate-200 p-3 flex items-center gap-2"
            >
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Escribe un mensaje o pega el código OTP de 6 dígitos..."
                disabled={sending}
                className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 focus:border-[#00843D]"
              />
              <button
                type="submit"
                disabled={sending || !inputText.trim()}
                className="bg-[#00843D] hover:bg-[#006E32] text-white px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                Enviar
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
