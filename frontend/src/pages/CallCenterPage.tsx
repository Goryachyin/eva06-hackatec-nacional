import React, { useCallback, useEffect, useMemo, useState } from "react";
import { QrCode } from "lucide-react";
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
        <div className="max-w-md mx-auto px-4 py-16 space-y-8">
          <header className="pb-6 border-b border-[#E4E7EB] space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Acceso operativo · Call Center
            </p>
            <h1 className="text-3xl font-bold text-[#1F2933]">Estación de asesores</h1>
            <p className="text-sm text-[#52606D]">
              Inicia sesión con tu cuenta institucional de asesor para atender pacientes con
              contexto omnicanal.
            </p>
          </header>

          <form onSubmit={handleLogin} className="space-y-6">
            {loginError && (
              <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">
                {loginError}
              </p>
            )}
            <div>
              <label
                htmlFor="cc-email"
                className="block text-xs font-semibold text-[#1F2933] mb-1.5"
              >
                Correo institucional
              </label>
              <input
                id="cc-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="asesor@saluddigna.demo"
                required
                className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
            </div>
            <div>
              <label
                htmlFor="cc-pass"
                className="block text-xs font-semibold text-[#1F2933] mb-1.5"
              >
                Contraseña
              </label>
              <input
                id="cc-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full h-12 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] font-semibold text-sm transition-colors disabled:opacity-50"
            >
              {loginLoading ? "Ingresando..." : "Iniciar sesión"}
            </button>
          </form>
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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        {screenPopNotice && (
          <p className="border-l-2 border-[#00875A] pl-4 py-1 text-sm font-semibold text-[#00875A]">
            {screenPopNotice}
          </p>
        )}

        {error && (
          <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* Cola vertical */}
          <aside className="lg:col-span-4 space-y-4">
            <div className="pb-3 border-b border-[#E4E7EB] flex items-center justify-between">
              <h2 className="text-base font-bold text-[#1F2933]">Cola de casos ({cases.length})</h2>
              <button
                type="button"
                onClick={fetchQueue}
                className="text-xs font-semibold text-[#00875A] hover:underline"
              >
                {loading ? "Actualizando..." : "Actualizar"}
              </button>
            </div>

            {cases.length === 0 ? (
              <p className="py-8 text-xs text-[#52606D]">No hay casos activos en cola.</p>
            ) : (
              <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB] max-h-[680px] overflow-y-auto">
                {cases.map((c) => {
                  const active = c.id === selectedCaseId;
                  const fullName =
                    [c.patient.firstName, c.patient.paternalLastName].filter(Boolean).join(" ") ||
                    "Paciente";
                  const stMeta = STATE_META[c.currentState];
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedCaseId(c.id)}
                        className={`w-full text-left py-4 pl-3 pr-2 border-l-2 transition-colors ${
                          active
                            ? "border-[#00875A] bg-[#F7F8F9]"
                            : "border-transparent hover:bg-[#F7F8F9]"
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <strong className="text-sm font-semibold text-[#1F2933] truncate">
                            {fullName}
                          </strong>
                          <small className={`text-[11px] font-semibold shrink-0 ${stMeta.textClass}`}>
                            {stMeta.shortLabel}
                          </small>
                        </div>
                        <p className="text-xs text-[#52606D] mt-1 truncate">
                          {c.contextJson.study?.name || "Sin estudio aún"}
                        </p>
                        <p className="text-[11px] text-[#52606D] mt-1">
                          {CHANNEL_META[c.currentChannel].label} · v{c.version}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* Ficha Screen-Pop separada por línea vertical */}
          <section className="lg:col-span-8 lg:border-l lg:border-[#E4E7EB] lg:pl-10 space-y-8">
            {!selectedCase ? (
              <p className="py-12 text-sm text-[#52606D]">
                Selecciona un caso de la bandeja para ver el resumen handoff y confirmar la cita.
              </p>
            ) : (
              <>
                <header className="pb-6 border-b border-[#E4E7EB] flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                      Ficha de paciente · Screen-Pop
                    </p>
                    <h2 className="text-2xl font-bold text-[#1F2933] mt-1">
                      {[
                        selectedCase.patient.firstName,
                        selectedCase.patient.paternalLastName,
                        selectedCase.patient.maternalLastName,
                      ]
                        .filter(Boolean)
                        .join(" ") || "Paciente sin nombre"}
                    </h2>
                    <p className="text-xs font-mono text-[#52606D] mt-1">
                      {selectedCase.patient.phone ? `Tel: ${selectedCase.patient.phone} · ` : ""}
                      {selectedCase.patient.curp ? `CURP: ${selectedCase.patient.curp} · ` : ""}
                      v{selectedCase.version}
                    </p>
                  </div>
                  <strong
                    className={`text-xs font-semibold ${STATE_META[selectedCase.currentState].textClass}`}
                  >
                    {STATE_META[selectedCase.currentState].label}
                  </strong>
                </header>

                <div className="border-l-2 border-[#00875A] pl-4 space-y-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                    Resumen determinístico de handoff
                  </h3>
                  <p className="text-sm text-[#1F2933] leading-relaxed">
                    {selectedCase.contextJson.handoff_summary ||
                      "Contexto inicial registrado. Listo para atención del asesor."}
                  </p>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-3 border-t border-l border-[#E4E7EB] text-xs">
                  <div className="p-4 border-r border-b border-[#E4E7EB]">
                    <dt className="text-[#52606D]">Estudio</dt>
                    <dd className="font-semibold text-[#1F2933] mt-1">
                      {selectedCase.contextJson.study?.name || "Por definir"}
                    </dd>
                    {selectedCase.contextJson.study?.price && (
                      <dd className="font-bold text-[#00875A] mt-0.5">
                        {formatMoney(selectedCase.contextJson.study.price)}
                      </dd>
                    )}
                  </div>
                  <div className="p-4 border-r border-b border-[#E4E7EB]">
                    <dt className="text-[#52606D]">Clínica</dt>
                    <dd className="font-semibold text-[#1F2933] mt-1">
                      {selectedCase.contextJson.clinic?.name || "Por definir"}
                    </dd>
                    <dd className="text-[#52606D] mt-0.5">
                      {selectedCase.contextJson.clinic?.city || ""}
                    </dd>
                  </div>
                  <div className="p-4 border-r border-b border-[#E4E7EB]">
                    <dt className="text-[#52606D]">Horario solicitado</dt>
                    <dd className="font-semibold text-[#1F2933] mt-1">
                      {selectedCase.contextJson.preferred_slot
                        ? `${selectedCase.contextJson.preferred_slot.date} · ${selectedCase.contextJson.preferred_slot.time}`
                        : "Sin horario definido"}
                    </dd>
                  </div>
                </dl>

                {selectedCase.currentState === "CITA_CONFIRMADA" &&
                selectedCase.contextJson.appointment_folio ? (
                  <div className="border-l-2 border-[#00875A] pl-5 py-1 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                        Cita confirmada con éxito
                      </p>
                      <strong className="block text-2xl font-bold font-mono text-[#1F2933]">
                        {selectedCase.contextJson.appointment_folio}
                      </strong>
                      <code className="block text-xs font-mono text-[#52606D] break-all">
                        QR: {selectedCase.contextJson.qr_payload}
                      </code>
                    </div>
                    <div className="p-2 border border-[#E4E7EB] shrink-0 self-start">
                      <QrCode className="w-14 h-14 text-[#1F2933]" />
                    </div>
                  </div>
                ) : (
                  <div className="pt-6 border-t border-[#E4E7EB] space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label
                          htmlFor="cc-date"
                          className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                        >
                          Fecha de cita
                        </label>
                        <input
                          id="cc-date"
                          type="date"
                          value={preferredDate}
                          onChange={(e) => setPreferredDate(e.target.value)}
                          className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="cc-time"
                          className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                        >
                          Hora de cita
                        </label>
                        <input
                          id="cc-time"
                          type="text"
                          value={preferredTime}
                          onChange={(e) => setPreferredTime(e.target.value)}
                          placeholder="09:30"
                          className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="cc-notes"
                          className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                        >
                          Notas del asesor
                        </label>
                        <input
                          id="cc-notes"
                          type="text"
                          value={advisorNotes}
                          onChange={(e) => setAdvisorNotes(e.target.value)}
                          placeholder="Confirmado con paciente..."
                          className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={handleAssign}
                        className="h-11 px-5 border border-[#00875A] text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] font-semibold text-sm transition-colors disabled:opacity-50"
                      >
                        Tomar caso
                      </button>

                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={handleConfirm}
                        className="h-11 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] font-semibold text-sm transition-colors disabled:opacity-50"
                      >
                        Confirmar cita (Folio + QR)
                      </button>
                    </div>
                  </div>
                )}

                <section className="pt-6 border-t border-[#E4E7EB] space-y-4">
                  <h3 className="text-sm font-bold text-[#1F2933]">
                    Historial cronológico ({selectedCase.journeyEvents.length} eventos)
                  </h3>
                  <ol className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB] max-h-64 overflow-y-auto">
                    {selectedCase.journeyEvents.map((ev) => {
                      const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                        label: ev.eventType,
                        tone: "text-[#1F2933]",
                      };
                      return (
                        <li
                          key={ev.id}
                          className="py-3 flex flex-wrap items-baseline justify-between gap-2 text-xs"
                        >
                          <p className="text-[#52606D]">
                            <strong className={`font-semibold ${evMeta.tone}`}>
                              {evMeta.label}
                            </strong>{" "}
                            · {ev.channel}
                            {ev.nextState ? ` · ${ev.prevState ?? "—"} → ${ev.nextState}` : ""}
                          </p>
                          <time dateTime={ev.createdAt} className="font-mono text-[11px] text-[#52606D]">
                            {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                          </time>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              </>
            )}
          </section>
        </div>
      </div>
    </CallCenterLayout>
  );
};
