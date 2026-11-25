import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QrCode } from "lucide-react";
import { OrderJourneyTracker } from "../components/OrderJourneyTracker";
import { PatientVoiceCallBar } from "../components/PatientVoiceCallBar";
import {
  api,
  ApiError,
  clearPatientSession,
  consumeLastSyncedCasesCount,
  getApiBaseUrl,
  getPatientToken,
} from "../lib/api";
import { CHANNEL_META, formatDateTime, formatMoney } from "../lib/constants";
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
  const [syncBanner, setSyncBanner] = useState<string | null>(() => {
    const initialSynced = consumeLastSyncedCasesCount();
    return initialSynced > 0
      ? `Vinculación inteligente completada: sincronizamos ${initialSynced} trámite(s) previo(s) de tus canales (Sitio Web, WhatsApp y Call Center) en tu historial.`
      : null;
  });

  // Vinculación manual opcional (otro número de WhatsApp/teléfono o folio con reto OTP)
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkPhone, setLinkPhone] = useState("");
  const [linkFolio, setLinkFolio] = useState("");
  const [linkOtpSent, setLinkOtpSent] = useState(false);
  const [linkOtpCode, setLinkOtpCode] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

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
      if (res.syncedCasesCount && res.syncedCasesCount > 0) {
        setSyncBanner(
          `Vinculación inteligente: se sincronizaron ${res.syncedCasesCount} trámite(s) adicional(es) desde WhatsApp o Call Center.`
        );
      }
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

  const handleRequestLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || (!linkPhone.trim() && !linkFolio.trim())) return;
    setLinkLoading(true);
    setLinkError(null);
    setLinkMessage(null);
    try {
      const res = await api.requestChannelLink(token, {
        ...(linkPhone.trim() ? { phone: linkPhone.trim() } : {}),
        ...(linkFolio.trim() ? { folio: linkFolio.trim() } : {}),
      });
      setLinkOtpSent(true);
      setLinkMessage(res.message);
    } catch (err) {
      setLinkError(
        err instanceof Error
          ? err.message
          : "No encontramos trámites pendientes de vincular con esos datos."
      );
    } finally {
      setLinkLoading(false);
    }
  };

  const handleVerifyLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || linkOtpCode.trim().length !== 6) return;
    setLinkLoading(true);
    setLinkError(null);
    try {
      const res = await api.verifyChannelLink(token, linkOtpCode.trim());
      setSyncBanner(res.message);
      setShowLinkForm(false);
      setLinkOtpSent(false);
      setLinkPhone("");
      setLinkFolio("");
      setLinkOtpCode("");
      setLinkMessage(null);
      await loadAccount();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "No se pudo verificar el código OTP.");
    } finally {
      setLinkLoading(false);
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
            Mi cuenta · {sseLive ? "Seguimiento omnicanal en tiempo real" : "Sincronizando"}
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

      {syncBanner && (
        <div className="border-l-2 border-[#00875A] pl-4 py-1 flex items-center justify-between gap-4 text-sm text-[#00875A]">
          <p className="font-medium">{syncBanner}</p>
          <button
            type="button"
            onClick={() => setSyncBanner(null)}
            className="text-xs font-semibold text-[#52606D] hover:text-[#1F2933] shrink-0"
          >
            Ocultar
          </button>
        </div>
      )}

      {/* Llamada de voz WebRTC en tiempo real con un asesor de Call Center */}
      <PatientVoiceCallBar
        caseId={cases.find((c) => c.currentState !== "CITA_CONFIRMADA")?.id ?? cases[0]?.id}
        phone={profile?.telefono || undefined}
        patientName={fullName || undefined}
      />

      {/* Vinculación asistida para trámites hechos desde otro número de WhatsApp o Call Center */}
      <section className="pb-6 border-b border-[#E4E7EB] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-[#1F2933]">
              Sincronización omnicanal (Sitio Web, WhatsApp y Call Center)
            </h2>
            <p className="text-xs text-[#52606D] mt-0.5">
              Tus citas registradas con tu teléfono o CURP se sincronizan automáticamente. Si
              agendaste desde otro número o tienes un folio previo, puedes vincularlo aquí.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowLinkForm((prev) => !prev);
              setLinkError(null);
              setLinkMessage(null);
            }}
            className="self-start sm:self-center text-xs font-semibold text-[#00875A] hover:underline shrink-0"
          >
            {showLinkForm ? "Cerrar vinculación" : "Vincular otro teléfono o folio →"}
          </button>
        </div>

        {showLinkForm && (
          <div className="pt-4 border-t border-[#E4E7EB] space-y-4 max-w-2xl">
            {linkError && (
              <p className="border-l-2 border-[#B42318] pl-3 text-xs text-[#B42318]">{linkError}</p>
            )}
            {linkMessage && (
              <p className="border-l-2 border-[#00875A] pl-3 text-xs text-[#00875A]">
                {linkMessage}
              </p>
            )}

            {!linkOtpSent ? (
              <form onSubmit={handleRequestLink} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                <div className="sm:col-span-5">
                  <label
                    htmlFor="link-phone"
                    className="block text-xs font-semibold text-[#1F2933] mb-1"
                  >
                    Teléfono usado en WhatsApp / Call Center
                  </label>
                  <input
                    id="link-phone"
                    type="tel"
                    value={linkPhone}
                    onChange={(e) => setLinkPhone(e.target.value)}
                    placeholder="10 dígitos o +52..."
                    className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                  />
                </div>
                <div className="sm:col-span-4">
                  <label
                    htmlFor="link-folio"
                    className="block text-xs font-semibold text-[#1F2933] mb-1"
                  >
                    O folio de cita (opcional)
                  </label>
                  <input
                    id="link-folio"
                    type="text"
                    value={linkFolio}
                    onChange={(e) => setLinkFolio(e.target.value.toUpperCase())}
                    placeholder="SD-2026-0000"
                    className="w-full h-10 border border-[#E4E7EB] px-3 text-xs font-mono text-[#1F2933] focus:border-[#00875A]"
                  />
                </div>
                <div className="sm:col-span-3">
                  <button
                    type="submit"
                    disabled={linkLoading || (!linkPhone.trim() && !linkFolio.trim())}
                    className="w-full h-10 border border-[#00875A] bg-[#00875A] text-[#FFFFFF] text-xs font-semibold hover:bg-[#006B47] transition-colors disabled:opacity-50"
                  >
                    {linkLoading ? "Buscando..." : "Solicitar OTP"}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleVerifyLink} className="flex flex-col sm:flex-row items-end gap-3">
                <div className="flex-1 w-full">
                  <label
                    htmlFor="link-otp"
                    className="block text-xs font-semibold text-[#1F2933] mb-1"
                  >
                    Código de verificación OTP (6 dígitos · Consola 2FA / SMS)
                  </label>
                  <input
                    id="link-otp"
                    type="text"
                    maxLength={6}
                    value={linkOtpCode}
                    onChange={(e) => setLinkOtpCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                    required
                    className="w-full h-10 border border-[#E4E7EB] px-3 text-sm font-mono tracking-widest text-[#1F2933] focus:border-[#00875A]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={linkLoading || linkOtpCode.length !== 6}
                  className="h-10 px-5 border border-[#00875A] bg-[#00875A] text-[#FFFFFF] text-xs font-semibold hover:bg-[#006B47] transition-colors disabled:opacity-50 shrink-0"
                >
                  {linkLoading ? "Vinculando..." : "Confirmar vinculación"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLinkOtpSent(false);
                    setLinkOtpCode("");
                  }}
                  className="h-10 px-3 border border-[#E4E7EB] text-xs font-semibold text-[#52606D] hover:text-[#1F2933] shrink-0"
                >
                  Volver
                </button>
              </form>
            )}
          </div>
        )}
      </section>

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
              const originChannel = c.journeyEvents?.[0]?.channel ?? c.currentChannel;

              return (
                <li key={c.id} className="py-8 space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold text-[#00875A]">
                        Iniciado en {CHANNEL_META[originChannel]?.label || originChannel}
                        {originChannel !== c.currentChannel
                          ? ` · Último canal: ${
                              CHANNEL_META[c.currentChannel]?.label || c.currentChannel
                            }`
                          : ""}
                      </p>
                      <h3 className="text-xl font-bold text-[#1F2933] mt-0.5">
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
