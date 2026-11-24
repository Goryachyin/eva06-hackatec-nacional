import React, { useCallback, useEffect, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  KeyRound,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
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
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#0066B3] mb-1">
            <KeyRound className="w-4 h-4" />
            Seguridad Step-Up 2FA · Canal Out-of-Band
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">
            Consola Externa de Códigos OTP
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Simula el buzón SMS/Correo independiente del paciente. Los códigos expiran en Redis
            automáticamente a los 5 minutos y se invalidan tras 3 intentos fallidos.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-[#00843D] border border-emerald-200 text-xs font-semibold">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            Polling 2s
          </span>
          <button
            type="button"
            onClick={fetchInbox}
            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
            title="Refrescar ahora"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-sm text-slate-400">
          Consultando desafíos OTP activos en Redis...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center">
            <Smartphone className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-slate-800">No hay códigos OTP activos</h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            Cuando un paciente cambie de canal (por ejemplo, de Sitio Web a WhatsApp), el
            Orquestador emitirá un reto Step-Up OTP y el código aparecerá aquí al instante.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((item) => {
            const pct = Math.max(0, Math.min(100, Math.round((item.ttlSeconds / 300) * 100)));
            const isCopied = copiedCode === item.code;
            return (
              <div
                key={`${item.patientId}-${item.code}`}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-500">Paciente</div>
                    <div className="font-bold text-slate-900">{item.patientMasked}</div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">
                      Destino: {item.destinationMasked}
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#EBF4FC] text-[#0066B3]">
                    Canal: {item.channel}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Código de verificación
                    </div>
                    <div className="text-3xl font-extrabold font-mono tracking-[0.25em] text-[#005A2B] mt-0.5">
                      {item.code}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(item.code)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${
                      isCopied
                        ? "bg-[#00843D] text-white"
                        : "bg-white border border-slate-300 hover:bg-slate-100 text-slate-700"
                    }`}
                  >
                    {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {isCopied ? "Copiado" : "Copiar"}
                  </button>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      Vigencia Redis TTL
                    </span>
                    <span className="font-bold text-slate-800">{item.ttlSeconds}s restantes</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#00843D] transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Emitido: {formatTimeShort(item.createdAt)}</span>
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <ShieldCheck className="w-3 h-3" />
                      Máx. 3 intentos
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
