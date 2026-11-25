import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QrCode } from "lucide-react";
import { CallCenterLayout } from "../components/layouts/CallCenterLayout";
import { AdvisorVoicePanel } from "../components/AdvisorVoicePanel";
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
  clearBookingDraft,
  findStateCodeByNameOrCode,
  formatDateDisplay,
  getBookingDraft,
  getDefaultTomorrowIso,
  getPreparationSteps,
  inferResumeStep,
  parseCurpMetadata,
  PaymentMethod,
  saveBookingDraft,
  TIME_SLOTS,
  WizardStep,
} from "../lib/bookingContext";
import {
  CHANNEL_META,
  EVENT_TYPE_LABELS,
  formatDateTime,
  formatMoney,
  formatTimeShort,
  STATE_META,
} from "../lib/constants";
import { MEXICAN_STATES } from "../lib/curp";
import { CallCenterCaseItem, ClinicItem, StaffUser, StudyItem } from "../types/api";

function getPatientDisplayName(c: CallCenterCaseItem): string {
  const full = [c.patient.firstName, c.patient.paternalLastName, c.patient.maternalLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (full) return full;
  if (c.patient.phone) return `Paciente ${c.patient.phone}`;
  return "Paciente en pre-registro";
}

function getCaseResumeStepLabel(c: CallCenterCaseItem): string {
  if (c.currentState === "CITA_CONFIRMADA" || c.contextJson.appointment_folio) {
    return "Cita confirmada";
  }

  const draft = getBookingDraft(c.id);
  const hasStudy = Boolean(c.contextJson.study?.code);
  const hasClinic = Boolean(c.contextJson.clinic?.id);

  if (!hasStudy) {
    return "Paso 01 · Estudio";
  }
  if (!hasClinic) {
    return "Paso 01 · Clínica";
  }

  const hasBasicName =
    Boolean(c.patient.firstName?.trim()) && Boolean(c.patient.paternalLastName?.trim());
  const hasFullWebProfile =
    hasBasicName &&
    (c.patient.curp?.trim().length ?? 0) === 18 &&
    (c.patient.phone?.replace(/\D/g, "").length ?? 0) >= 10;
  const hasCompleteProfile =
    hasFullWebProfile || (hasBasicName && Boolean(c.contextJson.payment_method));

  const s = inferResumeStep({
    currentState: c.currentState,
    hasStudy,
    hasClinic,
    hasCompleteProfile,
    hasFolio: Boolean(c.contextJson.appointment_folio),
    draft,
  });
  return s === 1 ? "Paso 01 · Estudio" : s === 2 ? "Paso 02 · Pre-registro" : "Paso 03 · Pago";
}

export const CallCenterPage: React.FC = () => {
  const [token, setToken] = useState<string | null>(() => getStaffToken("ASESOR"));
  const [user, setUser] = useState<StaffUser | null>(() => getStaffUser("ASESOR"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Catálogo y bandeja
  const [studies, setStudies] = useState<StudyItem[]>([]);
  const [clinics, setClinics] = useState<ClinicItem[]>([]);
  const [cases, setCases] = useState<CallCenterCaseItem[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [editingConfirmed, setEditingConfirmed] = useState(false);

  // Filtros por usuario y estado
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [selectedUserFilter, setSelectedUserFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OPEN" | "CONFIRMED">("ALL");

  // Estados de carga y avisos
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [screenPopNotice, setScreenPopNotice] = useState<string | null>(null);

  // Flujo de 3 pasos (Call Center solo modifica datos de la cita; perfil en solo lectura)
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedCategory, setSelectedCategory] = useState<string>("Todos");
  const [studyQuery, setStudyQuery] = useState<string>("");
  const [selectedStudyCode, setSelectedStudyCode] = useState<string>("");
  const [selectedClinicId, setSelectedClinicId] = useState<string>("");
  const [preferredDate, setPreferredDate] = useState<string>(getDefaultTomorrowIso);
  const [preferredTime, setPreferredTime] = useState<string>("09:30");

  // Paso 2: Datos del paciente (solo lectura en Call Center)
  const [nombres, setNombres] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [apellidoMaterno, setApellidoMaterno] = useState("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [genero, setGenero] = useState<"FEMENINO" | "MASCULINO" | "">("");
  const [estadoNacimientoCode, setEstadoNacimientoCode] = useState("");
  const [pais, setPais] = useState("MÉXICO");
  const [curp, setCurp] = useState("");
  const [telefono, setTelefono] = useState("");
  const [caseWebSessionId, setCaseWebSessionId] = useState<string | undefined>(undefined);

  // Paso 3: Pago y notas del asesor
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("online");
  const [advisorNotes, setAdvisorNotes] = useState("");

  const hydratedCaseKeyRef = useRef<string | null>(null);
  const studiesCountRef = useRef(0);
  const selectedStudyCodeRef = useRef(selectedStudyCode);
  const selectedClinicIdRef = useRef(selectedClinicId);
  const selectedUserFilterRef = useRef(selectedUserFilter);
  const selectedCaseIdRef = useRef(selectedCaseId);
  const fetchSeqRef = useRef(0);
  const sseRefreshTimerRef = useRef<number | null>(null);
  const screenPopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    studiesCountRef.current = studies.length;
  }, [studies.length]);
  useEffect(() => {
    selectedStudyCodeRef.current = selectedStudyCode;
  }, [selectedStudyCode]);
  useEffect(() => {
    selectedClinicIdRef.current = selectedClinicId;
  }, [selectedClinicId]);
  useEffect(() => {
    selectedUserFilterRef.current = selectedUserFilter;
  }, [selectedUserFilter]);
  useEffect(() => {
    selectedCaseIdRef.current = selectedCaseId;
  }, [selectedCaseId]);

  const fetchCatalogAndQueue = useCallback(async () => {
    if (!token) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const [queueRes, catRes] = await Promise.all([
        api.getCallCenterQueue(token),
        studiesCountRef.current === 0 ? api.getCatalog() : Promise.resolve(null),
      ]);
      if (seq !== fetchSeqRef.current) return;

      const list = queueRes.cases || [];
      setCases(list);
      if (catRes) {
        setStudies(catRes.studies);
        setClinics(catRes.clinics);
        if (catRes.studies.length > 0 && !selectedStudyCodeRef.current) {
          setSelectedStudyCode(catRes.studies[0].code);
        }
        if (catRes.clinics.length > 0 && !selectedClinicIdRef.current) {
          setSelectedClinicId(catRes.clinics[0].id);
        }
      }
      setError(null);
      setSelectedCaseId((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStaffSession("ASESOR");
        setToken(null);
        setUser(null);
        setLoginError("Tu sesión expiró. Inicia sesión nuevamente.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudo cargar la bandeja.");
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchCatalogAndQueue();
  }, [token, fetchCatalogAndQueue]);

  // SSE en tiempo real estable (no se reconecta al hidratar casos ni cambiar selección)
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
        if (
          data.caseId &&
          (selectedUserFilterRef.current === "ALL" ||
            selectedCaseIdRef.current === data.caseId ||
            !selectedCaseIdRef.current)
        ) {
          hydratedCaseKeyRef.current = null;
          setSelectedCaseId(data.caseId);
        }
        if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current);
        sseRefreshTimerRef.current = window.setTimeout(() => {
          fetchCatalogAndQueue();
        }, 220);

        if (screenPopTimerRef.current) window.clearTimeout(screenPopTimerRef.current);
        screenPopTimerRef.current = window.setTimeout(() => setScreenPopNotice(null), 5000);
      } catch {
        // Ignorar trama no JSON
      }
    });
    es.onerror = () => setSseConnected(false);
    return () => {
      es.close();
      if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current);
      if (screenPopTimerRef.current) window.clearTimeout(screenPopTimerRef.current);
    };
  }, [token, fetchCatalogAndQueue]);

  // Usuarios únicos para el filtro de usuario en Call Center
  const uniqueUsers = useMemo(() => {
    const map = new Map<
      string,
      { patientId: string; label: string; secondary: string; count: number }
    >();
    for (const c of cases) {
      const existing = map.get(c.patient.id);
      if (existing) {
        existing.count += 1;
      } else {
        const name = getPatientDisplayName(c);
        const secondary = c.patient.phone || c.patient.curp || "Sin teléfono";
        map.set(c.patient.id, {
          patientId: c.patient.id,
          label: name,
          secondary,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [cases]);

  const filteredCases = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase();
    return cases.filter((c) => {
      if (selectedUserFilter !== "ALL" && c.patient.id !== selectedUserFilter) return false;
      if (statusFilter === "OPEN" && c.currentState === "CITA_CONFIRMADA") return false;
      if (statusFilter === "CONFIRMED" && c.currentState !== "CITA_CONFIRMADA") return false;
      if (!q) return true;
      const fullName = getPatientDisplayName(c).toLowerCase();
      return (
        fullName.includes(q) ||
        (c.patient.phone || "").toLowerCase().includes(q) ||
        (c.patient.curp || "").toLowerCase().includes(q) ||
        (c.contextJson.study?.name || "").toLowerCase().includes(q) ||
        (c.contextJson.clinic?.name || "").toLowerCase().includes(q) ||
        (c.contextJson.appointment_folio || "").toLowerCase().includes(q) ||
        c.journeyId.toLowerCase().includes(q)
      );
    });
  }, [cases, selectedUserFilter, statusFilter, userSearchQuery]);

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) || null,
    [cases, selectedCaseId]
  );

  // Hidratar los 3 apartados exactamente desde donde se quedó el usuario en Web/WhatsApp
  const hydrateWorkspaceFromCase = useCallback(
    (c: CallCenterCaseItem) => {
      const draft = getBookingDraft(c.id);
      const curpVal = draft?.curp || c.patient.curp || "";
      const parsedCurp = parseCurpMetadata(curpVal);

      const nextStudyCode =
        c.contextJson.study?.code || draft?.selectedStudyCode || studies[0]?.code || "";
      const nextClinicId =
        c.contextJson.clinic?.id || draft?.selectedClinicId || clinics[0]?.id || "";
      const nextDate =
        c.contextJson.preferred_slot?.date || draft?.preferredDate || getDefaultTomorrowIso();
      const nextTime = c.contextJson.preferred_slot?.time || draft?.preferredTime || "09:30";

      const nextNombres = c.patient.firstName || draft?.nombres || "";
      const nextPaterno = c.patient.paternalLastName || draft?.apellidoPaterno || "";
      const nextMaterno = c.patient.maternalLastName || draft?.apellidoMaterno || "";
      const nextPhone = c.patient.phone || draft?.telefono || "";
      const nextBirthStateCode =
        findStateCodeByNameOrCode(c.patient.birthState) ||
        draft?.estadoNacimientoCode ||
        parsedCurp.estadoNacimientoCode ||
        "";
      const patientBirthDateIso = c.patient.birthDate ? c.patient.birthDate.slice(0, 10) : "";
      const nextBirthDate =
        patientBirthDateIso || draft?.fechaNacimiento || parsedCurp.fechaNacimiento || "";
      const patientGender: "FEMENINO" | "MASCULINO" | "" =
        c.patient.gender === "FEMENINO" || c.patient.gender === "MASCULINO"
          ? c.patient.gender
          : "";
      const nextGenero = patientGender || draft?.genero || parsedCurp.genero || "";

      setSelectedStudyCode(nextStudyCode);
      setSelectedClinicId(nextClinicId);
      setPreferredDate(nextDate);
      setPreferredTime(nextTime);

      setNombres(nextNombres);
      setApellidoPaterno(nextPaterno);
      setApellidoMaterno(nextMaterno);
      setFechaNacimiento(nextBirthDate);
      setGenero(nextGenero);
      setEstadoNacimientoCode(nextBirthStateCode);
      setPais(draft?.pais || "MÉXICO");
      setCurp(curpVal);
      setTelefono(nextPhone);
      setCaseWebSessionId(draft?.webSessionId);
      setPaymentMethod(c.contextJson.payment_method || draft?.paymentMethod || "online");
      setAdvisorNotes(draft?.advisorNotes || "");
      setEditingConfirmed(false);
      setNotice(null);
      setError(null);

      const hasBasicName = nextNombres.trim().length >= 2 && nextPaterno.trim().length >= 2;
      const hasFullWebProfile =
        hasBasicName &&
        curpVal.trim().length === 18 &&
        nextPhone.replace(/\D/g, "").length >= 10;
      const hasCompleteProfile =
        hasFullWebProfile || (hasBasicName && Boolean(c.contextJson.payment_method));

      const resumedStep = inferResumeStep({
        currentState: c.currentState,
        hasStudy: Boolean(c.contextJson.study?.code),
        hasClinic: Boolean(c.contextJson.clinic?.id),
        hasCompleteProfile,
        hasFolio: Boolean(c.contextJson.appointment_folio),
        draft,
      });
      setStep(resumedStep);
    },
    [studies, clinics]
  );

  useEffect(() => {
    if (!selectedCase) return;
    const key = [
      selectedCase.id,
      selectedCase.version,
      selectedCase.updatedAt,
      selectedCase.currentState,
      selectedCase.patient.firstName ?? "",
      selectedCase.patient.paternalLastName ?? "",
      selectedCase.patient.phone ?? "",
      selectedCase.contextJson.study?.code ?? "",
      selectedCase.contextJson.clinic?.id ?? "",
      selectedCase.contextJson.payment_method ?? "",
      selectedCase.contextJson.appointment_folio ?? "",
    ].join(":");
    if (hydratedCaseKeyRef.current === key) return;
    hydratedCaseKeyRef.current = key;
    hydrateWorkspaceFromCase(selectedCase);
  }, [selectedCase, hydrateWorkspaceFromCase]);

  // Escuchar cambios de borrador desde otra pestaña del mismo navegador (ej. Web -> Call Center)
  useEffect(() => {
    const onStorage = () => {
      if (selectedCase) {
        hydratedCaseKeyRef.current = null;
        hydrateWorkspaceFromCase(selectedCase);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [selectedCase, hydrateWorkspaceFromCase]);

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
    setNotice(null);
    try {
      await api.assignCallCenterCase(token, selectedCase.id, selectedCase.version);
      hydratedCaseKeyRef.current = null;
      await fetchCatalogAndQueue();
      setNotice("Caso asignado a tu estación de Call Center.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar el caso.");
    } finally {
      setActionLoading(false);
    }
  };

  // Paso 1: Modificar exclusivamente los datos de la cita (estudio, clínica, horario) sin alterar cuenta
  const handleStep1Continue = async (pauseAfter = false) => {
    if (!token || !selectedCase || !selectedStudy || !selectedClinic) return;

    setActionLoading(true);
    setError(null);
    setNotice(null);

    try {
      const res = await api.updateCallCenterCase(token, selectedCase.id, {
        expectedVersion: selectedCase.version,
        studyCode: selectedStudy.code,
        clinicId: selectedClinic.id,
        preferredDate,
        preferredTime,
        paymentMethod,
        action: pauseAfter ? "pause" : "save",
      });

      const targetStep: WizardStep = pauseAfter ? 1 : 2;
      saveBookingDraft({
        caseId: res.case.id,
        webSessionId: caseWebSessionId,
        step: targetStep,
        selectedStudyCode: selectedStudy.code,
        selectedClinicId: selectedClinic.id,
        preferredDate,
        preferredTime,
        paymentMethod,
        advisorNotes,
        updatedAt: new Date().toISOString(),
        updatedByChannel: "CALL_CENTER",
      });

      hydratedCaseKeyRef.current = null;
      await fetchCatalogAndQueue();

      if (pauseAfter) {
        setNotice("Cita pausada y sincronizada. El paciente puede retomarla en Web o WhatsApp.");
      } else {
        setStep(2);
        setNotice("Estudio, clínica y horario actualizados en la cita.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No fue posible actualizar los datos de la cita."
      );
    } finally {
      setActionLoading(false);
    }
  };

  // Guardar borrador de cita en pausa (PAUSADO_PENDIENTE) sin modificar la cuenta del paciente
  const handleSaveDraftForLater = async (currentStepToKeep: WizardStep) => {
    if (!token || !selectedCase) return;
    setActionLoading(true);
    setError(null);
    setNotice(null);

    try {
      const res = await api.updateCallCenterCase(token, selectedCase.id, {
        expectedVersion: selectedCase.version,
        ...(selectedStudyCode ? { studyCode: selectedStudyCode } : {}),
        ...(selectedClinicId ? { clinicId: selectedClinicId } : {}),
        preferredDate,
        preferredTime,
        paymentMethod,
        advisorNotes: advisorNotes.trim() || undefined,
        action: "pause",
      });

      saveBookingDraft({
        caseId: res.case.id,
        webSessionId: caseWebSessionId,
        step: currentStepToKeep,
        selectedStudyCode,
        selectedClinicId,
        preferredDate,
        preferredTime,
        paymentMethod,
        advisorNotes,
        updatedAt: new Date().toISOString(),
        updatedByChannel: "CALL_CENTER",
      });
      hydratedCaseKeyRef.current = null;
      await fetchCatalogAndQueue();
      setNotice(
        "Cita guardada en pausa. El paciente podrá retomar exactamente en este paso desde Sitio Web o WhatsApp."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No fue posible guardar el borrador.");
    } finally {
      setActionLoading(false);
    }
  };

  // Editar una cita ya confirmada (solo datos de cita: estudio, clínica, fecha, hora, pago)
  const handleSaveConfirmedEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedCase || !selectedStudyCode || !selectedClinicId) return;
    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateCallCenterCase(token, selectedCase.id, {
        expectedVersion: selectedCase.version,
        studyCode: selectedStudyCode,
        clinicId: selectedClinicId,
        preferredDate,
        preferredTime,
        paymentMethod,
        advisorNotes: advisorNotes.trim() || undefined,
        action: "save",
      });
      setEditingConfirmed(false);
      hydratedCaseKeyRef.current = null;
      await fetchCatalogAndQueue();
      setNotice("Cita confirmada actualizada y sincronizada en todos los canales.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los cambios en la cita.");
    } finally {
      setActionLoading(false);
    }
  };

  // Paso 3: Confirmar cita (Folio + QR + WhatsApp)
  const handleConfirm = async () => {
    if (!token || !selectedCase) return;
    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      const notesWithPayment = [
        `Forma de pago: ${
          paymentMethod === "online"
            ? "Pago en línea (-10%)"
            : paymentMethod === "oxxo"
            ? "OXXO Pay"
            : "En clínica"
        }`,
        advisorNotes.trim(),
      ]
        .filter(Boolean)
        .join(" · ");

      await api.confirmCallCenterCase(token, selectedCase.id, {
        expectedVersion: selectedCase.version,
        ...(preferredDate ? { preferredDate } : {}),
        ...(preferredTime ? { preferredTime } : {}),
        paymentMethod,
        advisorNotes: notesWithPayment,
      });

      clearBookingDraft(selectedCase.id);
      setAdvisorNotes("");
      hydratedCaseKeyRef.current = null;
      await fetchCatalogAndQueue();
      setNotice("Cita confirmada con éxito. Folio y código QR generados.");
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
              Inicia sesión con tu cuenta institucional de asesor para agendar y continuar citas
              con contexto omnicanal.
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

  const isConfirmed =
    selectedCase?.currentState === "CITA_CONFIRMADA" &&
    Boolean(selectedCase.contextJson.appointment_folio);

  const basePrice = selectedStudy?.price ?? selectedCase?.contextJson.study?.price ?? 0;
  const onlineDiscount = Math.round(basePrice * 0.1);
  const finalPrice = paymentMethod === "online" ? basePrice - onlineDiscount : basePrice;

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

        {notice && (
          <p className="border-l-2 border-[#00875A] pl-4 py-1 text-sm text-[#00875A]">{notice}</p>
        )}

        {error && (
          <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
        )}

        {/* Panel de llamadas WebRTC en tiempo real + Resúmenes IA */}
        <AdvisorVoicePanel
          token={token}
          selectedCase={selectedCase}
          onSelectCaseById={(caseId) => {
            hydratedCaseKeyRef.current = null;
            setSelectedCaseId(caseId);
          }}
          onCaseUpdated={async () => {
            hydratedCaseKeyRef.current = null;
            await fetchCatalogAndQueue();
          }}
        />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* ==================== COLUMNA IZQUIERDA: FILTRO POR USUARIO Y COLA ==================== */}
          <aside className="lg:col-span-4 space-y-5">
            <div className="pb-3 border-b border-[#E4E7EB] flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-[#1F2933]">
                Cola de citas ({filteredCases.length})
              </h2>
              <button
                type="button"
                onClick={fetchCatalogAndQueue}
                className="text-xs font-semibold text-[#52606D] hover:text-[#1F2933]"
              >
                {loading ? "..." : "Actualizar"}
              </button>
            </div>

            {/* Filtros por usuario y estado */}
            <div className="space-y-3 pb-4 border-b border-[#E4E7EB]">
              <div>
                <label
                  htmlFor="cc-user-search"
                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                >
                  Buscar usuario
                </label>
                <input
                  id="cc-user-search"
                  type="search"
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  placeholder="Nombre, teléfono, CURP o folio..."
                  className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                />
              </div>

              <div>
                <label
                  htmlFor="cc-user-select"
                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                >
                  Filtrar por usuario
                </label>
                <select
                  id="cc-user-select"
                  value={selectedUserFilter}
                  onChange={(e) => setSelectedUserFilter(e.target.value)}
                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                >
                  <option value="ALL">Todos los usuarios ({uniqueUsers.length})</option>
                  {uniqueUsers.map((u) => (
                    <option key={u.patientId} value={u.patientId}>
                      {u.label} · {u.secondary} ({u.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 border border-[#E4E7EB] text-xs">
                {(
                  [
                    { key: "ALL", label: "Todos" },
                    { key: "OPEN", label: "En curso" },
                    { key: "CONFIRMED", label: "Confirmadas" },
                  ] as const
                ).map((tab, idx) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setStatusFilter(tab.key)}
                    className={`py-2 font-semibold transition-colors ${
                      idx > 0 ? "border-l border-[#E4E7EB]" : ""
                    } ${
                      statusFilter === tab.key
                        ? "bg-[#00875A] text-[#FFFFFF]"
                        : "bg-[#FFFFFF] text-[#52606D] hover:text-[#1F2933]"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {(userSearchQuery || selectedUserFilter !== "ALL" || statusFilter !== "ALL") && (
                <button
                  type="button"
                  onClick={() => {
                    setUserSearchQuery("");
                    setSelectedUserFilter("ALL");
                    setStatusFilter("ALL");
                  }}
                  className="text-xs font-semibold text-[#00875A] hover:underline"
                >
                  Limpiar filtros
                </button>
              )}
            </div>

            {filteredCases.length === 0 ? (
              <p className="py-8 text-xs text-[#52606D]">
                No hay casos coincidentes con el filtro de usuario seleccionado.
              </p>
            ) : (
              <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB] max-h-[680px] overflow-y-auto">
                {filteredCases.map((c) => {
                  const active = c.id === selectedCaseId;
                  const fullName = getPatientDisplayName(c);
                  const stMeta = STATE_META[c.currentState];
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          hydratedCaseKeyRef.current = null;
                          setSelectedCaseId(c.id);
                        }}
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
                          {c.contextJson.study?.name || "Estudio pendiente"}
                          {c.contextJson.clinic?.name ? ` · ${c.contextJson.clinic.name}` : ""}
                        </p>
                        <div className="flex items-baseline justify-between gap-2 text-[11px] text-[#52606D] mt-1">
                          <small>{CHANNEL_META[c.currentChannel].label} · v{c.version}</small>
                          <strong className="text-[#00875A] font-semibold">
                            {getCaseResumeStepLabel(c)}
                          </strong>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* ==================== COLUMNA DERECHA: GESTIÓN DE CITA (SOLO CITAS) ==================== */}
          <section className="lg:col-span-8 lg:border-l lg:border-[#E4E7EB] lg:pl-10 space-y-8">
            {!selectedCase ? (
              <div className="py-12 space-y-4">
                <h2 className="text-xl font-bold text-[#1F2933]">
                  Selecciona una cita de la cola para gestionarla
                </h2>
                <p className="text-sm text-[#52606D] max-w-lg">
                  Desde Call Center puedes consultar y modificar estudio, clínica, horario, forma de
                  pago y confirmación de citas existentes en tiempo real. La modificación de cuentas
                  de usuario está reservada al paciente o al Administrador.
                </p>
              </div>
            ) : (
              <>
                {/* Cabecera del expediente */}
                <header className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                        Screen-Pop omnicanal · Último canal:{" "}
                        {CHANNEL_META[selectedCase.currentChannel].label}
                      </p>
                      <h2 className="text-2xl font-bold text-[#1F2933] mt-1">
                        {getPatientDisplayName(selectedCase)}
                      </h2>
                      <p className="text-xs font-mono text-[#52606D] mt-1">
                        {selectedCase.patient.phone ? `Tel: ${selectedCase.patient.phone} · ` : ""}
                        {selectedCase.patient.curp ? `CURP: ${selectedCase.patient.curp} · ` : ""}
                        v{selectedCase.version}
                      </p>
                    </div>

                    {selectedCase && (
                      <div className="flex flex-wrap items-center gap-3 shrink-0">
                        <strong
                          className={`text-xs font-semibold ${
                            STATE_META[selectedCase.currentState].textClass
                          }`}
                        >
                          {STATE_META[selectedCase.currentState].label}
                        </strong>
                        {!isConfirmed && selectedCase.currentState !== "EN_ATENCION_ASESOR" && (
                          <button
                            type="button"
                            disabled={actionLoading}
                            onClick={handleAssign}
                            className="px-3.5 py-1.5 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors disabled:opacity-50"
                          >
                            Tomar caso
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {selectedCase?.contextJson.handoff_summary && (
                    <div className="border-l-2 border-[#00875A] pl-4 space-y-1">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                        Contexto recuperado (Resumen handoff)
                      </h3>
                      <p className="text-sm text-[#1F2933] leading-relaxed">
                        {selectedCase.contextJson.handoff_summary}
                      </p>
                    </div>
                  )}

                  {/* Barra de los 3 apartados oficiales idéntica a LaboratorioPage */}
                  <ol className="grid grid-cols-3 border-t border-b border-[#E4E7EB]">
                    {[
                      { num: 1 as WizardStep, title: "Estudio y clínica" },
                      { num: 2 as WizardStep, title: "Pre-registro" },
                      { num: 3 as WizardStep, title: "Resumen y pago" },
                    ].map((item) => {
                      const isCurrent = step === item.num;
                      const isDone = step > item.num || isConfirmed;
                      const disabled =
                        (isConfirmed && item.num !== 3) ||
                        (item.num === 3 && !selectedCase);
                      return (
                        <li key={item.num} className="border-r last:border-r-0 border-[#E4E7EB]">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => setStep(item.num)}
                            className={`w-full text-left py-3.5 px-3 sm:px-4 border-b-2 transition-colors ${
                              isCurrent
                                ? "border-[#00875A] text-[#00875A]"
                                : isDone
                                ? "border-transparent text-[#1F2933] hover:text-[#00875A]"
                                : "border-transparent text-[#52606D] disabled:opacity-50"
                            }`}
                          >
                            <small className="block text-[11px] uppercase tracking-wider font-semibold">
                              Paso 0{item.num} {isDone && !isCurrent ? "· Listo" : ""}
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

                {/* ==================== PASO 1: ESTUDIO Y CLÍNICA ==================== */}
                {step === 1 && !isConfirmed && (
                  <div className="space-y-8">
                    <section className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                        <div>
                          <h3 className="text-lg font-bold text-[#1F2933]">1. Elige el estudio</h3>
                          <p className="text-xs text-[#52606D]">
                            Precios vigentes e indicaciones previas a la cita
                          </p>
                        </div>
                        <input
                          type="search"
                          value={studyQuery}
                          onChange={(e) => setStudyQuery(e.target.value)}
                          placeholder="Filtrar estudio..."
                          aria-label="Filtrar estudios en Call Center"
                          className="h-9 w-full sm:w-56 px-3 border border-[#E4E7EB] text-xs text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                        />
                      </div>

                      <div className="flex flex-wrap gap-4 border-b border-[#E4E7EB]">
                        {categories.map((cat) => {
                          const active = selectedCategory === cat;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setSelectedCategory(cat)}
                              className={`pb-2 text-xs border-b-2 transition-colors ${
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

                      <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
                        {filteredStudies.map((study) => {
                          const active = study.code === selectedStudyCode;
                          return (
                            <li
                              key={study.code}
                              className={`py-4 pl-4 border-l-2 ${
                                active ? "border-[#00875A]" : "border-transparent"
                              }`}
                            >
                              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                                <div className="space-y-1">
                                  <small className="block text-[11px] font-semibold uppercase tracking-wider text-[#00875A]">
                                    {study.category}
                                  </small>
                                  <h4 className="text-sm font-bold text-[#1F2933]">{study.name}</h4>
                                  <p className="text-xs text-[#52606D] leading-relaxed">
                                    {study.prep}
                                  </p>
                                </div>
                                <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
                                  <strong className="text-base font-bold text-[#1F2933]">
                                    {formatMoney(study.price)}
                                  </strong>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedStudyCode(study.code)}
                                    className={`px-3 py-1 text-xs font-semibold border transition-colors ${
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
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-lg font-bold text-[#1F2933]">
                        2. Selecciona clínica, fecha y horario
                      </h3>

                      <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
                        {clinics.map((clinic) => {
                          const active = clinic.id === selectedClinicId;
                          return (
                            <li
                              key={clinic.id}
                              className={`py-3.5 pl-4 border-l-2 ${
                                active ? "border-[#00875A]" : "border-transparent"
                              }`}
                            >
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                <div>
                                  <h4 className="text-sm font-bold text-[#1F2933]">{clinic.name}</h4>
                                  <p className="text-xs text-[#52606D]">{clinic.address}</p>
                                  <p className="text-xs text-[#52606D]">{clinic.hours}</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setSelectedClinicId(clinic.id)}
                                  className={`self-start sm:self-center px-3 py-1 text-xs font-semibold border transition-colors shrink-0 ${
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
                            htmlFor="cc-step1-date"
                            className="block text-xs font-semibold text-[#1F2933] mb-2"
                          >
                            Fecha deseada
                          </label>
                          <input
                            id="cc-step1-date"
                            type="date"
                            value={preferredDate}
                            onChange={(e) => setPreferredDate(e.target.value)}
                            className="w-full h-11 border border-[#E4E7EB] px-3 text-sm text-[#1F2933] focus:border-[#00875A]"
                          />
                        </div>
                        <div className="sm:col-span-7">
                          <p className="text-xs font-semibold text-[#1F2933] mb-2">
                            Horario preferido
                          </p>
                          <div className="grid grid-cols-4 border-t border-l border-[#E4E7EB]">
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

                    {selectedStudy && (
                      <section className="pt-4 border-t border-[#E4E7EB] space-y-2">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                          Indicaciones de preparación para informar en llamada
                        </h4>
                        <ol className="list-decimal pl-5 space-y-1 text-xs text-[#52606D]">
                          {getPreparationSteps(selectedStudy.prep).map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ol>
                      </section>
                    )}

                    <div className="pt-4 border-t border-[#E4E7EB] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      {selectedCase ? (
                        <button
                          type="button"
                          disabled={actionLoading || !selectedStudy || !selectedClinic}
                          onClick={() => handleStep1Continue(true)}
                          className="h-11 px-5 border border-[#E4E7EB] bg-[#FFFFFF] hover:border-[#1F2933] text-xs font-semibold text-[#1F2933] transition-colors disabled:opacity-50"
                        >
                          Guardar borrador
                        </button>
                      ) : (
                        <p className="text-xs text-[#52606D]">
                          Precio en clínica:{" "}
                          <strong className="text-[#1F2933]">{formatMoney(basePrice)}</strong>
                        </p>
                      )}

                      <button
                        type="button"
                        disabled={actionLoading || !selectedStudy || !selectedClinic}
                        onClick={() => handleStep1Continue(false)}
                        className="h-12 px-7 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? "Guardando..." : "Continuar al pre-registro"}
                      </button>
                    </div>
                  </div>
                )}

                {/* ==================== PASO 2: DATOS DEL PACIENTE (SOLO LECTURA) ==================== */}
                {step === 2 && !isConfirmed && (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => setStep(1)}
                        className="text-xs font-semibold text-[#00875A] hover:underline"
                      >
                        ← Modificar estudio, clínica o horario ({selectedStudy?.name})
                      </button>
                    </div>

                    <section className="border-l-2 border-[#00875A] pl-4 space-y-1">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                        Política de permisos · Call Center
                      </h3>
                      <p className="text-xs text-[#52606D] leading-relaxed">
                        Call Center únicamente puede modificar citas (estudio, clínica, fecha,
                        horario y forma de pago). Los datos de la cuenta del paciente son de solo
                        lectura y únicamente pueden ser modificados por el propio usuario o por un
                        Administrador.
                      </p>
                    </section>

                    <section className="space-y-3">
                      <h3 className="text-base font-bold text-[#1F2933]">
                        Perfil del paciente (solo lectura)
                      </h3>
                      <dl className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB] text-sm">
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Nombre completo</dt>
                          <dd className="font-semibold text-[#1F2933] text-right">
                            {[nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ") ||
                              "Pendiente de captura por el paciente"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Teléfono</dt>
                          <dd className="font-mono text-xs text-[#1F2933]">
                            {telefono || "Sin registrar"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Correo electrónico</dt>
                          <dd className="text-xs text-[#1F2933]">
                            {selectedCase.patient.email || "Sin registrar"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">CURP</dt>
                          <dd className="font-mono text-xs text-[#1F2933]">
                            {curp || "Pendiente"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Fecha de nacimiento</dt>
                          <dd className="text-xs text-[#1F2933]">
                            {fechaNacimiento ? formatDateDisplay(fechaNacimiento) : "Sin registrar"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Género</dt>
                          <dd className="text-xs text-[#1F2933]">
                            {genero === "FEMENINO"
                              ? "Mujer"
                              : genero === "MASCULINO"
                              ? "Hombre"
                              : "Sin registrar"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Estado / País</dt>
                          <dd className="text-xs text-[#1F2933]">
                            {(MEXICAN_STATES.find((st) => st.code === estadoNacimientoCode)?.name ||
                              selectedCase.patient.birthState ||
                              "Sin registrar") +
                              " · " +
                              pais}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    <div className="pt-4 border-t border-[#E4E7EB] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={() => handleSaveDraftForLater(2)}
                        className="h-11 px-5 border border-[#E4E7EB] bg-[#FFFFFF] hover:border-[#1F2933] text-xs font-semibold text-[#1F2933] transition-colors disabled:opacity-50"
                      >
                        Pausar cita para después
                      </button>

                      <button
                        type="button"
                        onClick={() => setStep(3)}
                        className="h-12 px-7 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors"
                      >
                        Continuar a resumen y pago
                      </button>
                    </div>
                  </div>
                )}

                {/* ==================== PASO 3: RESUMEN Y PAGO ==================== */}
                {step === 3 && selectedCase && (
                  <div className="space-y-8">
                    {isConfirmed ? (
                      <section className="space-y-6">
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
                          <div className="flex items-center gap-4 shrink-0 self-start">
                            <button
                              type="button"
                              onClick={() => setEditingConfirmed((v) => !v)}
                              className="h-10 px-4 border border-[#00875A] text-xs font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                            >
                              {editingConfirmed ? "Cancelar edición" : "Editar cita confirmada"}
                            </button>
                            <div className="p-2 border border-[#E4E7EB]">
                              <QrCode className="w-16 h-16 text-[#1F2933]" />
                            </div>
                          </div>
                        </div>

                        {editingConfirmed && (
                          <form
                            onSubmit={handleSaveConfirmedEdit}
                            className="bg-[#F7F8F9] border border-[#E4E7EB] p-5 space-y-4"
                          >
                            <div>
                              <h4 className="text-sm font-bold text-[#1F2933]">
                                Modificar cita confirmada (se conserva el folio)
                              </h4>
                              <p className="text-xs text-[#52606D] mt-0.5">
                                Solo se editan los datos de la cita; el paciente y Administrador
                                recibirán la actualización al instante.
                              </p>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <div>
                                <label
                                  htmlFor="cc-edit-study"
                                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                                >
                                  Estudio
                                </label>
                                <select
                                  id="cc-edit-study"
                                  value={selectedStudyCode}
                                  onChange={(e) => setSelectedStudyCode(e.target.value)}
                                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                                >
                                  {studies.map((st) => (
                                    <option key={st.code} value={st.code}>
                                      {st.name} ({formatMoney(st.price)})
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label
                                  htmlFor="cc-edit-clinic"
                                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                                >
                                  Clínica
                                </label>
                                <select
                                  id="cc-edit-clinic"
                                  value={selectedClinicId}
                                  onChange={(e) => setSelectedClinicId(e.target.value)}
                                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                                >
                                  {clinics.map((cl) => (
                                    <option key={cl.id} value={cl.id}>
                                      {cl.name} · {cl.city}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <div>
                                <label
                                  htmlFor="cc-edit-date"
                                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                                >
                                  Fecha
                                </label>
                                <input
                                  id="cc-edit-date"
                                  type="date"
                                  value={preferredDate}
                                  onChange={(e) => setPreferredDate(e.target.value)}
                                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                                />
                              </div>
                              <div>
                                <label
                                  htmlFor="cc-edit-time"
                                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                                >
                                  Horario
                                </label>
                                <select
                                  id="cc-edit-time"
                                  value={preferredTime}
                                  onChange={(e) => setPreferredTime(e.target.value)}
                                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                                >
                                  {TIME_SLOTS.map((slot) => (
                                    <option key={slot} value={slot}>
                                      {slot} hrs
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label
                                  htmlFor="cc-edit-payment"
                                  className="block text-xs font-semibold text-[#1F2933] mb-1"
                                >
                                  Forma de pago
                                </label>
                                <select
                                  id="cc-edit-payment"
                                  value={paymentMethod}
                                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                                  className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                                >
                                  <option value="online">Pago en línea (-10%)</option>
                                  <option value="oxxo">OXXO Pay</option>
                                  <option value="clinic">En clínica</option>
                                </select>
                              </div>
                            </div>

                            <div>
                              <label
                                htmlFor="cc-edit-notes"
                                className="block text-xs font-semibold text-[#1F2933] mb-1"
                              >
                                Motivo del cambio / Notas del asesor
                              </label>
                              <input
                                id="cc-edit-notes"
                                type="text"
                                value={advisorNotes}
                                onChange={(e) => setAdvisorNotes(e.target.value)}
                                placeholder="Ej. Reagendada a solicitud del paciente..."
                                className="w-full h-10 border border-[#E4E7EB] bg-[#FFFFFF] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                              />
                            </div>

                            <div className="flex justify-end gap-3 pt-2">
                              <button
                                type="button"
                                onClick={() => setEditingConfirmed(false)}
                                className="h-10 px-4 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933]"
                              >
                                Cancelar
                              </button>
                              <button
                                type="submit"
                                disabled={actionLoading}
                                className="h-10 px-5 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-xs font-semibold transition-colors disabled:opacity-50"
                              >
                                {actionLoading ? "Guardando..." : "Guardar cambios en la cita"}
                              </button>
                            </div>
                          </form>
                        )}
                      </section>
                    ) : (
                      <>
                        <section className="space-y-4">
                          <div>
                            <h3 className="text-lg font-bold text-[#1F2933]">Forma de pago</h3>
                            <p className="text-xs text-[#52606D] mt-0.5">
                              El pago en línea aplica 10% de descuento y recepción preferencial en
                              clínica.
                            </p>
                          </div>

                          <ul className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB]">
                            {(
                              [
                                {
                                  key: "online" as PaymentMethod,
                                  title: "Pago en línea con tarjeta (Visa / Mastercard)",
                                  subtitle:
                                    "Aplica 10% de descuento automático y recepción express",
                                  note: "-10% ahorro",
                                },
                                {
                                  key: "oxxo" as PaymentMethod,
                                  title: "Pago en efectivo con OXXO Pay",
                                  subtitle: "Referencia para liquidar en tienda antes de la cita",
                                },
                                {
                                  key: "clinic" as PaymentMethod,
                                  title: "Pagar en clínica el día de la cita",
                                  subtitle: "Efectivo o tarjeta directamente en recepción",
                                },
                              ] as const
                            ).map((opt) => {
                              const active = paymentMethod === opt.key;
                              return (
                                <li
                                  key={opt.key}
                                  className={`border-l-2 ${
                                    active ? "border-[#00875A]" : "border-transparent"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => setPaymentMethod(opt.key)}
                                    className="w-full text-left py-3.5 pl-4 pr-2 flex items-start justify-between gap-4 hover:bg-[#F7F8F9] transition-colors"
                                  >
                                    <div>
                                      <strong
                                        className={`block text-sm font-semibold ${
                                          active ? "text-[#00875A]" : "text-[#1F2933]"
                                        }`}
                                      >
                                        {opt.title}
                                      </strong>
                                      <p className="text-xs text-[#52606D] mt-0.5">{opt.subtitle}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                      {"note" in opt && opt.note && (
                                        <strong className="block text-xs font-semibold text-[#00875A]">
                                          {opt.note}
                                        </strong>
                                      )}
                                      <small
                                        className={`block text-xs ${
                                          active
                                            ? "text-[#00875A] font-semibold"
                                            : "text-[#52606D]"
                                        }`}
                                      >
                                        {active ? "Seleccionado" : "Elegir"}
                                      </small>
                                    </div>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </section>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div>
                            <label
                              htmlFor="cc-confirm-date"
                              className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                            >
                              Fecha de cita
                            </label>
                            <input
                              id="cc-confirm-date"
                              type="date"
                              value={preferredDate}
                              onChange={(e) => setPreferredDate(e.target.value)}
                              className="w-full h-10 border border-[#E4E7EB] px-3 text-xs text-[#1F2933] focus:border-[#00875A]"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="cc-confirm-time"
                              className="block text-xs font-semibold text-[#1F2933] mb-1.5"
                            >
                              Hora de cita
                            </label>
                            <input
                              id="cc-confirm-time"
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
                      </>
                    )}

                    {/* Resumen de la cita */}
                    <section className="pt-4 border-t border-[#E4E7EB] space-y-4">
                      <h3 className="text-base font-bold text-[#1F2933]">Resumen de la cita</h3>
                      <dl className="divide-y divide-[#E4E7EB] text-sm">
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Paciente</dt>
                          <dd className="font-semibold text-[#1F2933] text-right">
                            {[nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ") ||
                              getPatientDisplayName(selectedCase)}
                          </dd>
                        </div>
                        {(curp || selectedCase.patient.curp) && (
                          <div className="py-2.5 flex justify-between gap-4">
                            <dt className="text-[#52606D]">CURP</dt>
                            <dd className="font-mono text-xs font-semibold text-[#1F2933]">
                              {curp || selectedCase.patient.curp}
                            </dd>
                          </div>
                        )}
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Estudio</dt>
                          <dd className="font-semibold text-[#1F2933] text-right">
                            {selectedCase.contextJson.study?.name || selectedStudy?.name || "Por definir"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Clínica</dt>
                          <dd className="font-semibold text-[#1F2933] text-right">
                            {selectedCase.contextJson.clinic?.name || selectedClinic?.name || "Por definir"}
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4">
                          <dt className="text-[#52606D]">Horario</dt>
                          <dd className="font-semibold text-[#1F2933]">
                            {preferredDate} · {preferredTime} hrs
                          </dd>
                        </div>
                        <div className="py-2.5 flex justify-between gap-4 text-[#52606D]">
                          <dt>Subtotal</dt>
                          <dd>{formatMoney(basePrice)}</dd>
                        </div>
                        {paymentMethod === "online" && (
                          <div className="py-2.5 flex justify-between gap-4 text-[#00875A] font-medium">
                            <dt>Descuento pago en línea (10%)</dt>
                            <dd>-{formatMoney(onlineDiscount)}</dd>
                          </div>
                        )}
                        <div className="py-3 flex justify-between items-baseline">
                          <dt className="text-base font-bold text-[#1F2933]">Total a pagar</dt>
                          <dd>
                            <strong className="text-2xl font-bold text-[#1F2933]">
                              {formatMoney(finalPrice)}
                            </strong>
                          </dd>
                        </div>
                      </dl>
                    </section>

                    {!isConfirmed && (
                      <div className="pt-4 border-t border-[#E4E7EB] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
                        <button
                          type="button"
                          disabled={actionLoading}
                          onClick={() => handleSaveDraftForLater(3)}
                          className="h-12 px-5 border border-[#E4E7EB] bg-[#FFFFFF] hover:border-[#1F2933] text-sm font-semibold text-[#1F2933] transition-colors disabled:opacity-50"
                        >
                          Guardar y continuar después
                        </button>

                        <button
                          type="button"
                          disabled={actionLoading}
                          onClick={handleConfirm}
                          className="h-12 px-7 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-50"
                        >
                          {actionLoading
                            ? "Confirmando cita..."
                            : `Confirmar cita (${formatMoney(finalPrice)})`}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Historial cronológico omnicanal */}
                {selectedCase && (
                  <section className="pt-6 border-t border-[#E4E7EB] space-y-4">
                    <h3 className="text-sm font-bold text-[#1F2933]">
                      Historial cronológico ({selectedCase.journeyEvents.length} eventos)
                    </h3>
                    <ol className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB] max-h-60 overflow-y-auto">
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
                            <time
                              dateTime={ev.createdAt}
                              className="font-mono text-[11px] text-[#52606D]"
                            >
                              {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                            </time>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </CallCenterLayout>
  );
};
