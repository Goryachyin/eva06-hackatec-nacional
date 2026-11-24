import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QrCode } from "lucide-react";
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

function getPreparationSteps(prepText: string): string[] {
  const parts = prepText
    .split(/\.|;/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;
  return [
    prepText.trim(),
    "Presentar identificación oficial vigente y folio de cita en recepción 15 minutos antes.",
  ];
}

export const LaboratorioPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initialCat = searchParams.get("cat") || "Todos";
  const initialQuery = searchParams.get("q") || "";
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
  const [studyQuery, setStudyQuery] = useState<string>(initialQuery);

  // Paso 1: Estudio, Clínica y Horario
  const [selectedStudyCode, setSelectedStudyCode] = useState<string>("US-OBS");
  const [selectedClinicId, setSelectedClinicId] = useState<string>("CLN-CUL-01");
  const [preferredDate, setPreferredDate] = useState<string>(() => {
    const tomorrow = new Date(Date.now() + 86400000);
    return tomorrow.toISOString().slice(0, 10);
  });
  const [preferredTime, setPreferredTime] = useState<string>("09:30");

  // Selector Multibeneficiario
  const [forThirdParty, setForThirdParty] = useState<boolean>(Boolean(forBeneficiaryParam));
  const [relationship, setRelationship] = useState<RelationshipType>("HIJO_A");
  const [thirdPartyConsent, setThirdPartyConsent] = useState<boolean>(false);

  // Paso 2: Campos oficiales "Perfil del paciente"
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

  // Paso 3: Pago, Confirmación y Guardado
  const [paymentMethod, setPaymentMethod] = useState<"online" | "oxxo" | "clinic">("online");
  const [savedForLater, setSavedForLater] = useState(false);
  const [savingLater, setSavingLater] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

          if (forBeneficiaryParam) {
            const foundB = (meRes.beneficiaries || []).find(
              (b) => b.beneficiaryId === forBeneficiaryParam
            );
            if (foundB) {
              applyBeneficiaryPreset(foundB);
            }
          }

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
    setTelefono(loggedPatient?.telefono || telefono);
  };

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
    const q = studyQuery.trim().toLowerCase();
    return studies.filter((s) => {
      const catOk = selectedCategory === "Todos" || s.category === selectedCategory;
      if (!catOk) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.prep.toLowerCase().includes(q)
      );
    });
  }, [studies, selectedCategory, studyQuery]);

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
      window.scrollTo({ top: 0 });
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
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-10 bg-[#FFFFFF] text-[#1F2933]">
      {/* Encabezado y barra de pasos plana */}
      <header className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Estudios y citas en línea
            </p>
            <h1 className="text-3xl font-bold text-[#1F2933] mt-1">
              Agenda tus estudios de laboratorio e imagenología
            </h1>
          </div>
          {activeCase && (
            <p className="text-xs text-[#52606D]">
              Estatus actual:{" "}
              <strong className={STATE_META[activeCase.currentState].textClass}>
                {STATE_META[activeCase.currentState].label}
              </strong>
            </p>
          )}
        </div>

        <ol className="grid grid-cols-3 border-t border-b border-[#E4E7EB]">
          {[
            { num: 1 as WizardStep, title: "Estudio y clínica" },
            { num: 2 as WizardStep, title: "Pre-registro" },
            { num: 3 as WizardStep, title: "Resumen y pago" },
          ].map((item) => {
            const isCurrent = step === item.num;
            const isDone = step > item.num;
            return (
              <li key={item.num} className="border-r last:border-r-0 border-[#E4E7EB]">
                <button
                  type="button"
                  disabled={item.num === 3 && !activeCase}
                  onClick={() => {
                    if (item.num <= step || (item.num === 2 && selectedStudy)) {
                      setStep(item.num);
                    }
                  }}
                  className={`w-full text-left py-4 px-3 sm:px-5 border-b-2 transition-colors ${
                    isCurrent
                      ? "border-[#00875A] text-[#00875A]"
                      : isDone
                      ? "border-transparent text-[#1F2933] hover:text-[#00875A]"
                      : "border-transparent text-[#52606D] disabled:opacity-50"
                  }`}
                >
                  <small className="block text-[11px] uppercase tracking-wider font-semibold">
                    Paso 0{item.num} {isDone ? "· Completado" : ""}
                  </small>
                  <strong className="block text-sm font-semibold mt-0.5 truncate">
                    {item.title}
                  </strong>
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      {catalogError && (
        <p className="border-l-2 border-[#B42318] pl-4 py-2 text-sm text-[#B42318]">
          {catalogError}
        </p>
      )}

      {/* ==================== PASO 1: ESTUDIO, PREPARACIÓN Y CLÍNICA ==================== */}
      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          {/* Columna izquierda: Catálogo en lista vertical + Clínica y horarios en cuadrícula plana */}
          <div className="lg:col-span-8 space-y-12">
            <section className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-[#1F2933]">1. Elige tu estudio</h2>
                  <p className="text-sm text-[#52606D] mt-1">
                    Precios vigentes e indicaciones previas a tu cita
                  </p>
                </div>
                <input
                  type="search"
                  value={studyQuery}
                  onChange={(e) => setStudyQuery(e.target.value)}
                  placeholder="Filtrar estudio..."
                  aria-label="Filtrar estudios"
                  className="h-10 w-full sm:w-64 px-3 border border-[#E4E7EB] text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                />
              </div>

              {/* Filtros de categoría planos con indicador inferior verde */}
              <div className="flex flex-wrap gap-5 border-b border-[#E4E7EB]">
                {categories.map((cat) => {
                  const active = selectedCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`pb-2.5 text-sm border-b-2 transition-colors ${
                        active
                          ? "border-[#00875A] text-[#00875A] font-semibold"
                          : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>

              {catalogLoading ? (
                <p className="py-10 text-sm text-[#52606D]">Cargando catálogo de estudios...</p>
              ) : filteredStudies.length === 0 ? (
                <p className="py-10 text-sm text-[#52606D]">
                  No se encontraron estudios con el filtro aplicado.
                </p>
              ) : (
                <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
                  {filteredStudies.map((study) => {
                    const active = study.code === selectedStudyCode;
                    return (
                      <li
                        key={study.code}
                        className={`py-5 pl-4 border-l-2 transition-colors ${
                          active ? "border-[#00875A]" : "border-transparent"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                          <div className="space-y-1 max-w-xl">
                            <small className="block text-[11px] font-semibold uppercase tracking-wider text-[#00875A]">
                              {study.category}
                            </small>
                            <h3 className="text-base font-bold text-[#1F2933]">{study.name}</h3>
                            <p className="text-sm text-[#52606D] leading-relaxed">{study.prep}</p>
                          </div>
                          <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
                            <strong className="text-lg font-bold text-[#1F2933]">
                              {formatMoney(study.price)}
                            </strong>
                            <button
                              type="button"
                              onClick={() => setSelectedStudyCode(study.code)}
                              className={`px-3.5 py-1.5 text-xs font-semibold border transition-colors ${
                                active
                                  ? "bg-[#00875A] border-[#00875A] text-[#FFFFFF]"
                                  : "bg-[#FFFFFF] border-[#E4E7EB] text-[#00875A] hover:border-[#00875A]"
                              }`}
                            >
                              {active ? "Seleccionado" : "Seleccionar"}
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Selección de clínica en lista vertical limpia + horarios en cuadrícula plana 1px */}
            <section className="space-y-6">
              <div className="pb-4 border-b border-[#E4E7EB]">
                <h2 className="text-xl font-bold text-[#1F2933]">
                  2. Selecciona clínica, fecha y horario
                </h2>
                <p className="text-sm text-[#52606D] mt-1">
                  Elige la sucursal más cercana y tu horario preferido
                </p>
              </div>

              <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
                {clinics.map((clinic) => {
                  const active = clinic.id === selectedClinicId;
                  return (
                    <li
                      key={clinic.id}
                      className={`py-4 pl-4 border-l-2 ${
                        active ? "border-[#00875A]" : "border-transparent"
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-[#1F2933]">{clinic.name}</h3>
                          <p className="text-xs text-[#52606D] mt-0.5">{clinic.address}</p>
                          <p className="text-xs text-[#52606D] mt-0.5">{clinic.hours}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedClinicId(clinic.id)}
                          className={`self-start sm:self-center px-3.5 py-1.5 text-xs font-semibold border transition-colors shrink-0 ${
                            active
                              ? "bg-[#00875A] border-[#00875A] text-[#FFFFFF]"
                              : "bg-[#FFFFFF] border-[#E4E7EB] text-[#00875A] hover:border-[#00875A]"
                          }`}
                        >
                          {active ? "Clínica elegida" : "Elegir clínica"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-6 pt-2">
                <div className="sm:col-span-5">
                  <label
                    htmlFor="preferred-date-input"
                    className="block text-xs font-semibold text-[#1F2933] mb-2"
                  >
                    Fecha deseada
                  </label>
                  <input
                    id="preferred-date-input"
                    type="date"
                    value={preferredDate}
                    onChange={(e) => setPreferredDate(e.target.value)}
                    className="w-full h-11 border border-[#E4E7EB] px-3 text-sm text-[#1F2933] focus:border-[#00875A]"
                  />
                </div>
                <div className="sm:col-span-7">
                  <p className="text-xs font-semibold text-[#1F2933] mb-2">Horario preferido</p>
                  <div className="grid grid-cols-4 sm:grid-cols-4 border-t border-l border-[#E4E7EB]">
                    {TIME_SLOTS.map((slot) => {
                      const active = preferredTime === slot;
                      return (
                        <button
                          key={slot}
                          type="button"
                          onClick={() => setPreferredTime(slot)}
                          className={`h-11 text-xs font-semibold border-r border-b border-[#E4E7EB] transition-colors ${
                            active
                              ? "bg-[#00875A] text-[#FFFFFF]"
                              : "bg-[#FFFFFF] text-[#1F2933] hover:bg-[#F7F8F9]"
                          }`}
                        >
                          {slot}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Columna derecha: Detalle, preparación (<ol>), precio y botón principal naranja */}
          <aside className="lg:col-span-4 lg:border-l lg:border-[#E4E7EB] lg:pl-8 lg:sticky lg:top-24 space-y-6">
            <h2 className="text-lg font-bold text-[#1F2933] pb-3 border-b border-[#E4E7EB]">
              Resumen y preparación
            </h2>

            {selectedStudy && (
              <>
                <dl className="divide-y divide-[#E4E7EB] text-sm">
                  <div className="py-3">
                    <dt className="text-xs text-[#52606D]">Estudio seleccionado</dt>
                    <dd className="font-semibold text-[#1F2933] mt-0.5">{selectedStudy.name}</dd>
                  </div>
                  {selectedClinic && (
                    <div className="py-3">
                      <dt className="text-xs text-[#52606D]">Clínica</dt>
                      <dd className="font-semibold text-[#1F2933] mt-0.5">{selectedClinic.name}</dd>
                      <dd className="text-xs text-[#52606D]">{selectedClinic.city}</dd>
                    </div>
                  )}
                  <div className="py-3">
                    <dt className="text-xs text-[#52606D]">Cita tentativa</dt>
                    <dd className="font-semibold text-[#1F2933] mt-0.5">
                      <time dateTime={`${preferredDate}T${preferredTime}`}>
                        {preferredDate} · {preferredTime} hrs
                      </time>
                    </dd>
                  </div>
                </dl>

                <div className="pt-2 border-t border-[#E4E7EB] space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                    Indicaciones de preparación
                  </h3>
                  <ol className="list-decimal pl-5 space-y-1.5 text-xs text-[#52606D] leading-relaxed">
                    {getPreparationSteps(selectedStudy.prep).map((instruction, index) => (
                      <li key={index}>{instruction}</li>
                    ))}
                  </ol>
                </div>

                <div className="pt-4 border-t border-[#E4E7EB] space-y-1">
                  <div className="flex items-baseline justify-between">
                    <p className="text-xs text-[#52606D]">Precio en clínica</p>
                    <strong className="text-2xl font-bold text-[#1F2933]">
                      {formatMoney(selectedStudy.price)}
                    </strong>
                  </div>
                  <p className="text-xs font-medium text-[#00875A]">
                    Pagando en línea: {formatMoney(basePrice - onlineDiscount)} (10% de ahorro)
                  </p>
                </div>
              </>
            )}

            <button
              type="button"
              disabled={!selectedStudy || !selectedClinic}
              onClick={() => {
                setStep(2);
                window.scrollTo({ top: 0 });
              }}
              className="w-full h-12 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50"
            >
              Continuar al pre-registro
            </button>
          </aside>
        </div>
      )}

      {/* ==================== PASO 2: PRE-REGISTRO MULTIBENEFICIARIO ==================== */}
      {step === 2 && (
        <div className="max-w-2xl space-y-8">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="text-xs font-semibold text-[#00875A] hover:underline"
          >
            ← Cambiar estudio o clínica ({selectedStudy?.name})
          </button>

          {/* Selector ¿Para quién es este estudio? */}
          <section className="space-y-4 pb-6 border-b border-[#E4E7EB]">
            <h2 className="text-lg font-bold text-[#1F2933]">¿Para quién es este estudio?</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 border border-[#E4E7EB]">
              <button
                type="button"
                onClick={applySelfPreset}
                className={`p-4 text-left border-b sm:border-b-0 sm:border-r border-[#E4E7EB] transition-colors ${
                  !forThirdParty
                    ? "bg-[#00875A] text-[#FFFFFF]"
                    : "bg-[#FFFFFF] text-[#1F2933] hover:bg-[#F7F8F9]"
                }`}
              >
                <strong className="block text-sm font-semibold">Para mí (Titular)</strong>
                <small
                  className={`block text-xs mt-0.5 ${
                    !forThirdParty ? "text-[#FFFFFF]" : "text-[#52606D]"
                  }`}
                >
                  Usar mis datos de paciente
                </small>
              </button>

              <button
                type="button"
                onClick={applyThirdPartyBlank}
                className={`p-4 text-left transition-colors ${
                  forThirdParty
                    ? "bg-[#00875A] text-[#FFFFFF]"
                    : "bg-[#FFFFFF] text-[#1F2933] hover:bg-[#F7F8F9]"
                }`}
              >
                <strong className="block text-sm font-semibold">
                  Para un familiar o conocido
                </strong>
                <small
                  className={`block text-xs mt-0.5 ${
                    forThirdParty ? "text-[#FFFFFF]" : "text-[#52606D]"
                  }`}
                >
                  Expediente clínico independiente
                </small>
              </button>
            </div>

            {forThirdParty && (
              <div className="space-y-4 pt-2">
                {savedBeneficiaries.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-[#52606D]">
                      O selecciona un familiar ya registrado:
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {savedBeneficiaries.map((b) => (
                        <li key={b.relationshipId}>
                          <button
                            type="button"
                            onClick={() => applyBeneficiaryPreset(b)}
                            className="px-3 py-1.5 border border-[#E4E7EB] text-xs font-semibold text-[#00875A] hover:border-[#00875A] transition-colors"
                          >
                            {b.nombres} {b.apellido_paterno} ({b.relationshipLabel})
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="lab-relationship"
                    className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                  >
                    Parentesco / Relación con el titular *
                  </label>
                  <select
                    id="lab-relationship"
                    value={relationship}
                    onChange={(e) => setRelationship(e.target.value as RelationshipType)}
                    className="w-full h-11 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-sm text-[#1F2933] focus:border-[#00875A]"
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
          </section>

          {!loggedPatient && (
            <p className="border-l-2 border-[#00875A] pl-4 py-1 text-xs text-[#52606D]">
              ¿Ya tienes cuenta en Salud Digna?{" "}
              <Link to="/login?next=/laboratorio" className="font-semibold text-[#00875A] underline">
                Inicia sesión para precargar tus datos y familiares
              </Link>
              .
            </p>
          )}

          {submitError && (
            <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">
              {submitError}
            </p>
          )}

          {/* Formulario oficial "Perfil del paciente" */}
          <form onSubmit={handleSubmitProfileAndQuote} className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-[#1F2933]">
                {forThirdParty ? "Perfil del paciente beneficiario" : "Perfil del paciente"}
              </h2>
              <p className="text-sm text-[#52606D] mt-1 leading-relaxed">
                Los datos deben coincidir con la identificación oficial de quien se realizará el
                estudio.
              </p>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-[#00875A]">
                Datos personales
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="lab-nombres" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                    Nombre(s) *
                  </label>
                  <input
                    id="lab-nombres"
                    type="text"
                    required
                    value={nombres}
                    onChange={(e) => {
                      setCurpManuallyEdited(false);
                      setNombres(e.target.value);
                    }}
                    placeholder="Nombre(s)"
                    className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                  />
                </div>
                <div>
                  <label htmlFor="lab-paterno" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                    Apellido paterno *
                  </label>
                  <input
                    id="lab-paterno"
                    type="text"
                    required
                    value={apellidoPaterno}
                    onChange={(e) => {
                      setCurpManuallyEdited(false);
                      setApellidoPaterno(e.target.value);
                    }}
                    placeholder="Apellido paterno"
                    className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="lab-materno" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                    Apellido materno
                  </label>
                  <input
                    id="lab-materno"
                    type="text"
                    value={apellidoMaterno}
                    onChange={(e) => {
                      setCurpManuallyEdited(false);
                      setApellidoMaterno(e.target.value);
                    }}
                    placeholder="Apellido materno"
                    className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="sd-fecha-nacimiento"
                    className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                  >
                    Fecha de nacimiento *
                  </label>
                  <div
                    onClick={() => dateInputRef.current?.showPicker?.()}
                    className="relative w-full h-11 border border-[#E4E7EB] px-3.5 flex items-center justify-between bg-[#FFFFFF] cursor-pointer"
                  >
                    <p className="text-sm text-[#1F2933]">{formatDateDisplay(fechaNacimiento)}</p>
                    <small className="text-xs text-[#00875A] font-semibold">Calendario</small>
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

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end">
                <div className="sm:col-span-6">
                  <p className="text-xs font-semibold text-[#1F2933] mb-1.5">Género *</p>
                  <div className="grid grid-cols-2 border border-[#E4E7EB]">
                    <button
                      type="button"
                      onClick={() => {
                        setCurpManuallyEdited(false);
                        setGenero("FEMENINO");
                      }}
                      className={`h-11 text-sm font-semibold border-r border-[#E4E7EB] transition-colors ${
                        genero === "FEMENINO"
                          ? "bg-[#00875A] text-[#FFFFFF]"
                          : "bg-[#FFFFFF] text-[#1F2933] hover:bg-[#F7F8F9]"
                      }`}
                    >
                      Mujer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCurpManuallyEdited(false);
                        setGenero("MASCULINO");
                      }}
                      className={`h-11 text-sm font-semibold transition-colors ${
                        genero === "MASCULINO"
                          ? "bg-[#00875A] text-[#FFFFFF]"
                          : "bg-[#FFFFFF] text-[#1F2933] hover:bg-[#F7F8F9]"
                      }`}
                    >
                      Hombre
                    </button>
                  </div>
                </div>

                <div className="sm:col-span-6">
                  <label
                    htmlFor="lab-estado"
                    className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                  >
                    Estado de nacimiento *
                  </label>
                  <select
                    id="lab-estado"
                    required
                    value={estadoNacimientoCode}
                    onChange={(e) => {
                      setCurpManuallyEdited(false);
                      setEstadoNacimientoCode(e.target.value);
                    }}
                    className="w-full h-11 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-sm text-[#1F2933] focus:border-[#00875A]"
                  >
                    <option value="">Seleccione estado</option>
                    {MEXICAN_STATES.map((st) => (
                      <option key={st.code} value={st.code}>
                        {st.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <p className="text-xs text-[#52606D]">
                Al seleccionar el estado de nacimiento, consultaremos tu CURP automáticamente.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="lab-pais" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                    País *
                  </label>
                  <select
                    id="lab-pais"
                    required
                    value={pais}
                    onChange={(e) => setPais(e.target.value)}
                    className="w-full h-11 border border-[#E4E7EB] bg-[#FFFFFF] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
                  >
                    <option value="MÉXICO">MÉXICO</option>
                    <option value="ESTADOS UNIDOS">ESTADOS UNIDOS</option>
                    <option value="OTRO">OTRO</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="lab-curp" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                    CURP *
                  </label>
                  <input
                    id="lab-curp"
                    type="text"
                    required
                    maxLength={18}
                    value={curp}
                    onChange={(e) => {
                      setCurpManuallyEdited(true);
                      setCurp(e.target.value.toUpperCase());
                    }}
                    placeholder="Se generará automáticamente"
                    className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm font-mono text-[#1F2933] placeholder:font-sans placeholder:text-[#52606D] focus:border-[#00875A]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="lab-tel" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                  {forThirdParty ? "Teléfono de contacto del titular *" : "Teléfono *"}
                </label>
                <input
                  id="lab-tel"
                  type="tel"
                  required
                  value={telefono}
                  onChange={(e) => setTelefono(e.target.value)}
                  placeholder="10 dígitos o +52..."
                  className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                />
              </div>

              {forThirdParty && (
                <label className="block border-t border-b border-[#E4E7EB] py-4 cursor-pointer">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={thirdPartyConsent}
                      onChange={(e) => setThirdPartyConsent(e.target.checked)}
                      className="mt-1 w-4 h-4 accent-[#00875A]"
                    />
                    <p className="text-xs text-[#52606D] leading-relaxed">
                      <strong className="text-[#1F2933]">
                        Aviso de privacidad para citas de terceros:
                      </strong>{" "}
                      Confirmo contar con autorización del beneficiario para gestionar esta cita. Su
                      expediente clínico y CURP quedarán resguardados de forma independiente. *
                    </p>
                  </div>
                </label>
              )}
            </div>

            <div className="pt-4 border-t border-[#E4E7EB] flex items-center justify-between gap-4">
              <p className="text-xs text-[#52606D]">* Campos obligatorios</p>
              <button
                type="submit"
                disabled={!isProfileValid || submitting}
                className="h-12 px-8 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Guardando..." : "Continuar"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ==================== PASO 3: RESUMEN, PAGO Y CONFIRMACIÓN ==================== */}
      {step === 3 && activeCase && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          <div className="lg:col-span-7 space-y-6">
            {confirmedFolio ? (
              <section className="space-y-6 border-l-2 border-[#00875A] pl-6 py-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                      Cita confirmada
                    </p>
                    <h2 className="text-3xl font-bold font-mono text-[#1F2933]">
                      {confirmedFolio.folio}
                    </h2>
                    <p className="text-sm text-[#52606D]">
                      Presenta este folio o código QR en recepción. También enviamos tu confirmación
                      por WhatsApp.
                    </p>
                  </div>
                  <div className="p-3 border border-[#E4E7EB] self-start shrink-0">
                    <QrCode className="w-16 h-16 text-[#1F2933]" />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-2">
                  <Link
                    to="/mi-cuenta"
                    className="inline-flex items-center justify-center h-12 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors"
                  >
                    Ver en mis citas
                  </Link>
                  <Link
                    to="/"
                    className="text-sm font-semibold text-[#00875A] hover:underline"
                  >
                    Volver al inicio
                  </Link>
                </div>
              </section>
            ) : savedForLater ? (
              <section className="space-y-6 border-l-2 border-[#00875A] pl-6 py-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                    Borrador guardado
                  </p>
                  <h2 className="text-2xl font-bold text-[#1F2933]">
                    Guardamos tu cotización para continuar después
                  </h2>
                  <p className="text-sm text-[#52606D] leading-relaxed">
                    Conservamos tu estudio (
                    <strong className="text-[#1F2933]">{activeCase.contextJson.study?.name}</strong>),
                    clínica (
                    <strong className="text-[#1F2933]">{activeCase.contextJson.clinic?.name}</strong>
                    ) y tus datos. Podrás retomar y concluir tu cita desde Mi cuenta, WhatsApp o
                    Call Center sin volver a llenar formularios.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    to={loggedPatient ? "/mi-cuenta" : "/registro"}
                    className="inline-flex items-center justify-center h-12 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors"
                  >
                    {loggedPatient ? "Ir a mis citas" : "Crear cuenta para ver mis citas"}
                  </Link>
                  <Link
                    to="/"
                    className="text-sm font-semibold text-[#00875A] hover:underline"
                  >
                    Volver al inicio
                  </Link>
                </div>
              </section>
            ) : (
              <section className="space-y-6">
                <div className="pb-4 border-b border-[#E4E7EB]">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                    Pre-registro sincronizado en todos tus canales
                  </p>
                  <h2 className="text-xl font-bold text-[#1F2933] mt-1">Elige tu forma de pago</h2>
                  <p className="text-sm text-[#52606D] mt-1">
                    Al pagar en línea obtienes 10% de descuento y recepción preferencial en clínica.
                  </p>
                </div>

                <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
                  <PaymentOptionRow
                    selected={paymentMethod === "online"}
                    onSelect={() => setPaymentMethod("online")}
                    title="Pago en línea con tarjeta (Visa / Mastercard)"
                    subtitle="Aplica 10% de descuento automático y recepción express en clínica"
                    note="-10% ahorro"
                  />
                  <PaymentOptionRow
                    selected={paymentMethod === "oxxo"}
                    onSelect={() => setPaymentMethod("oxxo")}
                    title="Pago en efectivo con OXXO Pay"
                    subtitle="Genera una referencia para pagar en tiendas OXXO antes de tu cita"
                  />
                  <PaymentOptionRow
                    selected={paymentMethod === "clinic"}
                    onSelect={() => setPaymentMethod("clinic")}
                    title="Pagar en clínica el día de tu cita"
                    subtitle="Efectivo o tarjeta directamente en recepción de Salud Digna"
                  />
                </ul>

                {submitError && (
                  <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">
                    {submitError}
                  </p>
                )}

                <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
                  <button
                    type="button"
                    disabled={savingLater || confirming}
                    onClick={handleSaveForLater}
                    className="h-12 px-5 border border-[#E4E7EB] bg-[#FFFFFF] hover:border-[#1F2933] text-sm font-semibold text-[#1F2933] transition-colors disabled:opacity-50"
                  >
                    {savingLater ? "Guardando avance..." : "Guardar y continuar después"}
                  </button>

                  <button
                    type="button"
                    disabled={confirming || savingLater}
                    onClick={handleConfirmOnline}
                    className="h-12 px-7 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {confirming
                      ? "Confirmando cita..."
                      : `Confirmar cita (${formatMoney(finalPrice)})`}
                  </button>
                </div>
              </section>
            )}
          </div>

          <aside className="lg:col-span-5 lg:border-l lg:border-[#E4E7EB] lg:pl-8 space-y-5">
            <h3 className="text-lg font-bold text-[#1F2933] pb-3 border-b border-[#E4E7EB]">
              Resumen de tu cita
            </h3>

            <dl className="divide-y divide-[#E4E7EB] text-sm">
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-[#52606D]">Paciente</dt>
                <dd className="font-semibold text-[#1F2933] text-right">
                  {[nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ") ||
                    activeCase.contextJson.handoff_summary?.split(" ")[0] ||
                    "Paciente"}
                </dd>
              </div>
              {forThirdParty && (
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#52606D]">Parentesco</dt>
                  <dd className="font-semibold text-[#1F2933]">
                    {RELATIONSHIP_OPTIONS.find((r) => r.value === relationship)?.label}
                  </dd>
                </div>
              )}
              {curp && (
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#52606D]">CURP</dt>
                  <dd className="font-mono text-xs font-semibold text-[#1F2933]">{curp}</dd>
                </div>
              )}
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-[#52606D]">Estudio</dt>
                <dd className="font-semibold text-[#1F2933] text-right">
                  {activeCase.contextJson.study?.name}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-[#52606D]">Clínica</dt>
                <dd className="font-semibold text-[#1F2933] text-right">
                  {activeCase.contextJson.clinic?.name}
                </dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-[#52606D]">Horario</dt>
                <dd className="font-semibold text-[#1F2933]">
                  <time dateTime={`${preferredDate}T${preferredTime}`}>
                    {preferredDate} · {preferredTime} hrs
                  </time>
                </dd>
              </div>
            </dl>

            <dl className="pt-4 border-t border-[#E4E7EB] space-y-2 text-sm">
              <div className="flex justify-between text-[#52606D]">
                <dt>Subtotal</dt>
                <dd>{formatMoney(basePrice)}</dd>
              </div>
              {paymentMethod === "online" && (
                <div className="flex justify-between text-[#00875A] font-medium">
                  <dt>Descuento pago en línea (10%)</dt>
                  <dd>-{formatMoney(onlineDiscount)}</dd>
                </div>
              )}
              <div className="flex justify-between items-baseline pt-3 border-t border-[#E4E7EB]">
                <dt className="text-base font-bold text-[#1F2933]">Total a pagar</dt>
                <dd>
                  <strong className="text-2xl font-bold text-[#1F2933]">
                    {formatMoney(finalPrice)}
                  </strong>
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      )}
    </div>
  );
};

interface PaymentOptionRowProps {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  note?: string;
}

const PaymentOptionRow: React.FC<PaymentOptionRowProps> = ({
  selected,
  onSelect,
  title,
  subtitle,
  note,
}) => (
  <li className={`border-l-2 ${selected ? "border-[#00875A]" : "border-transparent"}`}>
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left py-4 pl-4 pr-2 flex items-start justify-between gap-4 hover:bg-[#F7F8F9] transition-colors"
    >
      <div>
        <strong className={`block text-sm font-semibold ${selected ? "text-[#00875A]" : "text-[#1F2933]"}`}>
          {title}
        </strong>
        <p className="text-xs text-[#52606D] mt-1">{subtitle}</p>
      </div>
      <div className="text-right shrink-0">
        {note && <strong className="block text-xs font-semibold text-[#00875A]">{note}</strong>}
        <small className={`block text-xs mt-0.5 ${selected ? "text-[#00875A] font-semibold" : "text-[#52606D]"}`}>
          {selected ? "Seleccionado" : "Elegir"}
        </small>
      </div>
    </button>
  </li>
);
