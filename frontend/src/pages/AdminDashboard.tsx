import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout, AdminTab } from "../components/layouts/AdminLayout";
import { BusArchitectureView } from "../components/BusArchitectureView";
import { OrderJourneyTracker } from "../components/OrderJourneyTracker";
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
  CANONICAL_STATES,
  CHANNEL_META,
  EVENT_TYPE_LABELS,
  formatDateTime,
  formatMoney,
  formatTimeShort,
  STATE_META,
} from "../lib/constants";
import {
  AdminOverviewResponse,
  AdminSanitizedCase,
  AdminUserLookupItem,
  CaseState,
  Channel,
  ClinicItem,
  HealthResponse,
  JourneyEventItem,
  StaffUser,
  StudyItem,
} from "../types/api";
import { TIME_SLOTS } from "../lib/bookingContext";

interface LiveSseEvent {
  id: string;
  caseId?: string;
  journeyId?: string;
  correlationId?: string;
  channel?: Channel;
  actorRole?: string;
  eventType: string;
  prevState?: CaseState | null;
  nextState?: CaseState | null;
  timestamp: string;
}

export const AdminDashboard: React.FC = () => {
  const [token, setToken] = useState<string | null>(() => getStaffToken("ADMIN"));
  const [user, setUser] = useState<StaffUser | null>(() => getStaffUser("ADMIN"));
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [sseStatus, setSseStatus] = useState<"disconnected" | "connected" | "reconnecting">(
    "disconnected"
  );
  const [liveEvents, setLiveEvents] = useState<LiveSseEvent[]>([]);

  const [selectedStateFilter, setSelectedStateFilter] = useState<CaseState | "ALL">("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const [inspectCase, setInspectCase] = useState<AdminSanitizedCase | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<JourneyEventItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupResults, setLookupResults] = useState<AdminUserLookupItem[] | null>(null);

  // Catálogo para edición administrativa de citas
  const [studies, setStudies] = useState<StudyItem[]>([]);
  const [clinics, setClinics] = useState<ClinicItem[]>([]);
  const catalogLoadedRef = useRef(false);

  // Estado de edición de cita (dentro del panel lateral de auditoría)
  const [editingCase, setEditingCase] = useState(false);
  const [editStudyCode, setEditStudyCode] = useState("");
  const [editClinicId, setEditClinicId] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("09:30");
  const [editPayment, setEditPayment] = useState<"online" | "oxxo" | "clinic">("online");
  const [editState, setEditState] = useState<CaseState>("INICIADO");
  const [editCancelled, setEditCancelled] = useState(false);
  const [editAdminNotes, setEditAdminNotes] = useState("");
  const [editCaseSaving, setEditCaseSaving] = useState(false);
  const [editCaseFeedback, setEditCaseFeedback] = useState<string | null>(null);

  // Estado de edición de cuenta de usuario (en pestaña Consultar usuario)
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [uFirstName, setUFirstName] = useState("");
  const [uPaternal, setUPaternal] = useState("");
  const [uMaternal, setUMaternal] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPhone, setUPhone] = useState("");
  const [uCurp, setUCurp] = useState("");
  const [uBirthDate, setUBirthDate] = useState("");
  const [uGender, setUGender] = useState<"" | "FEMENINO" | "MASCULINO">("");
  const [uBirthState, setUBirthState] = useState("");
  const [uCountry, setUCountry] = useState("MEXICO");
  const [uNewPassword, setUNewPassword] = useState("");
  const [editUserSaving, setEditUserSaving] = useState(false);
  const [editUserFeedback, setEditUserFeedback] = useState<string | null>(null);

  const refreshTimerRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const inspectCaseIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<AdminTab>(activeTab);
  const lookupQueryRef = useRef(lookupQuery);
  const hasLookupResultsRef = useRef(false);

  useEffect(() => {
    inspectCaseIdRef.current = inspectCase?.id ?? null;
  }, [inspectCase?.id]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    lookupQueryRef.current = lookupQuery;
  }, [lookupQuery]);
  useEffect(() => {
    hasLookupResultsRef.current = lookupResults !== null;
  }, [lookupResults]);

  const fetchOverview = useCallback(async () => {
    if (!token) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [ov, hl, cat] = await Promise.all([
        api.getAdminOverview(token),
        api.getHealth().catch(() => null),
        catalogLoadedRef.current ? Promise.resolve(null) : api.getCatalog().catch(() => null),
      ]);
      if (seq !== fetchSeqRef.current) return;
      if (cat) {
        catalogLoadedRef.current = true;
        setStudies(cat.studies);
        setClinics(cat.clinics);
      }
      setOverview(ov);
      setInspectCase((prev) => {
        if (!prev) return null;
        return ov.cases.find((item) => item.id === prev.id) ?? prev;
      });
      if (hl) setHealth(hl);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStaffSession("ADMIN");
        setToken(null);
        setUser(null);
        setLoginError("Tu sesión expiró o no tiene permisos ADMIN.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudieron cargar las métricas.");
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchOverview();
  }, [token, fetchOverview]);

  useEffect(() => {
    if (!token) {
      setSseStatus("disconnected");
      return;
    }

    const sseUrl = `${getApiBaseUrl()}/api/stream/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(sseUrl);

    es.addEventListener("connected", () => setSseStatus("connected"));

    es.addEventListener("journey_event", (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as Record<string, unknown>;
        const item: LiveSseEvent = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          caseId: parsed.caseId as string | undefined,
          journeyId: parsed.journeyId as string | undefined,
          correlationId: parsed.correlationId as string | undefined,
          channel: parsed.channel as Channel | undefined,
          actorRole: parsed.actorRole as string | undefined,
          eventType: (parsed.eventType as string) || "JOURNEY_EVENT",
          prevState: (parsed.prevState as CaseState | null) ?? null,
          nextState: (parsed.nextState as CaseState | null) ?? null,
          timestamp: (parsed.createdAt as string) || new Date().toISOString(),
        };
        setLiveEvents((prev) => [item, ...prev].slice(0, 40));

        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          fetchOverview();
          const openCaseId = inspectCaseIdRef.current;
          if (openCaseId && (!item.caseId || item.caseId === openCaseId)) {
            api
              .getCaseTimeline(token, openCaseId)
              .then((res) => setTimelineEvents(res.events))
              .catch(() => {});
          }
          if (
            activeTabRef.current === "user-lookup" &&
            hasLookupResultsRef.current &&
            lookupQueryRef.current.trim()
          ) {
            api
              .lookupAdminUsers(token, lookupQueryRef.current.trim())
              .then((res) => setLookupResults(res.results))
              .catch(() => {});
          }
        }, 280);
      } catch {
        // Ignorar trama malformada
      }
    });

    es.onerror = () => setSseStatus("reconnecting");

    return () => {
      es.close();
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    };
  }, [token, fetchOverview]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await api.login(email.trim(), password);
      if (res.user.role !== "ADMIN") {
        setLoginError("Acceso denegado. Esta consola es exclusiva para rol Administrador.");
        return;
      }
      saveStaffSession("ADMIN", res);
      setToken(res.token);
      setUser(res.user);
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : "Credenciales inválidas o servicio no disponible."
      );
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    clearStaffSession("ADMIN");
    setToken(null);
    setUser(null);
    setOverview(null);
    setLiveEvents([]);
    setLookupResults(null);
  };

  const populateCaseEditor = (c: AdminSanitizedCase) => {
    setEditStudyCode(c.contextSummary.study?.code || studies[0]?.code || "");
    setEditClinicId(c.contextSummary.clinic?.id || clinics[0]?.id || "");
    setEditDate(c.contextSummary.preferred_slot?.date || new Date().toISOString().slice(0, 10));
    setEditTime(c.contextSummary.preferred_slot?.time || "09:30");
    setEditPayment(c.contextSummary.payment_method || "online");
    setEditState(c.currentState);
    setEditCancelled(Boolean(c.contextSummary.cancelled));
    setEditAdminNotes("");
    setEditCaseFeedback(null);
  };

  const openTimeline = async (c: AdminSanitizedCase, startEditing = false) => {
    if (!token) return;
    setInspectCase(c);
    populateCaseEditor(c);
    setEditingCase(startEditing);
    setTimelineLoading(true);
    setTimelineEvents([]);
    try {
      const res = await api.getCaseTimeline(token, c.id);
      setTimelineEvents(res.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar la línea de tiempo.");
    } finally {
      setTimelineLoading(false);
    }
  };

  const handleSaveAdminCaseEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !inspectCase) return;
    setEditCaseSaving(true);
    setEditCaseFeedback(null);
    try {
      await api.updateAdminCase(token, inspectCase.id, {
        expectedVersion: inspectCase.version,
        ...(editStudyCode ? { studyCode: editStudyCode } : {}),
        ...(editClinicId ? { clinicId: editClinicId } : {}),
        preferredDate: editDate,
        preferredTime: editTime,
        paymentMethod: editPayment,
        nextState: editState,
        cancelled: editCancelled,
        adminNotes: editAdminNotes.trim() || undefined,
      });
      await fetchOverview();
      const tl = await api.getCaseTimeline(token, inspectCase.id);
      setTimelineEvents(tl.events);
      if (lookupQueryRef.current.trim() && hasLookupResultsRef.current) {
        const lk = await api.lookupAdminUsers(token, lookupQueryRef.current.trim());
        setLookupResults(lk.results);
      }
      setEditingCase(false);
      setEditCaseFeedback("Cita actualizada y sincronizada en todos los canales.");
    } catch (err) {
      setEditCaseFeedback(err instanceof Error ? err.message : "No se pudo actualizar la cita.");
    } finally {
      setEditCaseSaving(false);
    }
  };

  const startEditingUser = (u: AdminUserLookupItem) => {
    setEditingUserId(u.patientId);
    setUFirstName(u.firstName || "");
    setUPaternal(u.paternalLastName || "");
    setUMaternal(u.maternalLastName || "");
    setUEmail(u.email || "");
    setUPhone(u.phone || "");
    setUCurp(u.curp || "");
    setUBirthDate(u.birthDate || "");
    setUGender(u.gender === "FEMENINO" || u.gender === "MASCULINO" ? u.gender : "");
    setUBirthState(u.birthState || "");
    setUCountry(u.country || "MEXICO");
    setUNewPassword("");
    setEditUserFeedback(null);
  };

  const handleSaveAdminUserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingUserId) return;
    setEditUserSaving(true);
    setEditUserFeedback(null);
    try {
      await api.updateAdminUser(token, editingUserId, {
        ...(uFirstName.trim() ? { firstName: uFirstName.trim() } : {}),
        ...(uPaternal.trim() ? { paternalLastName: uPaternal.trim() } : {}),
        maternalLastName: uMaternal.trim() || null,
        email: uEmail.trim() || null,
        phone: uPhone.trim() || null,
        curp: uCurp.trim() || null,
        birthDate: uBirthDate.trim() || null,
        gender: uGender || null,
        birthState: uBirthState.trim() || null,
        country: uCountry.trim() || "MEXICO",
        ...(uNewPassword.trim().length >= 6 ? { newPassword: uNewPassword.trim() } : {}),
      });
      if (lookupQuery.trim()) {
        const res = await api.lookupAdminUsers(token, lookupQuery.trim());
        setLookupResults(res.results);
      }
      await fetchOverview();
      setEditingUserId(null);
      setEditUserFeedback("Cuenta del usuario actualizada y normalizada en todos los canales.");
    } catch (err) {
      setEditUserFeedback(err instanceof Error ? err.message : "No se pudo actualizar la cuenta.");
    } finally {
      setEditUserSaving(false);
    }
  };

  const handleUserLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !lookupQuery.trim()) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const res = await api.lookupAdminUsers(token, lookupQuery.trim());
      setLookupResults(res.results);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Error consultando al usuario.");
    } finally {
      setLookupLoading(false);
    }
  };

  const stateDistribution = useMemo(() => {
    const counts: Record<CaseState, number> = {
      INICIADO: 0,
      COTIZANDO: 0,
      CLINICA_ELEGIDA: 0,
      PAUSADO_PENDIENTE: 0,
      EN_PROGRESO: 0,
      DUDAS_ABIERTAS: 0,
      EN_ATENCION_ASESOR: 0,
      CITA_CONFIRMADA: 0,
    };
    for (const c of overview?.cases ?? []) {
      if (counts[c.currentState] !== undefined) counts[c.currentState] += 1;
    }
    const maxCount = Math.max(1, ...Object.values(counts));
    const total = Math.max(1, overview?.cases.length ?? 0);
    return CANONICAL_STATES.map((st) => ({
      state: st,
      count: counts[st],
      pct: overview?.cases.length ? Math.round((counts[st] / total) * 100) : 0,
      widthPct: counts[st] > 0 ? Math.max(6, Math.round((counts[st] / maxCount) * 100)) : 0,
    }));
  }, [overview]);

  const channelDistribution = useMemo(() => {
    const channels: Channel[] = ["WEB", "WHATSAPP", "CALL_CENTER", "APP", "SYSTEM"];
    const counts: Record<Channel, number> = {
      WEB: 0,
      WHATSAPP: 0,
      CALL_CENTER: 0,
      APP: 0,
      SYSTEM: 0,
    };
    for (const c of overview?.cases ?? []) {
      counts[c.currentChannel] = (counts[c.currentChannel] || 0) + 1;
    }
    const total = overview?.cases.length ?? 0;
    return {
      total,
      items: channels
        .filter((ch) => ch !== "SYSTEM" || counts.SYSTEM > 0)
        .map((ch) => ({
          channel: ch,
          count: counts[ch],
          pct: total > 0 ? Math.round((counts[ch] / total) * 100) : 0,
        })),
    };
  }, [overview]);

  const filteredCases = useMemo(() => {
    const list = overview?.cases ?? [];
    return list.filter((c) => {
      if (selectedStateFilter !== "ALL" && c.currentState !== selectedStateFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        c.patientMasked.toLowerCase().includes(q) ||
        c.journeyId.toLowerCase().includes(q) ||
        c.currentState.toLowerCase().includes(q) ||
        (c.contextSummary.study?.name || "").toLowerCase().includes(q) ||
        (c.contextSummary.clinic?.name || "").toLowerCase().includes(q)
      );
    });
  }, [overview, selectedStateFilter, searchQuery]);

  // Pantalla de autenticación administrativa editorial y minimalista
  if (!token) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] text-[#1F2933] flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-md space-y-8">
          <header className="pb-6 border-b border-[#E4E7EB] space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Acceso restringido · Back-Office
            </p>
            <h1 className="text-3xl font-bold text-[#1F2933]">
              Administración central Salud Digna
            </h1>
            <p className="text-sm text-[#52606D] leading-relaxed">
              Consola interna de estadísticas del servicio, monitoreo en vivo y consulta de
              expedientes con PII protegida.
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
                htmlFor="admin-email"
                className="block text-xs font-semibold text-[#1F2933] mb-1.5"
              >
                Correo institucional
              </label>
              <input
                id="admin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@saluddigna.demo"
                required
                className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
            </div>

            <div>
              <label
                htmlFor="admin-pass"
                className="block text-xs font-semibold text-[#1F2933] mb-1.5"
              >
                Contraseña
              </label>
              <input
                id="admin-pass"
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
              {loginLoading ? "Validando credenciales..." : "Ingresar al panel administrador"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const kpis = overview?.kpis;
  const conversionRate =
    kpis && kpis.totalCases > 0
      ? Math.round((kpis.confirmedAppointments / kpis.totalCases) * 100)
      : 0;

  return (
    <AdminLayout
      user={user}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      sseStatus={sseStatus}
      onLogout={handleLogout}
    >
      {/* ==================== PESTAÑA 1: ESTADÍSTICAS ==================== */}
      {activeTab === "overview" && (
        <div className="space-y-10">
          {/* Barra superior de salud y acciones */}
          <section className="pb-6 border-b border-[#E4E7EB] flex flex-wrap items-center justify-between gap-4">
            <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xs">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-[#52606D]">PostgreSQL 16:</dt>
                <dd
                  className={`font-semibold ${
                    health?.postgres === "connected" ? "text-[#00875A]" : "text-[#52606D]"
                  }`}
                >
                  {health?.postgres === "connected" ? "Conectado" : "Verificando"}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-[#52606D]">Redis / Valkey:</dt>
                <dd
                  className={`font-semibold ${
                    health?.redis === "connected" ? "text-[#00875A]" : "text-[#52606D]"
                  }`}
                >
                  {health?.redis === "connected" ? "Conectado" : "Verificando"}
                </dd>
              </div>
              {lastUpdated && (
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-[#52606D]">Actualizado:</dt>
                  <dd className="font-mono text-[#1F2933]">
                    <time dateTime={lastUpdated}>{formatTimeShort(lastUpdated)}</time>
                  </dd>
                </div>
              )}
            </dl>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={fetchOverview}
                disabled={loading}
                className="h-10 px-4 border border-[#E4E7EB] bg-[#FFFFFF] hover:border-[#1F2933] text-xs font-semibold text-[#1F2933] transition-colors"
              >
                {loading ? "Actualizando..." : "Actualizar"}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("user-lookup")}
                className="h-10 px-5 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-xs font-semibold transition-colors"
              >
                Consultar usuario
              </button>
            </div>
          </section>

          {error && (
            <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
          )}

          {/* 6 KPIs en retícula plana de 1px */}
          <section aria-label="Indicadores clave">
            <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 border-t border-l border-[#E4E7EB]">
              <KpiMetric
                title="Casos totales"
                value={kpis?.totalCases ?? 0}
                subtitle="Expedientes activos"
              />
              <KpiMetric
                title="Citas confirmadas"
                value={kpis?.confirmedAppointments ?? 0}
                subtitle={`${conversionRate}% conversión`}
                highlight
              />
              <KpiMetric
                title="Flujos recuperados"
                value={kpis?.recoveredAbandonedFlows ?? 0}
                subtitle="CONTEXT_REHYDRATED"
              />
              <KpiMetric
                title="OTP fallidos"
                value={kpis?.otpFailedAttemptsAudited ?? 0}
                subtitle="Auditados (2FA)"
              />
              <KpiMetric
                title="Eventos auditados"
                value={kpis?.totalEventsRecorded ?? 0}
                subtitle="journey_events"
              />
              <KpiMetric
                title="Clientes SSE"
                value={kpis?.activeSseSubscribers ?? 0}
                subtitle="Tiempo real"
              />
            </dl>
          </section>

          {/* Distribución por estado, canales y colas BullMQ en 3 columnas abiertas */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 pb-10 border-b border-[#E4E7EB]">
            <section className="lg:col-span-5 space-y-4">
              <div className="flex items-baseline justify-between gap-2 pb-3 border-b border-[#E4E7EB]">
                <div>
                  <h2 className="text-base font-bold text-[#1F2933]">
                    Distribución por estado canónico
                  </h2>
                  <p className="text-xs text-[#52606D]">
                    Selecciona un estado para filtrar la tabla de casos
                  </p>
                </div>
                {selectedStateFilter !== "ALL" && (
                  <button
                    type="button"
                    onClick={() => setSelectedStateFilter("ALL")}
                    className="text-xs font-semibold text-[#00875A] hover:underline"
                  >
                    Ver todos
                  </button>
                )}
              </div>

              <ul className="space-y-3">
                {stateDistribution.map((row) => {
                  const meta = STATE_META[row.state];
                  const isSelected = selectedStateFilter === row.state;
                  return (
                    <li key={row.state}>
                      <button
                        type="button"
                        onClick={() => setSelectedStateFilter(isSelected ? "ALL" : row.state)}
                        className={`w-full text-left py-1.5 pl-3 border-l-2 transition-colors ${
                          isSelected
                            ? "border-[#00875A] bg-[#F7F8F9]"
                            : "border-transparent hover:bg-[#F7F8F9]"
                        }`}
                      >
                        <div className="flex items-baseline justify-between text-xs mb-1.5 pr-2">
                          <strong
                            className={`font-semibold ${
                              isSelected ? "text-[#00875A]" : "text-[#1F2933]"
                            }`}
                          >
                            {meta.label}
                          </strong>
                          <small className="text-xs text-[#52606D]">
                            <strong className="text-[#1F2933]">{row.count}</strong> ({row.pct}%)
                          </small>
                        </div>
                        <div className="w-full h-1.5 bg-[#E4E7EB]">
                          <div
                            className="h-full"
                            style={{ width: `${row.widthPct}%`, backgroundColor: meta.barColor }}
                          />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="lg:col-span-4 lg:border-l lg:border-[#E4E7EB] lg:pl-8 space-y-4">
              <div className="pb-3 border-b border-[#E4E7EB]">
                <h2 className="text-base font-bold text-[#1F2933]">Actividad por canal</h2>
                <p className="text-xs text-[#52606D]">
                  Último canal activo sobre {channelDistribution.total} expedientes
                </p>
              </div>

              <ul className="divide-y divide-[#E4E7EB]">
                {channelDistribution.items.map((item) => (
                  <li key={item.channel} className="py-3 space-y-1.5">
                    <div className="flex items-baseline justify-between text-xs">
                      <strong className="font-semibold text-[#1F2933]">
                        {CHANNEL_META[item.channel].label}
                      </strong>
                      <small className="text-xs text-[#52606D]">
                        <strong className="text-[#1F2933]">{item.count}</strong> ({item.pct}%)
                      </small>
                    </div>
                    <div className="w-full h-1 bg-[#E4E7EB]">
                      <div
                        className="h-full"
                        style={{
                          width: `${item.pct}%`,
                          backgroundColor: CHANNEL_META[item.channel].color,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              <p className="pt-2 text-xs text-[#52606D]">
                Continuidad garantizada por <code className="font-mono text-[#1F2933]">journey_id</code>{" "}
                entre Sitio Web, WhatsApp y Call Center.
              </p>
            </section>

            <section className="lg:col-span-3 lg:border-l lg:border-[#E4E7EB] lg:pl-8 space-y-5">
              <div className="pb-3 border-b border-[#E4E7EB] flex items-baseline justify-between">
                <h2 className="text-base font-bold text-[#1F2933]">Colas BullMQ y DLQ</h2>
                <small className="text-xs font-semibold text-[#00875A]">Operativo</small>
              </div>

              <div className="space-y-4">
                <div>
                  <h3 className="text-xs font-mono font-bold text-[#1F2933] mb-2">
                    whatsapp-inbound
                  </h3>
                  <dl className="grid grid-cols-2 border-t border-l border-[#E4E7EB] text-xs">
                    <QueueMetric
                      label="En espera"
                      value={overview?.queues.whatsappInbound.waiting ?? 0}
                    />
                    <QueueMetric
                      label="Activos"
                      value={overview?.queues.whatsappInbound.active ?? 0}
                    />
                    <QueueMetric
                      label="Completados"
                      value={overview?.queues.whatsappInbound.completed ?? 0}
                      highlight
                    />
                    <QueueMetric
                      label="Fallidos"
                      value={overview?.queues.whatsappInbound.failed ?? 0}
                    />
                  </dl>
                </div>

                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-xs font-mono font-bold text-[#1F2933]">whatsapp-dlq</h3>
                    <small className="text-xs font-semibold text-[#00875A]">
                      {(overview?.queues.whatsappDlq.waiting ?? 0) === 0 ? "Limpia" : "Revisar"}
                    </small>
                  </div>
                  <dl className="grid grid-cols-2 border-t border-l border-[#E4E7EB] text-xs">
                    <QueueMetric
                      label="Retenidos"
                      value={overview?.queues.whatsappDlq.waiting ?? 0}
                    />
                    <QueueMetric
                      label="Fallos DLQ"
                      value={overview?.queues.whatsappDlq.failed ?? 0}
                    />
                  </dl>
                </div>
              </div>
            </section>
          </div>

          {/* Tabla de casos + Stream SSE */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
            <section className="xl:col-span-8 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-3 border-b border-[#E4E7EB]">
                <div>
                  <h2 className="text-base font-bold text-[#1F2933]">
                    Casos recientes (PII enmascarada)
                  </h2>
                  <p className="text-xs text-[#52606D]">
                    Mostrando {filteredCases.length} de {overview?.cases.length ?? 0} casos
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    placeholder="Filtrar estudio, clínica..."
                    aria-label="Filtrar casos"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-9 px-3 text-xs border border-[#E4E7EB] bg-[#FFFFFF] text-[#1F2933] focus:border-[#00875A] w-48"
                  />

                  <select
                    aria-label="Filtrar por estado"
                    value={selectedStateFilter}
                    onChange={(e) => setSelectedStateFilter(e.target.value as CaseState | "ALL")}
                    className="h-9 px-3 text-xs border border-[#E4E7EB] bg-[#FFFFFF] text-[#1F2933] focus:border-[#00875A]"
                  >
                    <option value="ALL">Todos los estados</option>
                    {CANONICAL_STATES.map((st) => (
                      <option key={st} value={st}>
                        {STATE_META[st].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F7F8F9] border-b border-[#E4E7EB] text-[11px] font-semibold uppercase tracking-wider text-[#52606D]">
                      <th className="py-3 px-3">Paciente (PII)</th>
                      <th className="py-3 px-3">Estudio / Clínica</th>
                      <th className="py-3 px-3">Estado</th>
                      <th className="py-3 px-3">Canal</th>
                      <th className="py-3 px-3 text-center">Ver / Evts</th>
                      <th className="py-3 px-3 text-right">Auditoría</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E4E7EB] text-sm">
                    {filteredCases.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-[#52606D] text-sm">
                          Sin casos registrados para el filtro seleccionado.
                        </td>
                      </tr>
                    ) : (
                      filteredCases.map((c) => {
                        const stMeta = STATE_META[c.currentState];
                        const chMeta = CHANNEL_META[c.currentChannel];
                        return (
                          <tr key={c.id} className="hover:bg-[#F7F8F9] transition-colors">
                            <td className="py-3.5 px-3 align-top">
                              <strong className="block font-semibold text-[#1F2933]">
                                {c.patientMasked}
                              </strong>
                              {c.isThirdParty && (
                                <small className="block text-[11px] text-[#52606D] mt-0.5">
                                  {c.relationshipLabel || "Familiar"}
                                  {c.requesterMasked ? ` · Titular: ${c.requesterMasked}` : ""}
                                </small>
                              )}
                              <ul className="mt-1 space-y-0.5">
                                {c.identities.slice(0, 3).map((idLink, idx) => (
                                  <li
                                    key={`${idLink.identifierType}-${idx}`}
                                    className="text-[11px] font-mono text-[#52606D]"
                                  >
                                    {idLink.identifierType}: {idLink.identifierMasked}
                                  </li>
                                ))}
                              </ul>
                            </td>

                            <td className="py-3.5 px-3 align-top">
                              <p className="font-medium text-[#1F2933]">
                                {c.contextSummary.study?.name || "Sin estudio"}
                              </p>
                              <p className="text-xs text-[#52606D] mt-0.5">
                                {c.contextSummary.clinic?.name || "Clínica pendiente"}
                                {c.contextSummary.study?.price
                                  ? ` · ${formatMoney(c.contextSummary.study.price)}`
                                  : ""}
                              </p>
                            </td>

                            <td className="py-3.5 px-3 align-top">
                              <strong className={`block text-xs font-semibold ${stMeta.textClass}`}>
                                {stMeta.label}
                              </strong>
                              <time
                                dateTime={c.updatedAt}
                                className="block text-[11px] text-[#52606D] mt-0.5"
                              >
                                {formatDateTime(c.updatedAt)}
                              </time>
                            </td>

                            <td className="py-3.5 px-3 align-top">
                              <p className={`text-xs font-semibold ${chMeta.textClass}`}>
                                {chMeta.label}
                              </p>
                            </td>

                            <td className="py-3.5 px-3 align-top text-center">
                              <code className="block text-xs font-mono font-semibold text-[#1F2933]">
                                v{c.version}
                              </code>
                              <small className="block text-[11px] text-[#52606D]">
                                {c.eventsCount} evts
                              </small>
                            </td>

                            <td className="py-3.5 px-3 align-top text-right">
                              <button
                                type="button"
                                onClick={() => openTimeline(c)}
                                className="text-xs font-semibold text-[#00875A] hover:underline"
                              >
                                Auditar →
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Stream SSE */}
            <aside className="xl:col-span-4 xl:border-l xl:border-[#E4E7EB] xl:pl-8 flex flex-col max-h-[560px]">
              <div className="pb-3 border-b border-[#E4E7EB] flex items-baseline justify-between">
                <div>
                  <h2 className="text-base font-bold text-[#1F2933]">Eventos en tiempo real</h2>
                  <p className="text-xs text-[#52606D]">Stream SSE · Redis Pub/Sub</p>
                </div>
                <strong className="text-xs font-mono text-[#00875A]">{liveEvents.length}</strong>
              </div>

              <div className="flex-1 overflow-y-auto">
                {liveEvents.length === 0 ? (
                  <p className="py-12 text-xs text-[#52606D]">
                    Escuchando eventos del servicio...
                  </p>
                ) : (
                  <ol className="divide-y divide-[#E4E7EB]">
                    {liveEvents.map((ev) => {
                      const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                        label: ev.eventType,
                        tone: "text-[#1F2933]",
                      };
                      return (
                        <li key={ev.id} className="py-3 space-y-1 text-xs">
                          <div className="flex items-baseline justify-between gap-2">
                            <strong className={`font-semibold ${evMeta.tone}`}>
                              {evMeta.label}
                            </strong>
                            <time
                              dateTime={ev.timestamp}
                              className="text-[11px] font-mono text-[#52606D]"
                            >
                              {formatTimeShort(ev.timestamp)}
                            </time>
                          </div>
                          {(ev.prevState || ev.nextState) && (
                            <p className="text-[11px] text-[#52606D]">
                              {ev.prevState ?? "NUEVO"} →{" "}
                              <strong className="text-[#1F2933]">{ev.nextState}</strong>
                            </p>
                          )}
                          <p className="text-[11px] font-mono text-[#52606D]">
                            Canal: {ev.channel ?? "SYSTEM"}
                            {ev.correlationId ? ` · cid: ${ev.correlationId.slice(0, 8)}` : ""}
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* ==================== PESTAÑA 2: CONSULTAR ESTADO DE UN USUARIO ==================== */}
      {activeTab === "user-lookup" && (
        <div className="space-y-8">
          <section className="pb-8 border-b border-[#E4E7EB] space-y-4">
            <div>
              <h2 className="text-xl font-bold text-[#1F2933]">Consultar estado de un usuario</h2>
              <p className="text-sm text-[#52606D] mt-1">
                Busca por <strong>teléfono</strong>, <strong>CURP</strong>,{" "}
                <strong>correo electrónico</strong>, <strong>nombre</strong> o{" "}
                <strong>journey_id</strong> para inspeccionar su trazabilidad completa (PII
                enmascarada).
              </p>
            </div>

            <form onSubmit={handleUserLookup} className="flex flex-col sm:flex-row gap-3 max-w-3xl">
              <input
                type="search"
                value={lookupQuery}
                onChange={(e) => setLookupQuery(e.target.value)}
                aria-label="Buscar usuario"
                placeholder="Ej: +526670000001, MORA950412MSLRRN01, correo@dominio.com o journey_id..."
                className="flex-1 h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
              <button
                type="submit"
                disabled={lookupLoading || !lookupQuery.trim()}
                className="h-11 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50 shrink-0"
              >
                {lookupLoading ? "Buscando..." : "Consultar estado"}
              </button>
            </form>

            {lookupError && (
              <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">
                {lookupError}
              </p>
            )}
          </section>

          {lookupResults !== null && lookupResults.length === 0 && (
            <p className="py-10 text-sm text-[#52606D]">
              No se encontraron usuarios coincidentes con{" "}
              <strong className="text-[#1F2933]">"{lookupQuery}"</strong>.
            </p>
          )}

          {editUserFeedback && (
            <p className="border-l-2 border-[#00875A] pl-4 py-1 text-sm text-[#00875A]">
              {editUserFeedback}
            </p>
          )}

          {lookupResults && lookupResults.length > 0 && (
            <ul className="divide-y divide-[#E4E7EB]">
              {lookupResults.map((item) => {
                const isEditingThisUser = editingUserId === item.patientId;
                return (
                <li key={item.patientId} className="py-8 space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-bold text-[#1F2933]">{item.patientMasked}</h3>
                      <p className="text-xs font-mono text-[#52606D] mt-1">
                        patient_id: {item.patientId}
                        {item.birthState ? ` · ${item.birthState}` : ""} ·{" "}
                        {item.hasAccount ? "Cuenta registrada" : "Sin contraseña web"}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          isEditingThisUser ? setEditingUserId(null) : startEditingUser(item)
                        }
                        className="mt-2 px-3 py-1 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                      >
                        {isEditingThisUser ? "Cancelar edición de cuenta" : "Editar cuenta"}
                      </button>
                    </div>

                    <ul className="text-xs font-mono text-[#52606D] space-y-1">
                      {item.identities.map((idLink, idx) => (
                        <li key={`${idLink.identifierType}-${idx}`}>
                          {idLink.identifierType}: {idLink.identifierMasked}{" "}
                          <strong className={idLink.verified ? "text-[#00875A]" : "text-[#52606D]"}>
                            ({idLink.verified ? "verificado" : "pendiente"})
                          </strong>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {isEditingThisUser && (
                    <form
                      onSubmit={handleSaveAdminUserEdit}
                      className="bg-[#F7F8F9] border border-[#E4E7EB] p-5 space-y-4"
                    >
                      <div>
                        <h4 className="text-sm font-bold text-[#1F2933]">
                          Editar cuenta del paciente (normalización automática sin acentos)
                        </h4>
                        <p className="text-xs text-[#52606D] mt-0.5">
                          Nombres/apellidos y CURP se normalizan en mayúsculas sin acentos; correo
                          en minúsculas para mantener la vinculación omnicanal.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Nombre(s)
                          </label>
                          <input
                            type="text"
                            value={uFirstName}
                            onChange={(e) => setUFirstName(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Apellido paterno
                          </label>
                          <input
                            type="text"
                            value={uPaternal}
                            onChange={(e) => setUPaternal(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Apellido materno
                          </label>
                          <input
                            type="text"
                            value={uMaternal}
                            onChange={(e) => setUMaternal(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Correo electrónico
                          </label>
                          <input
                            type="email"
                            value={uEmail}
                            onChange={(e) => setUEmail(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Teléfono
                          </label>
                          <input
                            type="tel"
                            value={uPhone}
                            onChange={(e) => setUPhone(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            CURP (18 caracteres)
                          </label>
                          <input
                            type="text"
                            maxLength={18}
                            value={uCurp}
                            onChange={(e) => setUCurp(e.target.value.toUpperCase())}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs font-mono text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Fecha nacimiento
                          </label>
                          <input
                            type="date"
                            value={uBirthDate}
                            onChange={(e) => setUBirthDate(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Género
                          </label>
                          <select
                            value={uGender}
                            onChange={(e) =>
                              setUGender(e.target.value as "" | "FEMENINO" | "MASCULINO")
                            }
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          >
                            <option value="">Sin especificar</option>
                            <option value="FEMENINO">Mujer</option>
                            <option value="MASCULINO">Hombre</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Estado nacimiento
                          </label>
                          <input
                            type="text"
                            value={uBirthState}
                            onChange={(e) => setUBirthState(e.target.value)}
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                            Nueva contraseña (opcional)
                          </label>
                          <input
                            type="password"
                            value={uNewPassword}
                            onChange={(e) => setUNewPassword(e.target.value)}
                            placeholder="Mín. 6 caracteres"
                            className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                      </div>

                      <div className="flex justify-end gap-3 pt-2">
                        <button
                          type="button"
                          onClick={() => setEditingUserId(null)}
                          className="h-9 px-4 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933]"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={editUserSaving}
                          className="h-9 px-5 bg-[#00875A] hover:bg-[#006B47] text-[#FFFFFF] text-xs font-semibold transition-colors disabled:opacity-50"
                        >
                          {editUserSaving ? "Guardando..." : "Guardar cambios de cuenta"}
                        </button>
                      </div>
                    </form>
                  )}

                  {item.cases.length === 0 ? (
                    <p className="text-sm text-[#52606D]">
                      Usuario registrado sin expedientes activos todavía.
                    </p>
                  ) : (
                    <div className="space-y-6">
                      {item.cases.map((sc) => (
                        <article key={sc.id} className="space-y-4">
                          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                            <h4 className="font-bold text-sm text-[#1F2933]">
                              {sc.contextSummary.study?.name || "Estudio por definir"}
                              {sc.contextSummary.clinic?.name
                                ? ` · ${sc.contextSummary.clinic.name}`
                                : ""}
                              {sc.contextSummary.appointment_folio
                                ? ` · Folio ${sc.contextSummary.appointment_folio}`
                                : ""}
                            </h4>
                            <div className="flex items-center gap-3">
                              <code className="font-mono text-[#52606D]">
                                journey_id: {sc.journeyId} · v{sc.version}
                              </code>
                              <button
                                type="button"
                                onClick={() => {
                                  const match = overview?.cases.find((x) => x.id === sc.id);
                                  openTimeline(
                                    match || {
                                      id: sc.id,
                                      patientId: item.patientId,
                                      journeyId: sc.journeyId,
                                      patientMasked: item.patientMasked,
                                      identities: item.identities,
                                      currentState: sc.currentState,
                                      currentChannel: sc.currentChannel,
                                      version: sc.version,
                                      eventsCount: sc.events.length,
                                      contextSummary: sc.contextSummary,
                                      updatedAt: sc.updatedAt,
                                    },
                                    true
                                  );
                                }}
                                className="text-xs font-semibold text-[#00875A] hover:underline"
                              >
                                Editar cita →
                              </button>
                            </div>
                          </div>

                          <OrderJourneyTracker
                            currentState={sc.currentState}
                            currentChannel={sc.currentChannel}
                            events={sc.events}
                            isThirdParty={sc.isThirdParty}
                            beneficiaryLabel={sc.beneficiaryMasked}
                            relationshipLabel={sc.relationshipLabel}
                            showAuditDetails
                            defaultExpanded
                          />

                          {sc.contextSummary.handoff_summary && (
                            <p className="border-l-2 border-[#00875A] pl-4 text-xs text-[#1F2933] leading-relaxed">
                              <strong className="text-[#00875A]">Resumen handoff:</strong>{" "}
                              {sc.contextSummary.handoff_summary}
                            </p>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ==================== PESTAÑA 3: ARQUITECTURA Y BUS ==================== */}
      {activeTab === "architecture" && (
        <BusArchitectureView
          overview={overview}
          latestEvent={liveEvents[0] ?? null}
          sseConnected={sseStatus === "connected"}
        />
      )}

      {/* Panel lateral plano de auditoría inmutable */}
      {inspectCase && (
        <div className="fixed inset-0 z-50 bg-[#1F2933]/40 flex justify-end">
          <div className="w-full max-w-2xl bg-[#FFFFFF] h-full border-l border-[#E4E7EB] flex flex-col">
            <header className="px-6 py-5 border-b border-[#E4E7EB] bg-[#F7F8F9] flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                  Auditoría inmutable · journey_events
                </p>
                <h3 className="text-lg font-bold text-[#1F2933] mt-0.5">
                  {inspectCase.patientMasked}
                </h3>
                <code className="block text-xs font-mono text-[#52606D] mt-0.5">
                  journey_id: {inspectCase.journeyId}
                </code>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (!editingCase) populateCaseEditor(inspectCase);
                    setEditingCase((v) => !v);
                  }}
                  className="px-3 py-1.5 border border-[#00875A] bg-[#FFFFFF] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                >
                  {editingCase ? "Cancelar edición" : "Editar cita"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingCase(false);
                    setInspectCase(null);
                  }}
                  className="px-3 py-1.5 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933] hover:border-[#1F2933]"
                >
                  Cerrar
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {editCaseFeedback && (
                <p className="border-l-2 border-[#00875A] pl-4 py-1 text-xs text-[#00875A]">
                  {editCaseFeedback}
                </p>
              )}

              {editingCase && (
                <form
                  onSubmit={handleSaveAdminCaseEdit}
                  className="bg-[#F7F8F9] border border-[#E4E7EB] p-4 space-y-4"
                >
                  <h4 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                    Edición administrativa de la cita (v{inspectCase.version})
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Estudio
                      </label>
                      <select
                        value={editStudyCode}
                        onChange={(e) => setEditStudyCode(e.target.value)}
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      >
                        {studies.map((st) => (
                          <option key={st.code} value={st.code}>
                            {st.name} ({formatMoney(st.price)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Clínica
                      </label>
                      <select
                        value={editClinicId}
                        onChange={(e) => setEditClinicId(e.target.value)}
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      >
                        {clinics.map((cl) => (
                          <option key={cl.id} value={cl.id}>
                            {cl.name} · {cl.city}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Fecha
                      </label>
                      <input
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Horario
                      </label>
                      <select
                        value={editTime}
                        onChange={(e) => setEditTime(e.target.value)}
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      >
                        {TIME_SLOTS.map((slot) => (
                          <option key={slot} value={slot}>
                            {slot} hrs
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Forma de pago
                      </label>
                      <select
                        value={editPayment}
                        onChange={(e) =>
                          setEditPayment(e.target.value as "online" | "oxxo" | "clinic")
                        }
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      >
                        <option value="online">Pago en línea (-10%)</option>
                        <option value="oxxo">OXXO Pay</option>
                        <option value="clinic">En clínica</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Estado canónico
                      </label>
                      <select
                        value={editState}
                        onChange={(e) => setEditState(e.target.value as CaseState)}
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      >
                        {CANONICAL_STATES.map((st) => (
                          <option key={st} value={st}>
                            {STATE_META[st].label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#1F2933] mb-1">
                        Notas administrativas
                      </label>
                      <input
                        type="text"
                        value={editAdminNotes}
                        onChange={(e) => setEditAdminNotes(e.target.value)}
                        placeholder="Motivo del ajuste..."
                        className="w-full h-9 border border-[#E4E7EB] bg-[#FFFFFF] px-2.5 text-xs text-[#1F2933] focus:border-[#00875A]"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-[#1F2933] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editCancelled}
                      onChange={(e) => setEditCancelled(e.target.checked)}
                      className="w-4 h-4 accent-[#00875A]"
                    />
                    Marcar trámite como anulado (se oculta de trámites pendientes del bot)
                  </label>

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setEditingCase(false)}
                      className="h-9 px-3.5 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933]"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={editCaseSaving}
                      className="h-9 px-4 bg-[#00875A] hover:bg-[#006B47] text-[#FFFFFF] text-xs font-semibold transition-colors disabled:opacity-50"
                    >
                      {editCaseSaving ? "Guardando..." : "Guardar cambios"}
                    </button>
                  </div>
                </form>
              )}
              <OrderJourneyTracker
                currentState={inspectCase.currentState}
                currentChannel={inspectCase.currentChannel}
                events={timelineEvents}
                isThirdParty={inspectCase.isThirdParty}
                beneficiaryLabel={inspectCase.patientMasked}
                relationshipLabel={inspectCase.relationshipLabel}
                showAuditDetails
                defaultExpanded
              />

              {inspectCase.contextSummary.handoff_summary && (
                <section className="border-l-2 border-[#00875A] pl-4 space-y-1">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                    Resumen determinístico de contexto (Handoff)
                  </h4>
                  <p className="text-sm text-[#1F2933] leading-relaxed">
                    {inspectCase.contextSummary.handoff_summary}
                  </p>
                </section>
              )}

              {timelineLoading ? (
                <p className="py-10 text-sm text-[#52606D]">
                  Cargando línea de tiempo correlacionada...
                </p>
              ) : (
                <ol className="divide-y divide-[#E4E7EB] border-t border-[#E4E7EB]">
                  {timelineEvents.map((ev) => {
                    const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                      label: ev.eventType,
                      tone: "text-[#1F2933]",
                    };
                    return (
                      <li key={ev.id} className="py-4 space-y-2 text-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <strong className={`font-semibold ${evMeta.tone}`}>{evMeta.label}</strong>
                          <time
                            dateTime={ev.createdAt}
                            className="font-mono text-[#52606D]"
                          >
                            {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                          </time>
                        </div>
                        <p className="text-[#52606D]">
                          Canal: <strong className="text-[#1F2933]">{ev.channel}</strong> · Actor:{" "}
                          <strong className="text-[#1F2933]">{ev.actorRole}</strong>
                          {ev.nextState ? ` · ${ev.prevState ?? "—"} → ${ev.nextState}` : ""}
                        </p>
                        <code className="block text-[11px] font-mono text-[#52606D]">
                          correlation_id: {ev.correlationId}
                        </code>
                        {ev.payloadJson && Object.keys(ev.payloadJson).length > 0 && (
                          <pre className="text-[11px] bg-[#F7F8F9] border border-[#E4E7EB] p-3 overflow-x-auto text-[#1F2933]">
                            {JSON.stringify(ev.payloadJson, null, 2)}
                          </pre>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
};

interface KpiMetricProps {
  title: string;
  value: number;
  subtitle: string;
  highlight?: boolean;
}

const KpiMetric: React.FC<KpiMetricProps> = ({ title, value, subtitle, highlight }) => (
  <div className="p-4 border-r border-b border-[#E4E7EB] bg-[#FFFFFF]">
    <dt className="text-xs font-medium text-[#52606D]">{title}</dt>
    <dd
      className={`text-2xl font-bold mt-1 ${highlight ? "text-[#00875A]" : "text-[#1F2933]"}`}
    >
      {value}
    </dd>
    <dd className="text-[11px] text-[#52606D] mt-1 truncate">{subtitle}</dd>
  </div>
);

const QueueMetric: React.FC<{ label: string; value: number; highlight?: boolean }> = ({
  label,
  value,
  highlight,
}) => (
  <div className="p-2.5 border-r border-b border-[#E4E7EB]">
    <dt className="text-[11px] text-[#52606D]">{label}</dt>
    <dd className={`text-base font-bold mt-0.5 ${highlight ? "text-[#00875A]" : "text-[#1F2933]"}`}>
      {value}
    </dd>
  </div>
);
