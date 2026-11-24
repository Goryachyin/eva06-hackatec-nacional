import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FlaskConical,
  Lock,
  Mail,
  MapPin,
  Phone,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  User,
  Users,
} from "lucide-react";
import { OrderJourneyTracker } from "../components/OrderJourneyTracker";
import {
  api,
  ApiError,
  clearPatientSession,
  getApiBaseUrl,
  getPatientToken,
} from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/constants";
import {
  PatientBeneficiaryItem,
  PatientCaseWithEvents,
  PatientProfile,
} from "../types/api";

export const PatientAccountPage: React.FC = () => {
  const navigate = useNavigate();
  const [token] = useState<string | null>(() => getPatientToken());
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<PatientBeneficiaryItem[]>([]);
  const [cases, setCases] = useState<PatientCaseWithEvents[]>([]);
  const [loading, setLoading] = useState(true);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [sseLive, setSseLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    if (!token) {
      navigate("/login?next=/mi-cuenta", { replace: true });
      return;
    }
    try {
      const res = await api.getPatientMe(token);
      setProfile(res.patient);
      setBeneficiaries(res.beneficiaries || []);
      setCases(res.cases || []);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearPatientSession();
        navigate("/login?next=/mi-cuenta", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : "No se pudo cargar tu cuenta.");
    } finally {
      setLoading(false);
    }
  }, [token, navigate]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  // Stream SSE en tiempo real para actualizar la barra tipo Amazon/Mercado Libre al instante
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(
      `${getApiBaseUrl()}/api/patients/me/stream?token=${encodeURIComponent(token)}`
    );
    es.addEventListener("connected", () => setSseLive(true));
    es.addEventListener("journey_event", () => {
      loadAccount();
    });
    es.onerror = () => setSseLive(false);
    return () => es.close();
  }, [token, loadAccount]);

  const handleResumeCase = async (caseId: string) => {
    setResumingId(caseId);
    try {
      await api.resumeWebCase(caseId);
      navigate(`/laboratorio?resumeCaseId=${encodeURIComponent(caseId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo retomar la solicitud.");
    } finally {
      setResumingId(null);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center text-sm text-slate-500">
        Cargando tu expediente de paciente...
      </div>
    );
  }

  const fullName = [profile?.nombres, profile?.apellido_paterno, profile?.apellido_materno]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Cabecera de Cuenta */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-[#E6F4EC] text-[#00843D] flex items-center justify-center shrink-0">
            <User className="w-7 h-7" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-[#00843D]">
                Mi Cuenta Salud Digna
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                  sseLive
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-50 text-slate-500 border-slate-200"
                }`}
              >
                <Radio className={`w-3 h-3 ${sseLive ? "animate-pulse" : ""}`} />
                {sseLive ? "Seguimiento en tiempo real" : "Sincronizando"}
              </span>
            </div>
            <h1 className="text-2xl font-extrabold text-slate-900 mt-0.5">
              {fullName || "Paciente Salud Digna"}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-1.5">
              {profile?.email && (
                <span className="inline-flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5" />
                  {profile.email}
                </span>
              )}
              {profile?.telefono && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Phone className="w-3.5 h-3.5" />
                  {profile.telefono}
                </span>
              )}
              {profile?.curp && (
                <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-700">
                  CURP: {profile.curp}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={loadAccount}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold transition"
          >
            <RefreshCw className="w-4 h-4" />
            Actualizar
          </button>
          <Link
            to="/laboratorio"
            className="inline-flex items-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-5 py-2.5 rounded-xl text-sm shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            Solicitar estudio
          </Link>
        </div>
      </div>

      {/* Familiares / Beneficiarios vinculados con privacidad clínica */}
      {beneficiaries.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-[#0066B3]" />
              Familiares y conocidos registrados ({beneficiaries.length})
            </h2>
            <span className="text-[11px] text-slate-500 inline-flex items-center gap-1">
              <Lock className="w-3 h-3 text-[#00843D]" />
              Cada beneficiario conserva su expediente clínico independiente
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {beneficiaries.map((b) => (
              <div
                key={b.relationshipId}
                className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-900 truncate">
                    {[b.nombres, b.apellido_paterno].filter(Boolean).join(" ")}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {b.relationshipLabel} ·{" "}
                    <span className="font-mono">{b.curpMasked || "CURP protegida"}</span>
                  </div>
                </div>
                <Link
                  to={`/laboratorio?forBeneficiary=${encodeURIComponent(b.beneficiaryId)}`}
                  className="shrink-0 px-2.5 py-1.5 rounded-lg bg-[#E6F4EC] hover:bg-[#d7eee0] text-[#005A2B] text-[11px] font-bold transition"
                >
                  Agendar
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Lista de Citas con Rastreo en Vivo estilo Amazon / Mercado Libre */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
            <CalendarCheck className="w-5 h-5 text-[#00843D]" />
            Seguimiento de Mis Citas y Trámites ({cases.length})
          </h2>
        </div>

        {cases.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-[#E6F4EC] text-[#00843D] mx-auto flex items-center justify-center">
              <FlaskConical className="w-7 h-7" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Aún no tienes estudios solicitados
              </h3>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                Solicita un estudio para ti o para un familiar y da seguimiento en tiempo real desde
                cualquier canal (Web, WhatsApp o Call Center).
              </p>
            </div>
            <Link
              to="/laboratorio"
              className="inline-flex items-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-6 py-3 rounded-xl text-sm shadow-sm transition"
            >
              Explorar estudios de laboratorio
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5">
            {cases.map((c) => {
              const isConfirmed =
                c.currentState === "CITA_CONFIRMADA" && Boolean(c.contextJson.appointment_folio);

              return (
                <div
                  key={c.id}
                  className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-extrabold text-slate-900">
                        {c.contextJson.study?.name || "Solicitud de estudio en proceso"}
                      </h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-1">
                        {c.contextJson.clinic && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-[#00843D]" />
                            {c.contextJson.clinic.name}
                          </span>
                        )}
                        {c.contextJson.preferred_slot && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-[#0066B3]" />
                            {c.contextJson.preferred_slot.date} ·{" "}
                            {c.contextJson.preferred_slot.time} hrs
                          </span>
                        )}
                        <span>Actualizado: {formatDateTime(c.updatedAt)}</span>
                      </div>
                    </div>

                    {c.contextJson.study?.price && (
                      <div className="text-left sm:text-right shrink-0">
                        <div className="text-xs text-slate-400">Precio de lista</div>
                        <div className="text-xl font-extrabold text-[#00843D]">
                          {formatMoney(c.contextJson.study.price)}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Barra de progreso + historial estilo Amazon / Mercado Libre */}
                  <OrderJourneyTracker
                    currentState={c.currentState}
                    currentChannel={c.currentChannel}
                    events={c.journeyEvents || []}
                    isThirdParty={c.isThirdParty}
                    beneficiaryLabel={c.beneficiaryDisplay}
                    relationshipLabel={c.relationshipLabel}
                    defaultExpanded={cases.length === 1}
                  />

                  {c.privacyNotice && (
                    <div className="px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200/80 text-[11px] text-amber-900 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>{c.privacyNotice}</span>
                    </div>
                  )}

                  {c.contextJson.study?.prep && (
                    <div className="p-3.5 rounded-xl bg-[#EBF4FC] text-[#005291] text-xs leading-relaxed">
                      <strong>Preparación para el estudio:</strong> {c.contextJson.study.prep}
                    </div>
                  )}

                  {isConfirmed ? (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase text-[#00843D]">
                          <CheckCircle2 className="w-4 h-4" />
                          Cita confirmada · Presentar en recepción
                        </div>
                        <div className="text-2xl font-extrabold font-mono text-[#005A2B] mt-0.5">
                          {c.contextJson.appointment_folio}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                          {c.contextJson.qr_payload}
                        </div>
                      </div>
                      <div className="p-2.5 bg-white rounded-xl border border-emerald-200 self-start sm:self-center">
                        <QrCode className="w-14 h-14 text-[#005A2B]" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs text-slate-500">
                      <span>
                        Retoma exactamente donde te quedaste sin importar en qué canal iniciaste o
                        cuántas veces cambiaste de canal.
                      </span>
                      <button
                        type="button"
                        disabled={resumingId === c.id}
                        onClick={() => handleResumeCase(c.id)}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0066B3] hover:bg-[#005291] text-white font-bold transition disabled:opacity-60"
                      >
                        {resumingId === c.id
                          ? "Cargando contexto..."
                          : "Retomar solicitud aquí"}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
