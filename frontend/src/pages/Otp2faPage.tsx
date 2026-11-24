import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatTimeShort } from "../lib/constants";
import { OtpInboxItem } from "../types/api";

export const Otp2faPage: React.FC = () => {
  const [items, setItems] = useState<OtpInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const fetchInbox = useCallback(async () => {
    try {
      const res = await api.getOtpInbox();
      setItems(res.items || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo consultar la bandeja 2FA.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInbox();
    const timer = window.setInterval(fetchInbox, 2000);
    return () => window.clearInterval(timer);
  }, [fetchInbox]);

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      window.setTimeout(() => setCopiedCode(null), 2000);
    } catch {
      // Fallback silencioso
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8 bg-[#FFFFFF] text-[#1F2933]">
      <header className="pb-6 border-b border-[#E4E7EB] flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
            Seguridad Step-Up 2FA · Canal Out-of-Band
          </p>
          <h1 className="text-3xl font-bold text-[#1F2933]">Consola externa de códigos OTP</h1>
          <p className="text-sm text-[#52606D] max-w-2xl">
            Simula el buzón SMS/Correo independiente del paciente. Los códigos expiran en Redis a
            los 5 minutos y se invalidan tras 3 intentos fallidos.
          </p>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <small className="text-xs font-semibold text-[#00875A]">Actualización cada 2s</small>
          <button
            type="button"
            onClick={fetchInbox}
            className="h-10 px-4 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-xs font-semibold transition-colors"
          >
            Refrescar
          </button>
        </div>
      </header>

      {error && (
        <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
      )}

      {loading ? (
        <p className="py-10 text-sm text-[#52606D]">Consultando desafíos OTP activos en Redis...</p>
      ) : items.length === 0 ? (
        <div className="py-12 space-y-2">
          <h2 className="text-base font-bold text-[#1F2933]">No hay códigos OTP activos</h2>
          <p className="text-sm text-[#52606D] max-w-lg leading-relaxed">
            Cuando un paciente cambie de canal (por ejemplo, de Sitio Web a WhatsApp), el
            Orquestador emitirá un reto Step-Up OTP y el código aparecerá aquí al instante.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
          {items.map((item) => {
            const pct = Math.max(0, Math.min(100, Math.round((item.ttlSeconds / 300) * 100)));
            const isCopied = copiedCode === item.code;
            return (
              <li
                key={`${item.patientId}-${item.code}`}
                className="py-6 grid grid-cols-1 md:grid-cols-12 gap-6 items-center"
              >
                <div className="md:col-span-5 space-y-1">
                  <small className="block text-[11px] font-semibold uppercase tracking-wider text-[#00875A]">
                    Canal: {item.channel}
                  </small>
                  <h2 className="text-base font-bold text-[#1F2933]">{item.patientMasked}</h2>
                  <p className="text-xs font-mono text-[#52606D]">
                    Destino: {item.destinationMasked}
                  </p>
                  <p className="text-xs text-[#52606D]">
                    Emitido: <time dateTime={item.createdAt}>{formatTimeShort(item.createdAt)}</time>{" "}
                    · Máx. 3 intentos
                  </p>
                </div>

                <div className="md:col-span-4 space-y-2">
                  <div className="flex items-baseline justify-between text-xs">
                    <p className="text-[#52606D]">Vigencia Redis TTL</p>
                    <strong className="text-[#1F2933]">{item.ttlSeconds}s restantes</strong>
                  </div>
                  <div className="w-full h-1.5 bg-[#E4E7EB]">
                    <div className="h-full bg-[#00875A]" style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <div className="md:col-span-3 flex md:flex-col items-center md:items-end justify-between gap-3">
                  <strong className="text-3xl font-bold font-mono tracking-[0.2em] text-[#1F2933]">
                    {item.code}
                  </strong>
                  <button
                    type="button"
                    onClick={() => handleCopy(item.code)}
                    className={`px-3.5 py-1.5 text-xs font-semibold border transition-colors ${
                      isCopied
                        ? "bg-[#00875A] border-[#00875A] text-[#FFFFFF]"
                        : "bg-[#FFFFFF] border-[#E4E7EB] text-[#1F2933] hover:border-[#00875A]"
                    }`}
                  >
                    {isCopied ? "Copiado" : "Copiar código"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
