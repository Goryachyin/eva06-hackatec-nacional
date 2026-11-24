import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  CheckCircle2,
  Clock,
  Lock,
  PhoneCall,
  QrCode,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import { CallCenterLayout } from "../components/layouts/CallCenterLayout";
import {
  api,
  ApiError,
  clearStaffSession,
  getApiBaseUrl,
  getStaffToken,
  getStaffUser,
  saveStaffSession,
} from "../lib/api";
import {
  CHANNEL_META,
  EVENT_TYPE_LABELS,
  formatDateTime,
  formatMoney,
  formatTimeShort,
  STATE_META,
} from "../lib/constants";
import { CallCenterCaseItem, StaffUser } from "../types/api";

export const CallCenterPage: React.FC = () => {
  const [token, setToken] = useState<string | null>(() => getStaffToken("ASESOR"));
  const [user, setUser] = useState<StaffUser | null>(() => getStaffUser("ASESOR"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [cases, setCases] = useState<CallCenterCaseItem[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [screenPopNotice, setScreenPopNotice] = useState<string | null>(null);

  const [advisorNotes, setAdvisorNotes] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [preferredTime, setPreferredTime] = useState("");

  const fetchQueue = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await api.getCallCenterQueue(token);
      setCases(res.cases || []);
      setError(null);
      setSelectedCaseId((prev) => {
        if (prev && res.cases.some((c) => c.id === prev)) return prev;
        return res.cases[0]?.id ?? null;
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStaffSession("ASESOR");
        setToken(null);
        setUser(null);
        setLoginError("Tu sesión expiró. Inicia sesión nuevamente.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudo cargar la bandeja.");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchQueue();
  }, [token, fetchQueue]);

  useEffect(() => {
    if (!token) {
      setSseConnected(false);
      return;
    }
    const es = new EventSource(
      `${getApiBaseUrl()}/api/stream/events?token=${encodeURIComponent(token)}`
    );
    es.addEventListener("connected", () => setSseConnected(true));
    es.addEventListener("journey_event", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as {
          eventType?: string;
          caseId?: string;
          channel?: string;
        };
        setScreenPopNotice(
          `Screen-Pop en vivo: ${data.eventType || "EVENTO"} (${data.channel || "SISTEMA"})`
        );
        if (data.caseId) setSelectedCaseId(data.caseId);
        fetchQueue();
        window.setTimeout(() => setScreenPopNotice(null), 5000);
      } catch {
        // Ignorar
      }
    });
    es.onerror = () => setSseConnected(false);
    return () => es.close();
  }, [token, fetchQueue]);

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) || null,
    [cases, selectedCaseId]
  );

  useEffect(() => {
    if (selectedCase) {
      setPreferredDate(selectedCase.contextJson.preferred_slot?.date || "");
      setPreferredTime(selectedCase.contextJson.preferred_slot?.time || "");
    }
  }, [selectedCase?.id]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await api.login(email.trim(), password);
      saveStaffSession("ASESOR", res);
      setToken(res.token);
      setUser(res.user);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Credenciales inválidas.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleAssign = async () => {
    if (!token || !selectedCase) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.assignCallCenterCase(token, selectedCase.id, selectedCase.version);
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar el caso.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!token || !selectedCase) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.confirmCallCenterCase(token, selectedCase.id, {
        expectedVersion: selectedCase.version,
        ...(preferredDate ? { preferredDate } : {}),
        ...(preferredTime ? { preferredTime } : {}),
        ...(advisorNotes.trim() ? { advisorNotes: advisorNotes.trim() } : {}),
      });
      setAdvisorNotes("");
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar la cita.");
    } finally {
      setActionLoading(false);
    }
  };

  if (!token) {
    return (
      <CallCenterLayout user={null} sseConnected={false}>
        <div className="max-w-md mx-auto px-4 py-16">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
            <div className="bg-gradient-to-r from-[#0F172A] to-[#0066B3] px-6 py-6 text-white">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider bg-white/15 px-2.5 py-1 rounded-full mb-3">
                <Lock className="w-3.5 h-3.5" />
                Acceso Operativo · Call Center
              </div>
              <h1 className="text-xl font-extrabold">Estación de Asesores</h1>
              <p className="text-blue-100 text-xs mt-1">
                Inicia sesión con tu cuenta institucional de asesor para atender pacientes con
                contexto omnicanal.
              </p>
            </div>

            <form onSubmit={handleLogin} className="p-6 space-y-4">
              {loginError && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">
                  {loginError}
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Correo institucional
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="asesor@saluddigna.demo"
                  required
                  className="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">Contraseña</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={loginLoading}
                className="w-full h-11 bg-[#0066B3] hover:bg-[#005291] text-white font-bold rounded-lg text-sm transition"
              >
                {loginLoading ? "Ingresando..." : "Iniciar sesión"}
              </button>
            </form>
          </div>
        </div>
      </CallCenterLayout>
    );
  }

  return (
    <CallCenterLayout
      user={user}
      sseConnected={sseConnected}
      onLogout={() => {
        clearStaffSession("ASESOR");
        setToken(null);
        setUser(null);
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {screenPopNotice && (
          <div className="p-3.5 rounded-xl bg-[#0066B3] text-white text-sm font-semibold flex items-center gap-2 shadow-md">
            <BellRing className="w-4 h-4 animate-bounce" />
            {screenPopNotice}
          </div>
        )}

        {error && (
          <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Cola */}
          <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col max-h-[700px]">
            <div className="p-4 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900">Cola de Casos ({cases.length})</h2>
              <button
                type="button"
                onClick={fetchQueue}
                className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600"
                title="Actualizar bandeja"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {cases.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No hay casos activos en cola.
                </div>
              ) : (
                cases.map((c) => {
                  const active = c.id === selectedCaseId;
                  const fullName =
                    [c.patient.firstName, c.patient.paternalLastName].filter(Boolean).join(" ") ||
                    "Paciente";
                  const stMeta = STATE_META[c.currentState];
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedCaseId(c.id)}
                      className={`w-full text-left p-4 transition ${
                        active ? "bg-[#E6F4EC]/70 border-l-4 border-[#00843D]" : "hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-sm text-slate-900 truncate">
                          {fullName}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${stMeta.badgeClass}`}
                        >
                          {stMeta.shortLabel}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 mt-1 truncate">
                        {c.contextJson.study?.name || "Sin estudio aún"}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1.5">
                        <span>{CHANNEL_META[c.currentChannel].label}</span>
                        <span>v{c.version}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Ficha Screen-Pop */}
          <div className="lg:col-span-8 space-y-5">
            {!selectedCase ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-sm text-slate-400">
                Selecciona un caso de la bandeja para ver el Resumen Handoff y confirmar la cita.
              </div>
            ) : (
              <>
                <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-5">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-slate-100">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-[#00843D]">
                        Ficha de Paciente · Screen-Pop
                      </div>
                      <h2 className="text-2xl font-extrabold text-slate-900 mt-0.5">
                        {[
                          selectedCase.patient.firstName,
                          selectedCase.patient.paternalLastName,
                          selectedCase.patient.maternalLastName,
                        ]
                          .filter(Boolean)
                          .join(" ") || "Paciente sin nombre"}
                      </h2>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1 font-mono">
                        {selectedCase.patient.phone && (
                          <span>Tel: {selectedCase.patient.phone}</span>
                        )}
                        {selectedCase.patient.curp && (
                          <span>CURP: {selectedCase.patient.curp}</span>
                        )}
                        <span>v{selectedCase.version}</span>
                      </div>
                    </div>
                    <span
                      className={`self-start px-3 py-1 rounded-full text-xs font-bold border ${
                        STATE_META[selectedCase.currentState].badgeClass
                      }`}
                    >
                      {STATE_META[selectedCase.currentState].label}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-[#E6F4EC] border border-[#00843D]/30 space-y-1.5">
                    <div className="text-xs font-bold uppercase tracking-wider text-[#005A2B]">
                      Resumen Determinístico de Handoff
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed font-medium">
                      {selectedCase.contextJson.handoff_summary ||
                        "Contexto inicial registrado. Listo para atención del asesor."}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                      <div className="text-slate-400 font-semibold">Estudio</div>
                      <div className="font-bold text-slate-900 mt-0.5">
                        {selectedCase.contextJson.study?.name || "Por definir"}
                      </div>
                      {selectedCase.contextJson.study?.price && (
                        <div className="text-[#00843D] font-bold mt-0.5">
                          {formatMoney(selectedCase.contextJson.study.price)}
                        </div>
                      )}
                    </div>
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                      <div className="text-slate-400 font-semibold">Clínica</div>
                      <div className="font-bold text-slate-900 mt-0.5">
                        {selectedCase.contextJson.clinic?.name || "Por definir"}
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        {selectedCase.contextJson.clinic?.city || ""}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                      <div className="text-slate-400 font-semibold">Horario solicitado</div>
                      <div className="font-bold text-slate-900 mt-0.5">
                        {selectedCase.contextJson.preferred_slot
                          ? `${selectedCase.contextJson.preferred_slot.date} · ${selectedCase.contextJson.preferred_slot.time}`
                          : "Sin horario definido"}
                      </div>
                    </div>
                  </div>

                  {selectedCase.currentState === "CITA_CONFIRMADA" &&
                  selectedCase.contextJson.appointment_folio ? (
                    <div className="p-5 rounded-2xl bg-emerald-50 border border-emerald-300 flex flex-col sm:flex-row items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase text-[#00843D]">
                          <CheckCircle2 className="w-4 h-4" />
                          Cita Confirmada con Éxito
                        </div>
                        <div className="text-2xl font-extrabold font-mono text-[#005A2B]">
                          {selectedCase.contextJson.appointment_folio}
                        </div>
                        <div className="text-xs font-mono text-slate-600 break-all">
                          QR: {selectedCase.contextJson.qr_payload}
                        </div>
                      </div>
                      <div className="p-3 bg-white rounded-xl border border-emerald-200 shadow-sm shrink-0">
                        <QrCode className="w-16 h-16 text-[#005A2B]" />
                      </div>
                    </div>
                  ) : (
                    <div className="pt-4 border-t border-slate-100 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">
                            Fecha de cita
                          </label>
                          <input
                            type="date"
                            value={preferredDate}
                            onChange={(e) => setPreferredDate(e.target.value)}
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">
                            Hora de cita
                          </label>
                          <input
                            type="text"
                            value={preferredTime}
                            onChange={(e) => setPreferredTime(e.target.value)}
                            placeholder="09:30"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">
                            Notas del asesor
                          </label>
                          <input
                            type="text"
                            value={advisorNotes}
                            onChange={(e) => setAdvisorNotes(e.target.value)}
                            placeholder="Confirmado con paciente..."
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={actionLoading}
                          onClick={handleAssign}
                          className="inline-flex items-center gap-2 bg-[#0066B3] hover:bg-[#005291] text-white font-bold px-4 py-2.5 rounded-xl text-sm transition disabled:opacity-50"
                        >
                          <PhoneCall className="w-4 h-4" />
                          Tomar caso
                        </button>

                        <button
                          type="button"
                          disabled={actionLoading}
                          onClick={handleConfirm}
                          className="inline-flex items-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-5 py-2.5 rounded-xl text-sm shadow-sm transition disabled:opacity-50"
                        >
                          <UserCheck className="w-4 h-4" />
                          Confirmar cita (Folio + QR)
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#00843D]" />
                    Historial Cronológico ({selectedCase.journeyEvents.length} eventos)
                  </h3>
                  <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                    {selectedCase.journeyEvents.map((ev) => {
                      const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                        label: ev.eventType,
                        tone: "text-slate-700 bg-slate-100",
                      };
                      return (
                        <div
                          key={ev.id}
                          className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded font-bold ${evMeta.tone}`}>
                              {evMeta.label}
                            </span>
                            <span className="text-slate-500 font-semibold">{ev.channel}</span>
                            {ev.nextState && (
                              <span className="inline-flex items-center gap-1 text-slate-700 font-medium">
                                {ev.prevState ?? "—"}
                                <ArrowRight className="w-3 h-3" />
                                {ev.nextState}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] font-mono text-slate-400">
                            {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </CallCenterLayout>
  );
};
