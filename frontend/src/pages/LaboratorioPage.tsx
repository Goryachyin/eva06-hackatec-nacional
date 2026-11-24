import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookmarkCheck,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  FlaskConical,
  Info,
  Lock,
  MapPin,
  QrCode,
  Store,
  User,
  UserCheck,
  Users,
} from "lucide-react";
import {
  api,
  getOrCreateWebSessionId,
  getPatientToken,
  getStoredPatient,
  setLastPatientPhone,
} from "../lib/api";
import { formatMoney, STATE_META } from "../lib/constants";
import { generateDeterministicCurp, MEXICAN_STATES } from "../lib/curp";
import {
  ClinicItem,
  PatientBeneficiaryItem,
  RelationshipType,
  ServiceCase,
  StudyItem,
} from "../types/api";

type WizardStep = 1 | 2 | 3;

const TIME_SLOTS = ["07:30", "08:30", "09:30", "10:30", "11:30", "13:00", "16:00"];

const RELATIONSHIP_OPTIONS: Array<{ value: RelationshipType; label: string }> = [
  { value: "HIJO_A", label: "Hijo / Hija" },
  { value: "PADRE_MADRE", label: "Padre / Madre" },
  { value: "CONYUGE", label: "Esposo / Esposa (Cónyuge)" },
  { value: "ABUELO_A", label: "Abuelo / Abuela" },
  { value: "FAMILIAR", label: "Otro familiar" },
  { value: "CONOCIDO", label: "Conocido / Amigo" },
];

function findStateCodeByNameOrCode(val: string | null | undefined): string {
  if (!val) return "";
  const clean = val
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
  const match = MEXICAN_STATES.find(
    (st) =>
      st.code === clean ||
      st.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase() === clean
  );
  return match?.code || "";
}

