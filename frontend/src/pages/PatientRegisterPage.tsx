import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, getOrCreateWebSessionId, savePatientSession } from "../lib/api";
import { generateDeterministicCurp, MEXICAN_STATES } from "../lib/curp";

export const PatientRegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = searchParams.get("next") || "/mi-cuenta";

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

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateInputRef = useRef<HTMLInputElement | null>(null);

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
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 bg-[#FFFFFF] text-[#1F2933] space-y-8">
      <header className="pb-6 border-b border-[#E4E7EB] space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
          Registro de paciente
        </p>
        <h1 className="text-3xl font-bold text-[#1F2933]">Crea tu cuenta de paciente</h1>
        <p className="text-sm text-[#52606D]">
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="font-semibold text-[#00875A] hover:underline">
            Inicia sesión aquí
          </Link>
        </p>
      </header>

      {error && (
        <p className="border-l-2 border-[#B42318] pl-4 py-1 text-sm text-[#B42318]">{error}</p>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <section className="space-y-5">
          <div>
            <h2 className="text-lg font-bold text-[#1F2933]">Perfil del paciente</h2>
            <p className="text-sm text-[#52606D] mt-1">
              Los datos deben coincidir con tu identificación oficial, ya que para ciertos estudios
              se requiere presentarla.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="reg-nombres" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Nombre(s) *
              </label>
              <input
                id="reg-nombres"
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
              <label htmlFor="reg-paterno" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Apellido paterno *
              </label>
              <input
                id="reg-paterno"
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
              <label htmlFor="reg-materno" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Apellido materno
              </label>
              <input
                id="reg-materno"
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
                htmlFor="reg-fecha-nacimiento"
                className="block text-xs font-semibold text-[#1F2933] mb-1.5"
              >
                Fecha de nacimiento *
              </label>
              <div
                onClick={() => dateInputRef.current?.showPicker?.()}
                className="relative w-full h-11 border border-[#E4E7EB] px-3.5 flex items-center justify-between bg-[#FFFFFF] cursor-pointer"
              >
                <p className="text-sm text-[#1F2933]">{formatDateDisplay(fechaNacimiento)}</p>
                <small className="text-xs font-semibold text-[#00875A]">Calendario</small>
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
              <label htmlFor="reg-estado" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Estado de nacimiento *
              </label>
              <select
                id="reg-estado"
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
              <label htmlFor="reg-pais" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                País *
              </label>
              <select
                id="reg-pais"
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
              <label htmlFor="reg-curp" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                CURP *
              </label>
              <input
                id="reg-curp"
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
            <label htmlFor="reg-tel" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
              Teléfono *
            </label>
            <input
              id="reg-tel"
              type="tel"
              required
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="10 dígitos o +52..."
              className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
            />
          </div>
        </section>

        <section className="pt-8 border-t border-[#E4E7EB] space-y-4">
          <h2 className="text-lg font-bold text-[#1F2933]">Datos de acceso a tu cuenta</h2>

          <div>
            <label htmlFor="reg-email" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
              Correo electrónico *
            </label>
            <input
              id="reg-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ejemplo@correo.com"
              className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="reg-pass" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Contraseña * (mín. 6 caracteres)
              </label>
              <input
                id="reg-pass"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
            </div>

            <div>
              <label htmlFor="reg-pass-confirm" className="block text-xs font-semibold text-[#1F2933] mb-1.5">
                Confirmar contraseña *
              </label>
              <input
                id="reg-pass-confirm"
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full h-11 border border-[#E4E7EB] px-3.5 text-sm text-[#1F2933] focus:border-[#00875A]"
              />
            </div>
          </div>

          {confirmPassword && password !== confirmPassword && (
            <p className="text-xs font-medium text-[#B42318]">Las contraseñas no coinciden.</p>
          )}
        </section>

        <div className="pt-6 border-t border-[#E4E7EB] flex items-center justify-between gap-4">
          <p className="text-xs text-[#52606D]">* Campos obligatorios</p>
          <button
            type="submit"
            disabled={!isFormValid || submitting}
            className="h-12 px-8 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Creando cuenta..." : "Crear cuenta y continuar"}
          </button>
        </div>
      </form>
    </div>
  );
};
