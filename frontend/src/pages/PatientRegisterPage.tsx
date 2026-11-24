import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, Calendar } from "lucide-react";
import { api, getOrCreateWebSessionId, savePatientSession } from "../lib/api";
import { generateDeterministicCurp, MEXICAN_STATES } from "../lib/curp";

export const PatientRegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = searchParams.get("next") || "/mi-cuenta";

  // 9 campos oficiales de "Perfil del paciente"
  const [nombres, setNombres] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [apellidoMaterno, setApellidoMaterno] = useState("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [genero, setGenero] = useState<"FEMENINO" | "MASCULINO" | "">("");
  const [estadoNacimientoCode, setEstadoNacimientoCode] = useState("");
  const [pais, setPais] = useState("MÉXICO");
  const [curp, setCurp] = useState("");
  const [curpManuallyEdited, setCurpManuallyEdited] = useState(false);
  const [telefono, setTelefono] = useState("");

  // Credenciales de cuenta
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateInputRef = useRef<HTMLInputElement | null>(null);

  // Cálculo determinístico de CURP al elegir estado de nacimiento
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

  const formatDateDisplay = (isoDate: string): string => {
    if (!isoDate) return "dd/mm/aaaa";
    const parts = isoDate.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate;
  };

  const passwordsMatch = password.length >= 6 && password === confirmPassword;

  const isFormValid = useMemo(() => {
    const phoneDigits = telefono.replace(/\D/g, "");
    return (
      nombres.trim().length >= 2 &&
      apellidoPaterno.trim().length >= 2 &&
      fechaNacimiento.length === 10 &&
      (genero === "FEMENINO" || genero === "MASCULINO") &&
      estadoNacimientoCode.length === 2 &&
      pais.trim().length > 0 &&
      curp.trim().length === 18 &&
      phoneDigits.length >= 10 &&
      email.includes("@") &&
      passwordsMatch
    );
  }, [
    nombres,
    apellidoPaterno,
    fechaNacimiento,
    genero,
    estadoNacimientoCode,
    pais,
    curp,
    telefono,
    email,
    passwordsMatch,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;

    setSubmitting(true);
    setError(null);
    const stateObj = MEXICAN_STATES.find((st) => st.code === estadoNacimientoCode);

    try {
      const res = await api.registerPatientAccount({
        nombres: nombres.trim(),
        apellido_paterno: apellidoPaterno.trim(),
        apellido_materno: apellidoMaterno.trim() || undefined,
        fecha_nacimiento: fechaNacimiento,
        genero,
        estado_nacimiento: stateObj?.name || estadoNacimientoCode,
        pais,
        curp: curp.trim().toUpperCase(),
        telefono: telefono.trim(),
        email: email.trim().toLowerCase(),
        password,
        webSessionId: getOrCreateWebSessionId(),
      });
      savePatientSession(res);
      navigate(nextPath);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No fue posible completar el registro de tu cuenta."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-5">
      <div className="text-center space-y-1">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">
          Crea tu cuenta de paciente
        </h1>
        <p className="text-sm text-slate-500">
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="font-bold text-[#00843D] hover:underline">
            Inicia sesión aquí
          </Link>
        </p>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Réplica fiel de "Perfil del paciente" + Datos de acceso de cuenta */}
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 sm:px-8 py-7 text-[#475569]"
      >
        <h2 className="text-[22px] font-bold text-[#4B5563] leading-snug">Perfil del paciente</h2>
        <p className="text-[15px] text-[#4B5563] mt-2 leading-relaxed">
          Recuerda que los datos deben coincidir con tu identificación oficial, ya que para ciertos
          estudios se requiere presentarla.
        </p>

        <h3 className="text-[17px] font-bold text-[#4B5563] mt-6 mb-4">Datos personales</h3>

        {/* Fila 1 */}
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

        {/* Fila 2 */}
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
              htmlFor="reg-fecha-nacimiento"
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
                id="reg-fecha-nacimiento"
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

        {/* Fila 3: Mujer | Hombre | Estado */}
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

        {/* País * */}
        <div className="mt-4">
          <label className="block text-[14px] font-semibold text-[#1E293B] mb-1.5">País *</label>
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

        {/* CURP * */}
        <div className="mt-4">
          <label className="block text-[14px] font-semibold text-[#1E293B] mb-1.5">CURP *</label>
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

        {/* Teléfono * */}
        <div className="mt-5">
          <input
            type="tel"
            required
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            placeholder="Teléfono * (10 dígitos o +52...)"
            className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
          />
        </div>

        {/* Datos de acceso a la cuenta */}
        <div className="mt-7 pt-6 border-t border-slate-200 space-y-4">
          <h3 className="text-[17px] font-bold text-[#4B5563]">Datos de acceso a tu cuenta</h3>

          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Correo electrónico *"
            className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña * (mín. 6 caracteres)"
              className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
            />
            <input
              type="password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirmar contraseña *"
              className="w-full h-12 rounded-md border border-[#CBD5E1] px-3.5 text-[15px] text-slate-800 placeholder:text-[#94A3B8] focus:outline-none focus:border-[#00843D] focus:ring-1 focus:ring-[#00843D]"
            />
          </div>

          {confirmPassword && password !== confirmPassword && (
            <p className="text-xs text-rose-600 font-medium">Las contraseñas no coinciden.</p>
          )}
        </div>

        <p className="text-[14px] text-[#4B5563] mt-4">* Estos campos son obligatorios.</p>

        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            disabled={!isFormValid || submitting}
            className={`min-w-[240px] h-12 px-8 rounded-md font-semibold text-[15px] text-white transition ${
              isFormValid && !submitting
                ? "bg-[#00843D] hover:bg-[#006E32] shadow-sm cursor-pointer"
                : "bg-[#A1A8B0] cursor-not-allowed"
            }`}
          >
            {submitting ? "Creando cuenta..." : "Crear cuenta y continuar"}
          </button>
        </div>
      </form>
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