export const LaboratorioPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initialCat = searchParams.get("cat") || "Todos";
  const resumeCaseIdParam = searchParams.get("resumeCaseId");
  const forBeneficiaryParam = searchParams.get("forBeneficiary");

  const patientToken = getPatientToken();
  const loggedPatient = patientToken ? getStoredPatient() : null;

  const [step, setStep] = useState<WizardStep>(1);

  // Catálogo del backend
  const [studies, setStudies] = useState<StudyItem[]>([]);
  const [clinics, setClinics] = useState<ClinicItem[]>([]);
  const [savedBeneficiaries, setSavedBeneficiaries] = useState<PatientBeneficiaryItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCat);

  // Paso 1: Estudio, Clínica y Horario
  const [selectedStudyCode, setSelectedStudyCode] = useState<string>("US-OBS");
  const [selectedClinicId, setSelectedClinicId] = useState<string>("CLN-CUL-01");
  const [preferredDate, setPreferredDate] = useState<string>(() => {
    const tomorrow = new Date(Date.now() + 86400000);
    return tomorrow.toISOString().slice(0, 10);
  });
  const [preferredTime, setPreferredTime] = useState<string>("09:30");

  // Selector Multibeneficiario ("Para mí" vs "Para un familiar o conocido")
  const [forThirdParty, setForThirdParty] = useState<boolean>(Boolean(forBeneficiaryParam));
  const [relationship, setRelationship] = useState<RelationshipType>("HIJO_A");
  const [thirdPartyConsent, setThirdPartyConsent] = useState<boolean>(false);

  // Paso 2: Campos oficiales "Perfil del paciente" (titular o beneficiario según el selector)
  const [nombres, setNombres] = useState(() => (!forBeneficiaryParam ? loggedPatient?.nombres || "" : ""));
  const [apellidoPaterno, setApellidoPaterno] = useState(() =>
    !forBeneficiaryParam ? loggedPatient?.apellido_paterno || "" : ""
  );
  const [apellidoMaterno, setApellidoMaterno] = useState(() =>
    !forBeneficiaryParam ? loggedPatient?.apellido_materno || "" : ""
  );
  const [fechaNacimiento, setFechaNacimiento] = useState(() =>
    !forBeneficiaryParam ? loggedPatient?.fecha_nacimiento || "" : ""
  );
  const [genero, setGenero] = useState<"FEMENINO" | "MASCULINO" | "">(() =>
    !forBeneficiaryParam &&
    (loggedPatient?.genero === "FEMENINO" || loggedPatient?.genero === "MASCULINO")
      ? loggedPatient.genero
      : ""
  );
  const [estadoNacimientoCode, setEstadoNacimientoCode] = useState(() =>
    !forBeneficiaryParam ? findStateCodeByNameOrCode(loggedPatient?.estado_nacimiento) : ""
  );
  const [pais, setPais] = useState(() => (loggedPatient?.pais || "MÉXICO").toUpperCase());
  const [curp, setCurp] = useState(() => (!forBeneficiaryParam ? loggedPatient?.curp || "" : ""));
  const [curpManuallyEdited, setCurpManuallyEdited] = useState(() =>
    Boolean(!forBeneficiaryParam && loggedPatient?.curp)
  );
  const [telefono, setTelefono] = useState(() => loggedPatient?.telefono || "");

  const dateInputRef = useRef<HTMLInputElement | null>(null);

  // Estado del trámite en el backend
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<ServiceCase | null>(null);
  const [confirmedFolio, setConfirmedFolio] = useState<{ folio: string; qrPayload: string } | null>(
    null
  );

  // Paso 3: Pago, Confirmación y Guardado para después
  const [paymentMethod, setPaymentMethod] = useState<"online" | "oxxo" | "clinic">("online");
  const [savedForLater, setSavedForLater] = useState(false);
  const [savingLater, setSavingLater] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Cargar catálogo + beneficiarios guardados + caso a retomar (si viene de N-saltos)
  useEffect(() => {
    let active = true;
    setCatalogLoading(true);

    Promise.all([
      api.getCatalog(),
      patientToken ? api.getPatientMe(patientToken).catch(() => null) : Promise.resolve(null),
    ])
      .then(([catRes, meRes]) => {
        if (!active) return;
        setStudies(catRes.studies);
        setClinics(catRes.clinics);

        if (catRes.studies.length > 0) {
          const matchCat = catRes.studies.find((s) => s.category === initialCat);
          setSelectedStudyCode(matchCat ? matchCat.code : catRes.studies[0].code);
        }
        if (catRes.clinics.length > 0) {
          setSelectedClinicId(catRes.clinics[0].id);
        }

        if (meRes) {
          setSavedBeneficiaries(meRes.beneficiaries || []);

          // Si vino con ?forBeneficiary=... precargar los datos de ese familiar
          if (forBeneficiaryParam) {
            const foundB = (meRes.beneficiaries || []).find(
              (b) => b.beneficiaryId === forBeneficiaryParam
            );
            if (foundB) {
              applyBeneficiaryPreset(foundB);
            }
          }

          // Si vino con ?resumeCaseId=... rehidratar el trámite desde cualquier canal (N-saltos)
          if (resumeCaseIdParam) {
            const foundCase = (meRes.cases || []).find((c) => c.id === resumeCaseIdParam);
            if (foundCase) {
              setActiveCase(foundCase);
              if (foundCase.contextJson.study?.code) {
                setSelectedStudyCode(foundCase.contextJson.study.code);
              }
              if (foundCase.contextJson.clinic?.id) {
                setSelectedClinicId(foundCase.contextJson.clinic.id);
              }
              if (foundCase.contextJson.preferred_slot?.date) {
                setPreferredDate(foundCase.contextJson.preferred_slot.date);
              }
              if (foundCase.contextJson.preferred_slot?.time) {
                setPreferredTime(foundCase.contextJson.preferred_slot.time);
              }
              if (foundCase.contextJson.appointment_folio) {
                setConfirmedFolio({
                  folio: foundCase.contextJson.appointment_folio,
                  qrPayload: foundCase.contextJson.qr_payload || "",
                });
              }
              // Si ya tiene estudio y clínica, ir directo al Paso 3 para confirmar sin repetir pasos
              if (foundCase.contextJson.study && foundCase.contextJson.clinic) {
                setStep(3);
              } else {
                setStep(1);
              }
            }
          }
        }
      })
      .catch((err) => {
        if (!active) return;
        setCatalogError(
          err instanceof Error ? err.message : "No se pudo cargar el catálogo de estudios."
        );
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });

    return () => {
      active = false;
    };
  }, [initialCat, patientToken, resumeCaseIdParam, forBeneficiaryParam]);

  const applySelfPreset = () => {
    setForThirdParty(false);
    setThirdPartyConsent(false);
    setNombres(loggedPatient?.nombres || "");
    setApellidoPaterno(loggedPatient?.apellido_paterno || "");
    setApellidoMaterno(loggedPatient?.apellido_materno || "");
    setFechaNacimiento(loggedPatient?.fecha_nacimiento || "");
    setGenero(
      loggedPatient?.genero === "FEMENINO" || loggedPatient?.genero === "MASCULINO"
        ? loggedPatient.genero
        : ""
    );
    setEstadoNacimientoCode(findStateCodeByNameOrCode(loggedPatient?.estado_nacimiento));
    setPais((loggedPatient?.pais || "MÉXICO").toUpperCase());
    setCurp(loggedPatient?.curp || "");
    setCurpManuallyEdited(Boolean(loggedPatient?.curp));
    setTelefono(loggedPatient?.telefono || "");
  };

  const applyThirdPartyBlank = () => {
    setForThirdParty(true);
    setThirdPartyConsent(false);
    setNombres("");
    setApellidoPaterno("");
    setApellidoMaterno("");
    setFechaNacimiento("");
    setGenero("");
    setEstadoNacimientoCode("");
    setPais("MÉXICO");
    setCurp("");
    setCurpManuallyEdited(false);
    // El teléfono de contacto por defecto sigue siendo el del Titular
    setTelefono(loggedPatient?.telefono || telefono);
  };

  const applyBeneficiaryPreset = (b: PatientBeneficiaryItem) => {
    setForThirdParty(true);
    setRelationship(b.relationship);
    setThirdPartyConsent(true);
    setNombres(b.nombres || "");
    setApellidoPaterno(b.apellido_paterno || "");
    setApellidoMaterno(b.apellido_materno || "");
    setFechaNacimiento(b.fecha_nacimiento || "");
    setGenero(b.genero === "FEMENINO" || b.genero === "MASCULINO" ? b.genero : "");
    setEstadoNacimientoCode(findStateCodeByNameOrCode(b.estado_nacimiento));
    setPais((b.pais || "MÉXICO").toUpperCase());
    setCurp(b.curp || "");
    setCurpManuallyEdited(Boolean(b.curp));
    if (loggedPatient?.telefono) setTelefono(loggedPatient.telefono);
  };

  // Autogeneración determinística de CURP
  useEffect(() => {
    if (curpManuallyEdited) return;
    if (!estadoNacimientoCode) {
      setCurp("");
      return;
    }
    const generated = generateDeterministicCurp({
      nombres,
      apellidoPaterno,
      apellidoMaterno,
      fechaNacimiento,
      genero,
      estadoCode: estadoNacimientoCode,
    });
    if (generated) setCurp(generated);
  }, [
    nombres,
    apellidoPaterno,
    apellidoMaterno,
    fechaNacimiento,
    genero,
    estadoNacimientoCode,
    curpManuallyEdited,
  ]);

  const categories = useMemo(() => {
    const unique = Array.from(new Set(studies.map((s) => s.category)));
    return ["Todos", ...unique];
  }, [studies]);

  const filteredStudies = useMemo(() => {
    if (selectedCategory === "Todos") return studies;
    return studies.filter((s) => s.category === selectedCategory);
  }, [studies, selectedCategory]);

  const selectedStudy = useMemo(
    () => studies.find((s) => s.code === selectedStudyCode) || null,
    [studies, selectedStudyCode]
  );

  const selectedClinic = useMemo(
    () => clinics.find((c) => c.id === selectedClinicId) || null,
    [clinics, selectedClinicId]
  );

  const normalizedPhoneForSubmit = (raw: string): string => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+52${digits}`;
    if (digits.startsWith("52") && digits.length >= 12) return `+${digits}`;
    return raw.trim();
  };

  const isProfileValid = useMemo(() => {
    const cleanPhoneDigits = telefono.replace(/\D/g, "");
    const baseOk =
      nombres.trim().length >= 2 &&
      apellidoPaterno.trim().length >= 2 &&
      fechaNacimiento.length === 10 &&
      (genero === "FEMENINO" || genero === "MASCULINO") &&
      estadoNacimientoCode.length === 2 &&
      pais.trim().length > 0 &&
      curp.trim().length === 18 &&
      cleanPhoneDigits.length >= 10;
    if (!baseOk) return false;
    if (forThirdParty && !thirdPartyConsent) return false;
    return true;
  }, [
    nombres,
    apellidoPaterno,
    fechaNacimiento,
    genero,
    estadoNacimientoCode,
    pais,
    curp,
    telefono,
    forThirdParty,
    thirdPartyConsent,
  ]);

  const formatDateDisplay = (isoDate: string): string => {
    if (!isoDate) return "dd/mm/aaaa";
    const parts = isoDate.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate;
  };

  const handleSubmitProfileAndQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isProfileValid || !selectedStudy) return;

    setSubmitting(true);
    setSubmitError(null);
    const webSessionId = getOrCreateWebSessionId();
    const phone = normalizedPhoneForSubmit(telefono);
    const stateObj = MEXICAN_STATES.find((st) => st.code === estadoNacimientoCode);

    try {
      if (!forThirdParty) {
        await api.registerWebPatient({
          nombres: nombres.trim(),
          apellido_paterno: apellidoPaterno.trim(),
          apellido_materno: apellidoMaterno.trim() || undefined,
          fecha_nacimiento: fechaNacimiento,
          genero,
          estado_nacimiento: stateObj?.name || estadoNacimientoCode,
          pais,
          curp: curp.trim().toUpperCase(),
          telefono: phone,
          email: loggedPatient?.email || undefined,
          webSessionId,
        });
      }

      const quoteRes = await api.quoteWebStudy({
        caseId: activeCase?.id,
        expectedVersion: activeCase?.version,
        webSessionId,
        telefono: phone,
        curp: forThirdParty ? loggedPatient?.curp || undefined : curp.trim().toUpperCase(),
        nombres: forThirdParty ? loggedPatient?.nombres || undefined : nombres.trim(),
        apellido_paterno: forThirdParty
          ? loggedPatient?.apellido_paterno || undefined
          : apellidoPaterno.trim(),
        studyCode: selectedStudy.code,
        clinicId: selectedClinic?.id,
        preferredSlot: {
          date: preferredDate,
          time: preferredTime,
        },
        ...(forThirdParty
          ? {
              forThirdParty: true,
              relationship,
              thirdPartyConsent: true,
              beneficiary: {
                nombres: nombres.trim(),
                apellido_paterno: apellidoPaterno.trim(),
                apellido_materno: apellidoMaterno.trim() || undefined,
                fecha_nacimiento: fechaNacimiento,
                genero,
                estado_nacimiento: stateObj?.name || estadoNacimientoCode,
                pais,
                curp: curp.trim().toUpperCase(),
              },
            }
          : {}),
      });

      setLastPatientPhone(phone);
      setActiveCase(quoteRes.case);
      setSavedForLater(false);
      setConfirmedFolio(null);
      setStep(3);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "No fue posible guardar tu pre-registro y cotización."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveForLater = async () => {
    if (!activeCase) return;
    setSavingLater(true);
    setSubmitError(null);
    try {
      const res = await api.abandonWebCase({
        caseId: activeCase.id,
        expectedVersion: activeCase.version,
        reason: "PATIENT_SAVED_DRAFT_TO_CONTINUE_LATER",
      });
      setActiveCase(res.case);
      setSavedForLater(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "No fue posible guardar tu borrador.");
    } finally {
      setSavingLater(false);
    }
  };

  const handleConfirmOnline = async () => {
    if (!activeCase) return;
    setConfirming(true);
    setSubmitError(null);
    try {
      const res = await api.confirmWebCase(activeCase.id, {
        expectedVersion: activeCase.version,
        paymentMethod,
      });
      setActiveCase(res.case);
      setConfirmedFolio({ folio: res.folio, qrPayload: res.qrPayload });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "No fue posible confirmar tu cita.");
    } finally {
      setConfirming(false);
    }
  };

  const basePrice = activeCase?.contextJson.study?.price ?? selectedStudy?.price ?? 0;
  const onlineDiscount = Math.round(basePrice * 0.1);
  const finalPrice = paymentMethod === "online" ? basePrice - onlineDiscount : basePrice;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Encabezado y Stepper */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[#00843D] flex items-center gap-1.5">
              <FlaskConical className="w-4 h-4" />
              Estudios y Citas en Línea
            </div>
            <h1 className="text-2xl font-extrabold text-slate-900 mt-0.5">
              Agenda tus estudios de Laboratorio e Imagenología
            </h1>
          </div>
          {activeCase && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
              <span className="text-slate-500">Estatus:</span>
              <span
                className={`px-2 py-0.5 rounded-full font-bold border ${
                  STATE_META[activeCase.currentState].badgeClass
                }`}
              >
                {STATE_META[activeCase.currentState].label}
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-4 pt-5">
          {[
            { num: 1 as WizardStep, title: "Estudio y clínica", icon: Building2 },
            { num: 2 as WizardStep, title: "Pre-registro", icon: UserCheck },
            { num: 3 as WizardStep, title: "Resumen y pago", icon: CreditCard },
          ].map((item) => {
            const Icon = item.icon;
            const isCurrent = step === item.num;
            const isDone = step > item.num;
            return (
              <button
                key={item.num}
                type="button"
                disabled={item.num === 3 && !activeCase}
                onClick={() => {
                  if (item.num <= step || (item.num === 2 && selectedStudy)) {
                    setStep(item.num);
                  }
                }}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition ${
                  isCurrent
                    ? "bg-[#E6F4EC] border-[#00843D] text-[#005A2B]"
                    : isDone
                    ? "bg-white border-emerald-200 text-slate-800 hover:bg-slate-50"
                    : "bg-slate-50 border-slate-200 text-slate-400"
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-bold text-xs ${
                    isCurrent
                      ? "bg-[#00843D] text-white"
                      : isDone
                      ? "bg-emerald-100 text-[#00843D]"
                      : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {isDone ? <Check className="w-4 h-4" /> : item.num}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-75">
                    Paso {item.num}
                  </div>
                  <div className="text-xs sm:text-sm font-bold truncate flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 hidden sm:inline shrink-0" />
                    {item.title}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {catalogError && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{catalogError}</span>
        </div>
      )}

      {/* ==================== PASO 1: ESTUDIO Y CLÍNICA ==================== */}
      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">1. Elige tu estudio</h2>
                  <p className="text-xs text-slate-500">
                    Precios vigentes e indicaciones previas a tu cita
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                        selectedCategory === cat
                          ? "bg-[#00843D] text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {catalogLoading ? (
                <div className="py-10 text-center text-sm text-slate-400">
                  Cargando catálogo de estudios...
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {filteredStudies.map((study) => {
                    const active = study.code === selectedStudyCode;
                    return (
                      <button
                        key={study.code}
                        type="button"
                        onClick={() => setSelectedStudyCode(study.code)}
                        className={`text-left p-4 rounded-xl border transition flex flex-col justify-between ${
                          active
                            ? "border-[#00843D] bg-[#E6F4EC]/50 ring-2 ring-[#00843D]/20"
                            : "border-slate-200 hover:border-slate-300 bg-white"
                        }`}
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-wide text-[#0066B3]">
                              {study.category}
                            </span>
                            <span className="text-base font-extrabold text-[#00843D]">
                              {formatMoney(study.price)}
                            </span>
                          </div>
                          <h3 className="text-sm font-bold text-slate-900 mt-1">{study.name}</h3>
                          <p className="text-xs text-slate-500 mt-1.5 leading-relaxed flex items-start gap-1.5">
                            <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                            <span>{study.prep}</span>
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm space-y-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  2. Selecciona tu clínica y horario preferido
                </h2>
                <p className="text-xs text-slate-500">Elige la sucursal más cercana</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {clinics.map((clinic) => {
                  const active = clinic.id === selectedClinicId;
                  return (
                    <button
                      key={clinic.id}
                      type="button"
                      onClick={() => setSelectedClinicId(clinic.id)}
                      className={`text-left p-4 rounded-xl border transition ${
                        active
                          ? "border-[#00843D] bg-[#E6F4EC]/50 ring-2 ring-[#00843D]/20"
                          : "border-slate-200 hover:border-slate-300 bg-white"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <MapPin
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            active ? "text-[#00843D]" : "text-slate-400"
                          }`}
                        />
                        <div>
                          <div className="text-sm font-bold text-slate-900">{clinic.name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{clinic.address}</div>
                          <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {clinic.hours}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Fecha deseada
                  </label>
                  <input
                    type="date"
                    value={preferredDate}
                    onChange={(e) => setPreferredDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00843D]/30 focus:border-[#00843D]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Horario preferido
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {TIME_SLOTS.map((slot) => (
                      <button
                        key={slot}
                        type="button"
                        onClick={() => setPreferredTime(slot)}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition ${
                          preferredTime === slot
                            ? "bg-[#0066B3] text-white border-[#0066B3]"
                            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        {slot}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm sticky top-24 space-y-4">
              <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3">
                Resumen de tu estudio
              </h3>
              {selectedStudy && (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="text-xs text-slate-400">Estudio seleccionado</div>
                    <div className="font-bold text-slate-900">{selectedStudy.name}</div>
                  </div>
                  {selectedClinic && (
                    <div>
                      <div className="text-xs text-slate-400">Clínica</div>
                      <div className="font-semibold text-slate-800">{selectedClinic.name}</div>
                      <div className="text-xs text-slate-500">{selectedClinic.city}</div>
                    </div>
                  )}
                  <div>
                    <div className="text-xs text-slate-400">Cita tentativa</div>
                    <div className="font-semibold text-slate-800">
                      {preferredDate} · {preferredTime} hrs
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#EBF4FC] text-[#005291] text-xs leading-relaxed">
                    <strong>Preparación:</strong> {selectedStudy.prep}
                  </div>
                  <div className="pt-3 border-t border-slate-100 flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-slate-500">Precio en clínica</span>
                    <span className="text-xl font-extrabold text-[#00843D]">
                      {formatMoney(selectedStudy.price)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#00843D] bg-[#E6F4EC] px-3 py-1.5 rounded-lg font-medium">
                    Ahorra 10% pagando en línea ({formatMoney(basePrice - onlineDiscount)})
                  </div>
                </div>
              )}

              <button
                type="button"
                disabled={!selectedStudy || !selectedClinic}
                onClick={() => {
                  setStep(2);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                className="w-full bg-[#00843D] hover:bg-[#006E32] text-white font-bold py-3 px-4 rounded-xl transition shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                Continuar al pre-registro
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== PASO 2: PRE-REGISTRO MULTIBENEFICIARIO ("Perfil del paciente") ==================== */}
      {step === 2 && (
        <div className="max-w-2xl mx-auto space-y-4">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 font-semibold"
          >
            <ArrowLeft className="w-4 h-4" />
            Cambiar estudio o clínica ({selectedStudy?.name})
          </button>

          {/* Selector ¿Para quién es este estudio? (Titular vs Familiar/Conocido) */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-3">
            <div className="text-sm font-bold text-slate-900">¿Para quién es este estudio?</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={applySelfPreset}
                className={`p-3.5 rounded-xl border text-left transition flex items-center gap-3 ${
                  !forThirdParty
                    ? "border-[#00843D] bg-[#E6F4EC] text-[#005A2B] ring-1 ring-[#00843D]"
                    : "border-slate-200 hover:border-slate-300 text-slate-700"
                }`}
              >
                <div className="w-9 h-9 rounded-lg bg-white border border-slate-200/80 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-[#00843D]" />
                </div>
                <div>
                  <div className="text-sm font-bold">Para mí (Titular)</div>
                  <div className="text-[11px] opacity-80">Usar mis datos de paciente</div>
                </div>
              </button>

              <button
                type="button"
                onClick={applyThirdPartyBlank}
                className={`p-3.5 rounded-xl border text-left transition flex items-center gap-3 ${
                  forThirdParty
                    ? "border-[#00843D] bg-[#E6F4EC] text-[#005A2B] ring-1 ring-[#00843D]"
                    : "border-slate-200 hover:border-slate-300 text-slate-700"
                }`}
              >
                <div className="w-9 h-9 rounded-lg bg-white border border-slate-200/80 flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4 text-[#0066B3]" />
                </div>
                <div>
                  <div className="text-sm font-bold">Para un familiar o conocido</div>
                  <div className="text-[11px] opacity-80">Expediente clínico separado</div>
                </div>
              </button>
            </div>

            {forThirdParty && (
              <div className="pt-2 space-y-3 border-t border-slate-100">
                {savedBeneficiaries.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-slate-600">
                      O selecciona un familiar ya registrado:
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {savedBeneficiaries.map((b) => (
                        <button
                          key={b.relationshipId}
                          type="button"
                          onClick={() => applyBeneficiaryPreset(b)}
                          className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-[#E6F4EC] hover:text-[#005A2B] text-xs font-semibold text-slate-700 transition"
                        >
                          {b.nombres} {b.apellido_paterno} ({b.relationshipLabel})
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Parentesco / Relación con el titular *
                  </label>
                  <select
                    value={relationship}
                    onChange={(e) => setRelationship(e.target.value as RelationshipType)}
                    className="w-full h-11 rounded-md border border-[#CBD5E1] bg-white px-3 text-sm text-slate-800 focus:outline-none focus:border-[#00843D]"
                  >
                    {RELATIONSHIP_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {!loggedPatient && (
            <div className="p-3.5 rounded-xl bg-[#EBF4FC] border border-blue-200/80 text-[#005291] text-xs flex flex-wrap items-center justify-between gap-2">
              <span>
                ¿Ya tienes cuenta en Salud Digna? Inicia sesión para cargar tus datos y familiares.
              </span>
              <Link
                to="/login?next=/laboratorio"
                className="font-bold underline hover:text-[#003c6b]"
              >
                Iniciar sesión
              </Link>
            </div>
          )}

          {submitError && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Formulario oficial "Perfil del paciente" */}
          <form
            onSubmit={handleSubmitProfileAndQuote}
            className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 sm:px-8 py-7 text-[#475569]"
          >
            <h2 className="text-[22px] font-bold text-[#4B5563] leading-snug">
              {forThirdParty ? "Perfil del paciente beneficiario" : "Perfil del paciente"}
            </h2>
            <p className="text-[15px] text-[#4B5563] mt-2 leading-relaxed">
              Recuerda que los datos deben coincidir con la identificación oficial de quien se
              realizará el estudio, ya que para ciertos estudios se requiere presentarla.
            </p>

            <h3 className="text-[17px] font-bold text-[#4B5563] mt-6 mb-4">Datos personales</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <input
                type="text"
                required
                value={nombres}
                onChange={(e) => {
                  setCurpManuallyEdited(false);
                  setNombres(e.target.value);
                }}
                placeholder="Nombre(s) *"
                className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              />
              <input
                type="text"
                required
                value={apellidoPaterno}
                onChange={(e) => {
                  setCurpManuallyEdited(false);
                  setApellidoPaterno(e.target.value);
                }}
                placeholder="Apellido paterno *"
                className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mt-4">
              <input
                type="text"
                value={apellidoMaterno}
                onChange={(e) => {
                  setCurpManuallyEdited(false);
                  setApellidoMaterno(e.target.value);
                }}
                placeholder="Apellido materno"
                className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              />

              <div className="relative">
                <label
                  htmlFor="sd-fecha-nacimiento"
                  className="absolute -top-2.5 left-3 bg-white px-1 text-[12px] font-medium text-[#64748B] z-10 pointer-events-none"
                >
                  Fecha de nacimiento *
                </label>
                <div
                  onClick={() => dateInputRef.current?.showPicker?.()}
                  className="relative w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 flex items-center justify-between bg-white focus-within:border-[#00843D] focus-within:ring-1 focus-within:ring-[#00843D] cursor-pointer"
                >
                  <span
                    className={`text-[15px] select-none ${
                      fechaNacimiento ? "text-slate-800" : "text-[#475569]"
                    }`}
                  >
                    {formatDateDisplay(fechaNacimiento)}
                  </span>
                  <Calendar className="w-5 h-5 text-[#0072CE] shrink-0 pointer-events-none" />
                  <input
                    ref={dateInputRef}
                    id="sd-fecha-nacimiento"
                    type="date"
                    required
                    value={fechaNacimiento}
                    onChange={(e) => {
                      setCurpManuallyEdited(false);
                      setFechaNacimiento(e.target.value);
                    }}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-12 gap-3 mt-5 items-center">
              <button
                type="button"
                onClick={() => {
                  setCurpManuallyEdited(false);
                  setGenero("FEMENINO");
                }}
                className={`sm:col-span-3 h-12 rounded-md border px-3 flex items-center justify-center gap-2 text-[15px] font-medium transition ${
                  genero === "FEMENINO"
                    ? "border-[#00843D] bg-[#E6F4EC] text-[#005A2B] ring-1 ring-[#00843D]"
                    : "border-[#CBD5E1] bg-white text-[#475569] hover:border-slate-400"
                }`}
              >
                <FemaleIcon className="w-5 h-5 shrink-0" />
                <span>Mujer</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setCurpManuallyEdited(false);
                  setGenero("MASCULINO");
                }}
                className={`sm:col-span-3 h-12 rounded-md border px-3 flex items-center justify-center gap-2 text-[15px] font-medium transition ${
                  genero === "MASCULINO"
                    ? "border-[#00843D] bg-[#E6F4EC] text-[#005A2B] ring-1 ring-[#00843D]"
                    : "border-[#CBD5E1] bg-white text-[#475569] hover:border-slate-400"
                }`}
              >
                <MaleIcon className="w-5 h-5 shrink-0" />
                <span>Hombre</span>
              </button>

              <div className="col-span-2 sm:col-span-6">
                <select
                  required
                  value={estadoNacimientoCode}
                  onChange={(e) => {
                    setCurpManuallyEdited(false);
                    setEstadoNacimientoCode(e.target.value);
                  }}
                  className="w-full h-12 rounded-md border border-[#CBD5E1] bg-white px-3 text-[15px] text-[#334155] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
                >
                  <option value="">Seleccione estado de nacimiento</option>
                  {MEXICAN_STATES.map((st) => (
                    <option key={st.code} value={st.code}>
                      {st.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="text-[14.5px] text-[#4B5563] mt-5 leading-relaxed">
              Al seleccionar el estado de nacimiento, consultaremos tu CURP automáticamente.
            </p>

            <div className="mt-4">
              <label className="block text-[14px] font-semibold text-[#1E293B] mb-1.5">
                País *
              </label>
              <select
                required
                value={pais}
                onChange={(e) => setPais(e.target.value)}
                className="w-full h-12 rounded-md border border-[#CBD5E1] bg-[#F1F5F9] px-3.5 text-[15px] text-[#334155] focus:outline-none focus:bg-white focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              >
                <option value="MÉXICO">MÉXICO</option>
                <option value="ESTADOS UNIDOS">ESTADOS UNIDOS</option>
                <option value="OTRO">OTRO</option>
              </select>
            </div>

            <div className="mt-4">
              <label className="block text-[14px] font-semibold text-[#1E293B] mb-1.5">
                CURP *
              </label>
              <input
                type="text"
                required
                maxLength={18}
                value={curp}
                onChange={(e) => {
                  setCurpManuallyEdited(true);
                  setCurp(e.target.value.toUpperCase());
                }}
                placeholder="Se generará automáticamente"
                className="w-full h-12 rounded-md border border-[#CBD5E1] bg-[#F1F5F9] px-3.5 text-[15px] font-medium tracking-wide text-[#334155] placeholder:text-[#64748B] placeholder:font-normal placeholder:tracking-normal focus:outline-none focus:bg-white focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              />
            </div>

            <div className="mt-5">
              <input
                type="tel"
                required
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder={
                  forThirdParty
                    ? "Teléfono de contacto del titular *"
                    : "Teléfono *"
                }
                className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
              />
            </div>

            {forThirdParty && (
              <label className="mt-5 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={thirdPartyConsent}
                  onChange={(e) => setThirdPartyConsent(e.target.checked)}
                  className="mt-1 w-4 h-4 accent-[#00843D]"
                />
                <span className="text-xs text-amber-950 leading-relaxed">
                  <strong className="inline-flex items-center gap-1">
                    <Lock className="w-3.5 h-3.5" />
                    Aviso de privacidad para citas de terceros:
                  </strong>{" "}
                  Confirmo contar con autorización del beneficiario para gestionar esta cita. Su
                  expediente clínico y CURP quedarán resguardados de forma independiente y mi cuenta
                  únicamente mostrará el estatus operativo de esta solicitud. *
                </span>
              </label>
            )}

            <p className="text-[14px] text-[#4B5563] mt-3">* Estos campos son obligatorios.</p>

            <div className="mt-6 flex justify-end">
              <button
                type="submit"
                disabled={!isProfileValid || submitting}
                className={`min-w-[240px] h-12 px-8 rounded-md font-semibold text-[15px] text-white transition ${
                  isProfileValid && !submitting
                    ? "bg-[#00843D] hover:bg-[#006E32] shadow-sm cursor-pointer"
                    : "bg-[#A1A8B0] cursor-not-allowed"
                }`}
              >
                {submitting ? "Guardando..." : "Continuar"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ==================== PASO 3: RESUMEN, PAGO, CONFIRMACIÓN Y GUARDADO ==================== */}
      {step === 3 && activeCase && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-5">
            {confirmedFolio ? (
              <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-6 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase text-[#00843D]">
                      <CheckCircle2 className="w-4 h-4" />
                      ¡Cita confirmada con éxito!
                    </div>
                    <h2 className="text-2xl font-extrabold font-mono text-[#005A2B]">
                      {confirmedFolio.folio}
                    </h2>
                    <p className="text-xs text-slate-600">
                      Presenta este folio o código QR en recepción. También enviamos tu confirmación
                      a WhatsApp.
                    </p>
                  </div>
                  <div className="p-3 bg-white rounded-xl border border-emerald-200 shadow-sm shrink-0 self-start">
                    <QrCode className="w-16 h-16 text-[#005A2B]" />
                  </div>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Link
                    to="/mi-cuenta"
                    className="inline-flex items-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-5 py-3 rounded-xl text-sm shadow-sm transition"
                  >
                    Ver en Mis Citas
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                  <Link
                    to="/"
                    className="inline-flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 font-semibold px-4 py-3 rounded-xl text-sm transition"
                  >
                    Volver al inicio
                  </Link>
                </div>
              </div>
            ) : savedForLater ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 text-[#00843D] flex items-center justify-center shrink-0">
                    <BookmarkCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-extrabold text-slate-900">
                      Guardamos tu cotización para continuar después
                    </h2>
                    <p className="text-sm text-slate-700 mt-1 leading-relaxed">
                      Conservamos tu estudio (
                      <strong>{activeCase.contextJson.study?.name}</strong>), clínica (
                      <strong>{activeCase.contextJson.clinic?.name}</strong>) y tus datos. Podrás
                      retomar y concluir tu cita en cualquier momento desde{" "}
                      <strong>Mi Cuenta</strong>, por <strong>WhatsApp</strong> o llamando a nuestro{" "}
                      <strong>Call Center</strong> sin volver a llenar ningún formulario.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 pt-2">
                  <Link
                    to={loggedPatient ? "/mi-cuenta" : "/registro"}
                    className="inline-flex items-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-5 py-3 rounded-xl text-sm shadow-sm transition"
                  >
                    {loggedPatient ? "Ir a Mis Citas" : "Crear cuenta para ver mis citas"}
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                  <Link
                    to="/"
                    className="inline-flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 font-semibold px-4 py-3 rounded-xl text-sm transition"
                  >
                    Volver al inicio
                  </Link>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-5">
                <div className="flex items-center gap-2 text-[#00843D] text-sm font-bold">
                  <CheckCircle2 className="w-5 h-5" />
                  Pre-registro sincronizado en todos tus canales
                </div>

                <div>
                  <h2 className="text-lg font-bold text-slate-900">Elige tu forma de pago</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Al pagar en línea obtienes 10% de descuento y recepción preferencial en clínica.
                  </p>
                </div>

                <div className="space-y-3">
                  <PaymentOptionCard
                    selected={paymentMethod === "online"}
                    onSelect={() => setPaymentMethod("online")}
                    title="Pago en línea con tarjeta (Visa / Mastercard)"
                    subtitle="Aplica 10% de descuento automático y recepción express en clínica"
                    badge="-10% ahorro"
                    icon={<CreditCard className="w-5 h-5 text-[#00843D]" />}
                  />
                  <PaymentOptionCard
                    selected={paymentMethod === "oxxo"}
                    onSelect={() => setPaymentMethod("oxxo")}
                    title="Pago en efectivo con OXXO Pay"
                    subtitle="Genera una referencia para pagar en tiendas OXXO antes de tu cita"
                    icon={<Store className="w-5 h-5 text-[#0066B3]" />}
                  />
                  <PaymentOptionCard
                    selected={paymentMethod === "clinic"}
                    onSelect={() => setPaymentMethod("clinic")}
                    title="Pagar en clínica el día de tu cita"
                    subtitle="Efectivo o tarjeta directamente en recepción de Salud Digna"
                    icon={<Building2 className="w-5 h-5 text-slate-600" />}
                  />
                </div>

                {submitError && (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">
                    {submitError}
                  </div>
                )}

                <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={savingLater || confirming}
                    onClick={handleSaveForLater}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-sm transition disabled:opacity-60"
                  >
                    <BookmarkCheck className="w-4 h-4 text-[#0066B3]" />
                    {savingLater ? "Guardando avance..." : "Guardar y continuar después"}
                  </button>

                  <button
                    type="button"
                    disabled={confirming || savingLater}
                    onClick={handleConfirmOnline}
                    className="inline-flex items-center justify-center gap-2 bg-[#00843D] hover:bg-[#006E32] text-white font-bold px-6 py-3 rounded-xl text-sm shadow-sm transition disabled:opacity-60"
                  >
                    {confirming
                      ? "Confirmando cita..."
                      : `Confirmar cita (${formatMoney(finalPrice)})`}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
              <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3">
                Resumen de tu cita
              </h3>

              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Paciente</span>
                  <span className="font-bold text-slate-900 text-right">
                    {[nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ") ||
                      activeCase.contextJson.handoff_summary?.split(" ")[0] ||
                      "Paciente"}
                  </span>
                </div>
                {forThirdParty && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Parentesco</span>
                    <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 text-xs font-bold">
                      {RELATIONSHIP_OPTIONS.find((r) => r.value === relationship)?.label}
                    </span>
                  </div>
                )}
                {curp && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">CURP</span>
                    <span className="font-mono text-xs font-semibold text-slate-800">{curp}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2 pt-2 border-t border-slate-100">
                  <span className="text-slate-500">Estudio</span>
                  <span className="font-semibold text-slate-900 text-right">
                    {activeCase.contextJson.study?.name}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Clínica</span>
                  <span className="font-semibold text-slate-900 text-right">
                    {activeCase.contextJson.clinic?.name}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Horario</span>
                  <span className="font-semibold text-slate-900">
                    {preferredDate} · {preferredTime} hrs
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-500">
                  <span>Subtotal</span>
                  <span>{formatMoney(basePrice)}</span>
                </div>
                {paymentMethod === "online" && (
                  <div className="flex justify-between text-[#00843D] font-medium">
                    <span>Descuento pago en línea (10%)</span>
                    <span>-{formatMoney(onlineDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-extrabold text-slate-900 pt-1">
                  <span>Total a pagar</span>
                  <span className="text-[#00843D]">{formatMoney(finalPrice)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FemaleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="5.5" r="2.2" />
    <path d="M9.5 10.5c0-1 .8-1.8 1.8-1.8h1.4c1 0 1.8.8 1.8 1.8l1.3 5.5H8.2l1.3-5.5Z" />
    <path d="M10.5 16v4.5M13.5 16v4.5" />
  </svg>
);

const MaleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="5.5" r="2.2" />
    <path d="M9.5 10.5c0-1 .8-1.8 1.8-1.8h1.4c1 0 1.8.8 1.8 1.8v5h-5v-5Z" />
    <path d="M10.5 15.5v5M13.5 15.5v5" />
  </svg>
);

interface PaymentOptionCardProps {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  badge?: string;
  icon: React.ReactNode;
}

const PaymentOptionCard: React.FC<PaymentOptionCardProps> = ({
  selected,
  onSelect,
  title,
  subtitle,
  badge,
  icon,
}) => (
  <button
    type="button"
    onClick={onSelect}
    className={`w-full text-left p-4 rounded-xl border transition flex items-start gap-3.5 ${
      selected
        ? "border-[#00843D] bg-[#E6F4EC]/50 ring-1 ring-[#00843D]"
        : "border-slate-200 hover:border-slate-300 bg-white"
    }`}
  >
    <div className="p-2 rounded-lg bg-slate-50 border border-slate-100 shrink-0">{icon}</div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-sm text-slate-900">{title}</span>
        {badge && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#00843D] text-white shrink-0">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
    </div>
  </button>
);
