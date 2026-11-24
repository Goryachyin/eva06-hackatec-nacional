import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Eye,
  Filter,
  Layers,
  Lock,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from "lucide-react";
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
  HealthResponse,
  JourneyEventItem,
  StaffUser,
} from "../types/api";

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

  // Login de producción (sin botones de autocompletado demo)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Datos de estadísticas
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // SSE en tiempo real
  const [sseStatus, setSseStatus] = useState<"disconnected" | "connected" | "reconnecting">(
    "disconnected"
  );
  const [liveEvents, setLiveEvents] = useState<LiveSseEvent[]>([]);

  // Filtros tabla
  const [selectedStateFilter, setSelectedStateFilter] = useState<CaseState | "ALL">("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Drawer de Timeline
  const [inspectCase, setInspectCase] = useState<AdminSanitizedCase | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<JourneyEventItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // Pestaña 2: Consulta directa de estado de usuario
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupResults, setLookupResults] = useState<AdminUserLookupItem[] | null>(null);

  const refreshTimerRef = useRef<number | null>(null);

  const fetchOverview = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [ov, hl] = await Promise.all([
        api.getAdminOverview(token),
        api.getHealth().catch(() => null),
      ]);
      setOverview(ov);
      if (hl) setHealth(hl);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStaffSession("ADMIN");
        setToken(null);
        setUser(null);
        setLoginError("Tu sesión expiró o no tiene permisos ADMIN.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudieron cargar las métricas.");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchOverview();
  }, [token, fetchOverview]);

  // Suscripción SSE en tiempo real
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
        }, 350);
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

  const openTimeline = async (c: AdminSanitizedCase) => {
    if (!token) return;
    setInspectCase(c);
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
      widthPct: counts[st] > 0 ? Math.max(8, Math.round((counts[st] / maxCount) * 100)) : 0,
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

  // Pantalla aislada de autenticación del Back-Office Administrador
  if (!token) {
    return (
      <div className="min-h-screen bg-[#0B1F16] flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden border border-emerald-950/20">
          <div className="bg-gradient-to-r from-[#005A2B] to-[#00843D] px-6 py-7 text-white">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider bg-white/15 px-2.5 py-1 rounded-full mb-3">
              <Lock className="w-3.5 h-3.5" />
              Acceso Restringido · Back-Office
            </div>
            <h1 className="text-xl font-extrabold">Administración Central Salud Digna</h1>
            <p className="text-emerald-100 text-xs mt-1 leading-relaxed">
              Consola interna de estadísticas del servicio, monitoreo en vivo y consulta de
              expedientes con PII protegida.
            </p>
          </div>

          <form onSubmit={handleLogin} className="p-6 space-y-4">
            {loginError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{loginError}</span>
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
                placeholder="admin@saluddigna.demo"
                required
                className="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 focus:border-[#00843D]"
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
                className="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 focus:border-[#00843D]"
              />
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full h-11 bg-[#00843D] hover:bg-[#006E32] text-white font-bold rounded-lg text-sm transition shadow-sm disabled:opacity-60"
            >
              {loginLoading ? "Validando credenciales..." : "Ingresar al Panel Administrador"}
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

  const donutRadius = 42;
  const donutCircumference = 2 * Math.PI * donutRadius;
  let cumulativeOffset = 0;

  return (
    <AdminLayout
      user={user}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      sseStatus={sseStatus}
      onLogout={handleLogout}
    >
      {/* ==================== PESTAÑA 1: ESTADÍSTICAS DEL SERVICIO ==================== */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Barra superior de salud y actualización */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="inline-flex items-center gap-1.5 text-slate-600">
                <Database className="w-4 h-4 text-[#0066B3]" />
                PostgreSQL 16:
                <strong
                  className={
                    health?.postgres === "connected" ? "text-[#00843D]" : "text-amber-600"
                  }
                >
                  {health?.postgres === "connected" ? "Conectado" : "Verificando"}
                </strong>
              </div>
              <div className="inline-flex items-center gap-1.5 text-slate-600">
                <Server className="w-4 h-4 text-[#0066B3]" />
                Redis / Valkey:
                <strong
                  className={health?.redis === "connected" ? "text-[#00843D]" : "text-amber-600"}
                >
                  {health?.redis === "connected" ? "Conectado" : "Verificando"}
                </strong>
              </div>
              {lastUpdated && (
                <span className="text-slate-400">
                  Última actualización: {formatTimeShort(lastUpdated)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("user-lookup")}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#EBF4FC] hover:bg-[#daeafa] text-[#0066B3] text-xs font-bold transition"
              >
                <Search className="w-3.5 h-3.5" />
                Consultar usuario
              </button>
              <button
                type="button"
                onClick={fetchOverview}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </button>
            </div>
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 6 KPIs Ejecutivos */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <KpiCard
              title="Casos Totales"
              value={kpis?.totalCases ?? 0}
              subtitle="Expedientes activos"
              icon={<Users className="w-5 h-5 text-[#0066B3]" />}
              accentBg="bg-[#EBF4FC]"
            />
            <KpiCard
              title="Citas Confirmadas"
              value={kpis?.confirmedAppointments ?? 0}
              subtitle={`${conversionRate}% conversión`}
              icon={<CheckCircle2 className="w-5 h-5 text-[#00843D]" />}
              accentBg="bg-[#E6F4EC]"
            />
            <KpiCard
              title="Flujos Recuperados"
              value={kpis?.recoveredAbandonedFlows ?? 0}
              subtitle="CONTEXT_REHYDRATED"
              icon={<RefreshCw className="w-5 h-5 text-teal-700" />}
              accentBg="bg-teal-50"
            />
            <KpiCard
              title="OTP Fallidos"
              value={kpis?.otpFailedAttemptsAudited ?? 0}
              subtitle="Auditados (2FA)"
              icon={<ShieldAlert className="w-5 h-5 text-rose-600" />}
              accentBg="bg-rose-50"
            />
            <KpiCard
              title="Eventos Auditados"
              value={kpis?.totalEventsRecorded ?? 0}
              subtitle="journey_events"
              icon={<Layers className="w-5 h-5 text-indigo-600" />}
              accentBg="bg-indigo-50"
            />
            <KpiCard
              title="Clientes SSE"
              value={kpis?.activeSseSubscribers ?? 0}
              subtitle="Tiempo real"
              icon={<Radio className="w-5 h-5 text-violet-600" />}
              accentBg="bg-violet-50"
            />
          </div>

          {/* Gráficas: Estados Canónicos + Canales + BullMQ/DLQ */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Distribución por Estado Canónico
                  </h2>
                  <p className="text-xs text-slate-500">
                    Haz clic en cualquier estado para filtrar la tabla
                  </p>
                </div>
                {selectedStateFilter !== "ALL" && (
                  <button
                    type="button"
                    onClick={() => setSelectedStateFilter("ALL")}
                    className="text-xs font-semibold text-[#0066B3] hover:underline"
                  >
                    Ver todos
                  </button>
                )}
              </div>

              <div className="space-y-2.5">
                {stateDistribution.map((row) => {
                  const meta = STATE_META[row.state];
                  const isSelected = selectedStateFilter === row.state;
                  return (
                    <button
                      key={row.state}
                      type="button"
                      onClick={() => setSelectedStateFilter(isSelected ? "ALL" : row.state)}
                      className={`w-full text-left p-1.5 -mx-1.5 rounded-lg transition ${
                        isSelected
                          ? "bg-[#E6F4EC] ring-1 ring-[#00843D]/40"
                          : "hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${meta.dotColor}`} />
                          {meta.label}
                        </span>
                        <span className="font-bold text-slate-800">
                          {row.count}{" "}
                          <span className="font-normal text-slate-400">({row.pct}%)</span>
                        </span>
                      </div>
                      <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${row.widthPct}%`, backgroundColor: meta.barColor }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">Actividad por Canal</h2>
                <p className="text-xs text-slate-500">Último canal activo por expediente</p>
              </div>

              <div className="my-4 flex items-center justify-center gap-6">
                <div className="relative w-32 h-32 shrink-0">
                  <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                    <circle
                      cx="60"
                      cy="60"
                      r={donutRadius}
                      fill="none"
                      stroke="#E2E8F0"
                      strokeWidth="14"
                    />
                    {channelDistribution.total > 0 &&
                      channelDistribution.items.map((item) => {
                        if (item.count === 0) return null;
                        const fraction = item.count / channelDistribution.total;
                        const dash = fraction * donutCircumference;
                        const offset = cumulativeOffset;
                        cumulativeOffset += dash;
                        return (
                          <circle
                            key={item.channel}
                            cx="60"
                            cy="60"
                            r={donutRadius}
                            fill="none"
                            stroke={CHANNEL_META[item.channel].color}
                            strokeWidth="14"
                            strokeDasharray={`${dash} ${donutCircumference - dash}`}
                            strokeDashoffset={-offset}
                            strokeLinecap="butt"
                          />
                        );
                      })}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-extrabold text-slate-900">
                      {channelDistribution.total}
                    </span>
                    <span className="text-[10px] font-semibold uppercase text-slate-400">
                      Casos
                    </span>
                  </div>
                </div>

                <div className="space-y-2.5 flex-1">
                  {channelDistribution.items.map((item) => (
                    <div key={item.channel} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: CHANNEL_META[item.channel].color }}
                        />
                        <span className="font-medium text-slate-700">
                          {CHANNEL_META[item.channel].label}
                        </span>
                      </div>
                      <span className="font-bold text-slate-900">
                        {item.count}{" "}
                        <span className="text-slate-400 font-normal">({item.pct}%)</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                Continuidad garantizada por <code className="font-mono">journey_id</code> entre
                Sitio Web, WhatsApp y Call Center.
              </div>
            </div>

            <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-base font-bold text-slate-900">Colas BullMQ & DLQ</h2>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700">
                    <Activity className="w-3 h-3" />
                    Operativo
                  </span>
                </div>
                <p className="text-xs text-slate-500">Procesamiento asíncrono resiliente</p>
              </div>

              <div className="space-y-3 my-4">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80">
                  <div className="text-xs font-bold text-slate-700 mb-2">whatsapp-inbound</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <QueueMetric
                      label="En espera"
                      value={overview?.queues.whatsappInbound.waiting ?? 0}
                      tone="text-sky-700"
                    />
                    <QueueMetric
                      label="Activos"
                      value={overview?.queues.whatsappInbound.active ?? 0}
                      tone="text-indigo-700"
                    />
                    <QueueMetric
                      label="Completados"
                      value={overview?.queues.whatsappInbound.completed ?? 0}
                      tone="text-[#00843D]"
                    />
                    <QueueMetric
                      label="Fallidos"
                      value={overview?.queues.whatsappInbound.failed ?? 0}
                      tone={
                        (overview?.queues.whatsappInbound.failed ?? 0) > 0
                          ? "text-rose-600"
                          : "text-slate-600"
                      }
                    />
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80">
                  <div className="text-xs font-bold text-slate-700 mb-2 flex items-center justify-between">
                    <span>whatsapp-dlq</span>
                    <span className="text-[10px] font-semibold text-emerald-700">
                      {(overview?.queues.whatsappDlq.waiting ?? 0) === 0 ? "Limpia" : "Revisar"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <QueueMetric
                      label="Retenidos"
                      value={overview?.queues.whatsappDlq.waiting ?? 0}
                      tone={
                        (overview?.queues.whatsappDlq.waiting ?? 0) > 0
                          ? "text-amber-700"
                          : "text-[#00843D]"
                      }
                    />
                    <QueueMetric
                      label="Fallos DLQ"
                      value={overview?.queues.whatsappDlq.failed ?? 0}
                      tone="text-slate-600"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Tabla de Casos Activos + Stream SSE */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            <div className="xl:col-span-8 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Casos Recientes (PII Enmascarada)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Mostrando {filteredCases.length} de {overview?.cases.length ?? 0} casos
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Filtrar estudio, clínica..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 w-48"
                    />
                  </div>

                  <div className="relative flex items-center">
                    <Filter className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
                    <select
                      value={selectedStateFilter}
                      onChange={(e) => setSelectedStateFilter(e.target.value as CaseState | "ALL")}
                      className="pl-8 pr-7 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#00843D]/30"
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
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      <th className="py-3 px-4">Paciente (PII)</th>
                      <th className="py-3 px-4">Estudio / Clínica</th>
                      <th className="py-3 px-4">Estado</th>
                      <th className="py-3 px-4">Canal</th>
                      <th className="py-3 px-4 text-center">Ver / Evts</th>
                      <th className="py-3 px-4 text-right">Timeline</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredCases.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-slate-400 text-sm">
                          Sin casos registrados para el filtro seleccionado.
                        </td>
                      </tr>
                    ) : (
                      filteredCases.map((c) => {
                        const stMeta = STATE_META[c.currentState];
                        const chMeta = CHANNEL_META[c.currentChannel];
                        return (
                          <tr key={c.id} className="hover:bg-slate-50/80 transition">
                            <td className="py-3.5 px-4 align-top">
                              <div className="font-semibold text-slate-900 flex flex-wrap items-center gap-1.5">
                                <span>{c.patientMasked}</span>
                                {c.isThirdParty && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-bold">
                                    {c.relationshipLabel || "Familiar"}
                                  </span>
                                )}
                              </div>
                              {c.isThirdParty && c.requesterMasked && (
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  Gestionado por: {c.requesterMasked}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-1 mt-1">
                                {c.identities.slice(0, 3).map((idLink, idx) => (
                                  <span
                                    key={`${idLink.identifierType}-${idx}`}
                                    className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-mono text-slate-600"
                                  >
                                    {idLink.identifierType}: {idLink.identifierMasked}
                                  </span>
                                ))}
                              </div>
                            </td>

                            <td className="py-3.5 px-4 align-top">
                              <div className="font-medium text-slate-800">
                                {c.contextSummary.study?.name || (
                                  <span className="text-slate-400 italic">Sin estudio</span>
                                )}
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                {c.contextSummary.clinic?.name || "Clínica pendiente"}
                                {c.contextSummary.study?.price ? (
                                  <span className="ml-1.5 font-semibold text-[#00843D]">
                                    {formatMoney(c.contextSummary.study.price)}
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            <td className="py-3.5 px-4 align-top">
                              <span
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${stMeta.badgeClass}`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${stMeta.dotColor}`} />
                                {stMeta.label}
                              </span>
                              <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDateTime(c.updatedAt)}
                              </div>
                            </td>

                            <td className="py-3.5 px-4 align-top">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${chMeta.badgeClass}`}
                              >
                                {chMeta.label}
                              </span>
                            </td>

                            <td className="py-3.5 px-4 align-top text-center">
                              <div className="inline-flex flex-col items-center gap-1">
                                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-xs font-semibold">
                                  v{c.version}
                                </span>
                                <span className="text-[11px] text-slate-500">
                                  {c.eventsCount} evts
                                </span>
                              </div>
                            </td>

                            <td className="py-3.5 px-4 align-top text-right">
                              <button
                                type="button"
                                onClick={() => openTimeline(c)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EBF4FC] hover:bg-[#d8ebfa] text-[#0066B3] text-xs font-semibold transition"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                Auditar
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="xl:col-span-4 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col max-h-[560px]">
              <div className="p-4 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Radio className="w-4 h-4 text-[#00843D]" />
                    Eventos en Tiempo Real
                  </h2>
                  <p className="text-[11px] text-slate-500">Stream SSE · Redis Pub/Sub</p>
                </div>
                <span className="text-[11px] font-mono bg-white px-2 py-0.5 rounded border border-slate-200 text-slate-600">
                  {liveEvents.length}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                {liveEvents.length === 0 ? (
                  <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center px-4 text-slate-400">
                    <Activity className="w-8 h-8 mb-2 text-slate-300" />
                    <p className="text-xs font-medium text-slate-500">
                      Escuchando eventos del servicio...
                    </p>
                  </div>
                ) : (
                  liveEvents.map((ev) => {
                    const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                      label: ev.eventType,
                      tone: "text-slate-700 bg-slate-100",
                    };
                    return (
                      <div
                        key={ev.id}
                        className="p-3 rounded-xl border border-slate-200/80 bg-white text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`px-2 py-0.5 rounded font-semibold ${evMeta.tone}`}>
                            {evMeta.label}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            {formatTimeShort(ev.timestamp)}
                          </span>
                        </div>
                        {(ev.prevState || ev.nextState) && (
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-600 font-medium">
                            <span>{ev.prevState ?? "NUEVO"}</span>
                            <ArrowRight className="w-3 h-3 text-slate-400" />
                            <span className="font-bold text-slate-900">{ev.nextState}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-[10px] text-slate-400">
                          <span>Canal: {ev.channel ?? "SYSTEM"}</span>
                          {ev.correlationId && (
                            <span className="font-mono">cid: {ev.correlationId.slice(0, 8)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== PESTAÑA 2: CONSULTAR ESTADO DE UN USUARIO ==================== */}
      {activeTab === "user-lookup" && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
            <div>
              <h2 className="text-xl font-extrabold text-slate-900">
                Consultar estado de un usuario
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">
                Busca por <strong>teléfono</strong>, <strong>CURP</strong>,{" "}
                <strong>correo electrónico</strong>, <strong>nombre</strong> o{" "}
                <strong>journey_id</strong> para inspeccionar su estado actual, canal y trazabilidad
                completa (PII enmascarada).
              </p>
            </div>

            <form onSubmit={handleUserLookup} className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  placeholder="Ej: +526670000001, MORA950412MSLRRN01, correo@dominio.com o journey_id..."
                  className="w-full h-12 rounded-xl border border-slate-300 pl-10 pr-4 text-sm focus:outline-none focus:border-[#00843D] focus:ring-2 focus:ring-[#00843D]/20"
                />
              </div>
              <button
                type="submit"
                disabled={lookupLoading || !lookupQuery.trim()}
                className="h-12 px-6 rounded-xl bg-[#00843D] hover:bg-[#006E32] text-white font-bold text-sm transition shadow-sm disabled:opacity-50 shrink-0"
              >
                {lookupLoading ? "Buscando..." : "Consultar estado"}
              </button>
            </form>

            {lookupError && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm">
                {lookupError}
              </div>
            )}
          </div>

          {lookupResults !== null && lookupResults.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-sm text-slate-500">
              No se encontraron usuarios coincidentes con{" "}
              <strong className="text-slate-800">"{lookupQuery}"</strong>.
            </div>
          )}

          {lookupResults &&
            lookupResults.map((item) => (
              <div
                key={item.patientId}
                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-5"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-[#E6F4EC] text-[#00843D] flex items-center justify-center shrink-0">
                      <UserCheck className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-extrabold text-slate-900">
                          {item.patientMasked}
                        </h3>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                            item.hasAccount
                              ? "bg-emerald-50 text-[#00843D] border border-emerald-200"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {item.hasAccount ? "Cuenta registrada" : "Sin contraseña web"}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">
                        patient_id: {item.patientId}
                        {item.birthState ? ` · ${item.birthState}` : ""}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {item.identities.map((idLink, idx) => (
                      <span
                        key={`${idLink.identifierType}-${idx}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-mono"
                      >
                        <ShieldCheck
                          className={`w-3.5 h-3.5 ${
                            idLink.verified ? "text-[#00843D]" : "text-slate-400"
                          }`}
                        />
                        {idLink.identifierType}: {idLink.identifierMasked}
                      </span>
                    ))}
                  </div>
                </div>

                {item.cases.length === 0 ? (
                  <div className="text-sm text-slate-500">
                    Usuario registrado sin expedientes/citas activas todavía.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {item.cases.map((sc) => (
                      <div
                        key={sc.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5 space-y-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="font-bold text-slate-800">
                            {sc.contextSummary.study?.name || "Estudio por definir"}{" "}
                            {sc.contextSummary.clinic?.name ? `· ${sc.contextSummary.clinic.name}` : ""}
                            {sc.contextSummary.appointment_folio && (
                              <span className="ml-2 px-2 py-0.5 rounded bg-emerald-100 text-[#005A2B] font-mono">
                                {sc.contextSummary.appointment_folio}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-slate-400">
                            journey_id: {sc.journeyId} · v{sc.version}
                          </span>
                        </div>

                        {/* Tracking visual estilo Amazon / Mercado Libre con historial completo */}
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
                          <div className="p-3.5 rounded-xl bg-[#E6F4EC] border border-[#00843D]/25 text-xs text-slate-800 leading-relaxed">
                            <strong className="text-[#005A2B]">Resumen Handoff:</strong>{" "}
                            {sc.contextSummary.handoff_summary}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {/* ==================== PESTAÑA 3: ARQUITECTURA Y BUS EN VIVO ==================== */}
      {activeTab === "architecture" && (
        <BusArchitectureView
          overview={overview}
          latestEvent={liveEvents[0] ?? null}
          sseConnected={sseStatus === "connected"}
        />
      )}

      {/* Drawer de Timeline Inmutable */}
      {inspectCase && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex justify-end">
          <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-[#F8FAFC]">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-[#00843D]">
                  Auditoría Inmutable · journey_events
                </div>
                <h3 className="text-lg font-bold text-slate-900">{inspectCase.patientMasked}</h3>
                <div className="text-xs font-mono text-slate-500">
                  journey_id: {inspectCase.journeyId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectCase(null)}
                className="p-2 rounded-lg hover:bg-slate-200/70 text-slate-500 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
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
                <div className="p-4 rounded-xl bg-[#E6F4EC] border border-[#00843D]/25">
                  <div className="text-xs font-bold text-[#005A2B] uppercase tracking-wide mb-1">
                    Resumen Determinístico de Contexto (Handoff)
                  </div>
                  <p className="text-sm text-slate-800 leading-relaxed">
                    {inspectCase.contextSummary.handoff_summary}
                  </p>
                </div>
              )}

              {timelineLoading ? (
                <div className="py-12 text-center text-slate-400 text-sm">
                  Cargando línea de tiempo correlacionada...
                </div>
              ) : (
                <ol className="relative border-l-2 border-slate-200 ml-3 space-y-5">
                  {timelineEvents.map((ev) => {
                    const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                      label: ev.eventType,
                      tone: "text-slate-700 bg-slate-100",
                    };
                    return (
                      <li key={ev.id} className="ml-5">
                        <span className="absolute -left-[9px] w-4 h-4 rounded-full bg-white border-2 border-[#00843D]" />
                        <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${evMeta.tone}`}>
                              {evMeta.label}
                            </span>
                            <span className="text-xs text-slate-400 font-mono">
                              {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold">
                              Canal: {ev.channel}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200">
                              Actor: {ev.actorRole}
                            </span>
                            {ev.nextState && (
                              <span className="inline-flex items-center gap-1 font-semibold text-slate-800">
                                {ev.prevState ?? "—"}
                                <ArrowRight className="w-3 h-3" />
                                {ev.nextState}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400">
                            correlation_id: {ev.correlationId}
                          </div>
                          {ev.payloadJson && Object.keys(ev.payloadJson).length > 0 && (
                            <pre className="text-[11px] bg-white border border-slate-200 rounded-lg p-2.5 overflow-x-auto text-slate-600">
                              {JSON.stringify(ev.payloadJson, null, 2)}
                            </pre>
                          )}
                        </div>
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

interface KpiCardProps {
  title: string;
  value: number;
  subtitle: string;
  icon: React.ReactNode;
  accentBg: string;
}

const KpiCard: React.FC<KpiCardProps> = ({ title, value, subtitle, icon, accentBg }) => (
  <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm hover:border-slate-300 transition">
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-xs font-semibold text-slate-500">{title}</div>
        <div className="text-2xl font-extrabold text-slate-900 mt-1">{value}</div>
      </div>
      <div className={`p-2.5 rounded-xl ${accentBg}`}>{icon}</div>
    </div>
    <div className="text-[11px] font-medium text-slate-400 mt-2 truncate">{subtitle}</div>
  </div>
);

const QueueMetric: React.FC<{ label: string; value: number; tone: string }> = ({
  label,
  value,
  tone,
}) => (
  <div className="bg-white rounded-lg px-2.5 py-2 border border-slate-200/70">
    <div className="text-[10px] text-slate-400 font-medium">{label}</div>
    <div className={`text-base font-extrabold ${tone}`}>{value}</div>
  </div>
);
