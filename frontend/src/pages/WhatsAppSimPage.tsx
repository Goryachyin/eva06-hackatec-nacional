import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
    bottomRef.current?.scrollIntoView();
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
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 bg-[#FFFFFF] text-[#1F2933]">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Panel izquierdo: controles planos */}
        <aside className="lg:col-span-4 space-y-6">
          <header className="pb-5 border-b border-[#E4E7EB] space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Canal 2 · Dual Adapter
            </p>
            <h1 className="text-2xl font-bold text-[#1F2933]">Simulador WhatsApp</h1>
            <p className="text-xs text-[#52606D] leading-relaxed">
              Ejecuta el mismo Orquestador determinístico multibeneficiario e idempotencia{" "}
              <code className="font-mono text-[#1F2933]">SETNX</code> que el Gateway local Baileys
              con firma HMAC-SHA256.
            </p>
          </header>

          <div className="space-y-2 pb-5 border-b border-[#E4E7EB]">
            <label
              htmlFor="wa-phone"
              className="block text-xs font-semibold text-[#1F2933]"
            >
              Teléfono del paciente (E.164)
            </label>
            <div className="flex gap-2">
              <input
                id="wa-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="flex-1 h-10 border border-[#E4E7EB] px-3 text-sm font-mono text-[#1F2933] focus:border-[#00875A]"
              />
              <button
                type="button"
                onClick={() => loadHistory(phone)}
                className="h-10 px-3 border border-[#E4E7EB] text-xs font-semibold text-[#1F2933] hover:border-[#1F2933]"
              >
                {loadingHistory ? "..." : "Recargar"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPhone("+526670000001")}
              className="text-xs font-semibold text-[#00875A] hover:underline"
            >
              Usar paciente semilla Ana Sofía (+526670000001)
            </button>
          </div>

          <section className="space-y-2 pb-5 border-b border-[#E4E7EB]">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
              Verificación Step-Up OTP (Out-of-Band)
            </h2>
            <p className="text-xs text-[#52606D] leading-relaxed">
              Por seguridad, el código de 6 dígitos <strong>nunca</strong> se muestra dentro de
              este chat. Cuando el sistema lo solicite, consúltalo en la Consola 2FA externa.
            </p>
            <Link
              to="/lab/otp-2fa"
              target="_blank"
              className="inline-block text-xs font-semibold text-[#00875A] hover:underline"
            >
              Abrir Consola 2FA en otra pestaña →
            </Link>
          </section>

          {lastWamid && (
            <section className="space-y-2">
              <code className="block text-[11px] font-mono text-[#52606D] truncate">
                Último wamid: {lastWamid}
              </code>
              <button
                type="button"
                disabled={sending}
                onClick={() => sendMessage("Mensaje repetido", lastWamid)}
                className="w-full py-2 px-3 border border-[#E4E7EB] text-xs font-semibold text-[#1F2933] hover:border-[#00875A] hover:text-[#00875A] transition-colors"
              >
                Probar reenvío duplicado (Idempotencia)
              </button>
            </section>
          )}
        </aside>

        {/* Panel derecho: conversación plana con divisores de 1px */}
        <section className="lg:col-span-8 lg:border-l lg:border-[#E4E7EB] lg:pl-10 flex flex-col h-[620px]">
          <header className="pb-4 border-b border-[#E4E7EB] flex items-baseline justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-[#00875A]">
                Salud Digna · Atención Omnicanal
              </h2>
              <p className="text-xs text-[#52606D] font-mono">Cuenta verificada · {phone}</p>
            </div>
            <small className="text-xs text-[#52606D]">Orquestador determinístico</small>
          </header>

          {lastNotice && (
            <p className="border-b border-[#E4E7EB] py-2.5 text-xs font-semibold text-[#00875A]">
              {lastNotice}
            </p>
          )}
          {error && (
            <p className="border-b border-[#E4E7EB] py-2.5 text-xs font-semibold text-[#B42318]">
              {error}
            </p>
          )}

          {/* Lista de mensajes plana */}
          <div className="flex-1 overflow-y-auto py-4">
            {messages.length === 0 ? (
              <div className="py-12 space-y-2 max-w-md">
                <h3 className="text-sm font-bold text-[#1F2933]">
                  Inicia la conversación desde WhatsApp
                </h3>
                <p className="text-xs text-[#52606D] leading-relaxed">
                  Si acabas de guardar o pausar un trámite en <strong>Estudios y citas</strong>,
                  escribe <em>"Hola, quiero continuar con mi estudio"</em> para activar la
                  verificación Step-Up OTP y rehidratar tu contexto.
                </p>
              </div>
            ) : (
              <ol className="divide-y divide-[#E4E7EB]">
                {messages.map((m, idx) => {
                  const isInbound = m.direction === "inbound";
                  return (
                    <li
                      key={m.id || `${m.timestamp}-${idx}`}
                      className={`py-4 pl-4 border-l-2 ${
                        isInbound ? "border-[#00875A]" : "border-[#E4E7EB]"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3 text-xs mb-1">
                        <strong
                          className={`font-semibold ${
                            isInbound ? "text-[#00875A]" : "text-[#1F2933]"
                          }`}
                        >
                          {isInbound ? "Paciente" : "Salud Digna"}
                        </strong>
                        <time dateTime={m.timestamp} className="font-mono text-[11px] text-[#52606D]">
                          {formatTimeShort(m.timestamp)}
                        </time>
                      </div>
                      <p className="text-sm text-[#1F2933] whitespace-pre-wrap leading-relaxed">
                        {m.text}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Sugerencias rápidas planas */}
          <ul className="border-t border-[#E4E7EB] py-2.5 flex items-center gap-3 overflow-x-auto">
            {QUICK_MESSAGES.map((qm) => (
              <li key={qm} className="shrink-0">
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => sendMessage(qm)}
                  className="px-3 py-1 border border-[#E4E7EB] text-xs font-medium text-[#52606D] hover:border-[#00875A] hover:text-[#00875A] transition-colors"
                >
                  {qm}
                </button>
              </li>
            ))}
          </ul>

          {/* Envío con único botón naranja #E86A17 */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(inputText);
            }}
            className="border-t border-[#E4E7EB] pt-3 flex items-center gap-2"
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Escribe un mensaje o pega el código OTP de 6 dígitos..."
              aria-label="Mensaje de WhatsApp"
              disabled={sending}
              className="flex-1 h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
            />
            <button
              type="submit"
              disabled={sending || !inputText.trim()}
              className="h-11 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] font-semibold text-sm transition-colors disabled:opacity-50"
            >
              Enviar
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
