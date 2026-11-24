import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QrCode } from "lucide-react";
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
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-sm text-[#52606D]">
        Cargando expediente del paciente...
      </div>
    );
  }

  const fullName = [profile?.nombres, profile?.apellido_paterno, profile?.apellido_materno]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-12 bg-[#FFFFFF] text-[#1F2933]">
      {/* Cabecera de cuenta abierta con divisor inferior */}
      <header className="pb-8 border-b border-[#E4E7EB] flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
            Mi cuenta · {sseLive ? "Seguimiento en tiempo real activo" : "Sincronizando"}
          </p>
          <h1 className="text-3xl font-bold text-[#1F2933]">
            {fullName || "Paciente Salud Digna"}
          </h1>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[#52606D] pt-1">
            {profile?.email && (
              <div className="flex gap-1.5">
                <dt className="font-semibold text-[#1F2933]">Correo:</dt>
                <dd>{profile.email}</dd>
              </div>
            )}
            {profile?.telefono && (
              <div className="flex gap-1.5">
                <dt className="font-semibold text-[#1F2933]">Teléfono:</dt>
                <dd className="font-mono">{profile.telefono}</dd>
              </div>
            )}
            {profile?.curp && (
              <div className="flex gap-1.5">
                <dt className="font-semibold text-[#1F2933]">CURP:</dt>
                <dd className="font-mono">{profile.curp}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="flex flex-wrap items-center gap-4 shrink-0">
          <button
            type="button"
            onClick={loadAccount}
            className="h-11 px-4 border border-[#E4E7EB] text-sm font-semibold text-[#1F2933] hover:border-[#1F2933] transition-colors"
          >
            Actualizar
          </button>
          <Link
            to="/laboratorio"
            className="inline-flex items-center justify-center h-11 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors"
          >
            Solicitar estudio
          </Link>
        </div>
      </header>

      {/* Familiares y beneficiarios en lista vertical */}
      {beneficiaries.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-3 border-b border-[#E4E7EB]">
            <h2 className="text-lg font-bold text-[#1F2933]">
              Familiares y conocidos registrados ({beneficiaries.length})
            </h2>
            <p className="text-xs text-[#52606D]">
              Cada beneficiario conserva su expediente clínico independiente
            </p>
          </div>
          <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
            {beneficiaries.map((b) => (
              <li
                key={b.relationshipId}
                className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <strong className="block text-sm font-semibold text-[#1F2933]">
                    {[b.nombres, b.apellido_paterno].filter(Boolean).join(" ")}
                  </strong>
                  <p className="text-xs text-[#52606D] mt-0.5">
                    {b.relationshipLabel} ·{" "}
                    <code className="font-mono">{b.curpMasked || "CURP protegida"}</code>
                  </p>
                </div>
                <Link
                  to={`/laboratorio?forBeneficiary=${encodeURIComponent(b.beneficiaryId)}`}
                  className="text-sm font-semibold text-[#00875A] hover:underline shrink-0"
                >
                  Agendar estudio →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
      )}

      {/* Seguimiento de citas y trámites */}
      <section className="space-y-6">
        <h2 className="text-xl font-bold text-[#1F2933] pb-3 border-b border-[#E4E7EB]">
          Seguimiento de mis citas y trámites ({cases.length})
        </h2>

        {cases.length === 0 ? (
          <div className="py-12 space-y-4">
            <h3 className="text-base font-bold text-[#1F2933]">
              Aún no tienes estudios solicitados
            </h3>
            <p className="text-sm text-[#52606D] max-w-lg">
              Solicita un estudio para ti o para un familiar y da seguimiento en tiempo real desde
              cualquier canal: sitio web, WhatsApp o Call Center.
            </p>
            <Link
              to="/laboratorio"
              className="inline-block text-sm font-semibold text-[#00875A] hover:underline"
            >
              Explorar catálogo de estudios →
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
            {cases.map((c) => {
              const isConfirmed =
                c.currentState === "CITA_CONFIRMADA" && Boolean(c.contextJson.appointment_folio);

              return (
                <li key={c.id} className="py-8 space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                      <h3 className="text-xl font-bold text-[#1F2933]">
                        {c.contextJson.study?.name || "Solicitud de estudio en proceso"}
                      </h3>
                      <p className="text-xs text-[#52606D] mt-1">
                        {c.contextJson.clinic ? `${c.contextJson.clinic.name} · ` : ""}
                        {c.contextJson.preferred_slot
                          ? `${c.contextJson.preferred_slot.date} a las ${c.contextJson.preferred_slot.time} hrs · `
                          : ""}
                        Actualizado:{" "}
                        <time dateTime={c.updatedAt}>{formatDateTime(c.updatedAt)}</time>
                      </p>
                    </div>

                    {c.contextJson.study?.price && (
                      <div className="sm:text-right shrink-0">
                        <small className="block text-xs text-[#52606D]">Precio de lista</small>
                        <strong className="text-xl font-bold text-[#1F2933]">
                          {formatMoney(c.contextJson.study.price)}
                        </strong>
                      </div>
                    )}
                  </div>

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
                    <p className="border-l-2 border-[#E4E7EB] pl-4 text-xs text-[#52606D]">
                      {c.privacyNotice}
                    </p>
                  )}

                  {c.contextJson.study?.prep && (
                    <p className="text-xs text-[#52606D] leading-relaxed">
                      <strong className="text-[#1F2933]">Preparación para el estudio:</strong>{" "}
                      {c.contextJson.study.prep}
                    </p>
                  )}

                  {isConfirmed ? (
                    <div className="border-l-2 border-[#00875A] pl-5 py-1 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                          Cita confirmada · Presentar en recepción
                        </p>
                        <strong className="block text-2xl font-bold font-mono text-[#1F2933] mt-1">
                          {c.contextJson.appointment_folio}
                        </strong>
                        <code className="block text-xs font-mono text-[#52606D] mt-0.5">
                          {c.contextJson.qr_payload}
                        </code>
                      </div>
                      <div className="p-2 border border-[#E4E7EB] self-start sm:self-center">
                        <QrCode className="w-14 h-14 text-[#1F2933]" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
                      <p className="text-xs text-[#52606D]">
                        Retoma exactamente donde te quedaste sin importar en qué canal iniciaste.
                      </p>
                      <button
                        type="button"
                        disabled={resumingId === c.id}
                        onClick={() => handleResumeCase(c.id)}
                        className="px-4 py-2 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors disabled:opacity-50"
                      >
                        {resumingId === c.id
                          ? "Cargando contexto..."
                          : "Retomar solicitud aquí →"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
