import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { clearPatientSession, getPatientToken, getStoredPatient } from "../../lib/api";
import { PatientProfile } from "../../types/api";

interface PublicLayoutProps {
  children: React.ReactNode;
}

export const PublicLayout: React.FC<PublicLayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<PatientProfile | null>(() =>
    getPatientToken() ? getStoredPatient() : null
  );

  useEffect(() => {
    const syncAuth = () => {
      setPatient(getPatientToken() ? getStoredPatient() : null);
    };
    window.addEventListener("sd-patient-auth-change", syncAuth);
    window.addEventListener("storage", syncAuth);
    return () => {
      window.removeEventListener("sd-patient-auth-change", syncAuth);
      window.removeEventListener("storage", syncAuth);
    };
  }, []);

  const handleLogout = () => {
    clearPatientSession();
    setPatient(null);
    navigate("/");
  };

  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  return (
    <div className="min-h-screen flex flex-col bg-[#FFFFFF] text-[#1F2933]">
      {/* Franja superior estructural (superficie secundaria #F7F8F9) */}
      <aside className="bg-[#F7F8F9] border-b border-[#E4E7EB] text-xs text-[#52606D]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-9 flex items-center justify-between gap-4">
          <p className="truncate font-medium">
            Salud Digna · Prevención y diagnóstico oportuno
          </p>
          <p className="hidden sm:block shrink-0">
            Atención telefónica: <strong className="text-[#1F2933] font-semibold">55 3956 6729</strong>{" "}
            · 10% de descuento pagando en línea
          </p>
        </div>
      </aside>

      {/* Encabezado principal plano con divisor de 1px */}
      <header className="sticky top-0 z-40 bg-[#FFFFFF] border-b border-[#E4E7EB]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 gap-6">
            {/* Marca Salud Digna en verde esmeralda #00875A */}
            <Link to="/" className="flex items-center gap-3 shrink-0">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="w-6 h-6 text-[#00875A] shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="square"
              >
                <path d="M12 4v16M4 12h16" />
              </svg>
              <div className="leading-tight">
                <strong className="block text-base font-bold tracking-tight text-[#00875A]">
                  Salud Digna
                </strong>
                <small className="block text-[11px] font-normal text-[#52606D]">
                  Diagnóstico clínico
                </small>
              </div>
            </Link>

            {/* Navegación principal con indicador inferior en #00875A */}
            <nav aria-label="Navegación principal" className="hidden md:flex items-center gap-6 h-16">
              <Link
                to="/"
                className={`h-full inline-flex items-center text-sm border-b-2 transition-colors ${
                  isActive("/")
                    ? "border-[#00875A] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                }`}
              >
                Inicio
              </Link>
              <Link
                to="/laboratorio"
                className={`h-full inline-flex items-center text-sm border-b-2 transition-colors ${
                  isActive("/laboratorio") || isActive("/web")
                    ? "border-[#00875A] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                }`}
              >
                Estudios y citas
              </Link>
              {patient && (
                <Link
                  to="/mi-cuenta"
                  className={`h-full inline-flex items-center text-sm border-b-2 transition-colors ${
                    isActive("/mi-cuenta")
                      ? "border-[#00875A] text-[#00875A] font-semibold"
                      : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                  }`}
                >
                  Mis citas
                </Link>
              )}
            </nav>

            {/* Acciones de cuenta discretas (sin naranja ni cajas flotantes) */}
            <div className="flex items-center gap-4 shrink-0">
              {patient ? (
                <>
                  <Link
                    to="/mi-cuenta"
                    className="text-sm font-semibold text-[#00875A] hover:underline max-w-[160px] truncate"
                  >
                    {patient.nombres || "Mi cuenta"}
                  </Link>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="px-3 py-1.5 border border-[#E4E7EB] text-sm font-medium text-[#52606D] hover:border-[#1F2933] hover:text-[#1F2933] transition-colors"
                  >
                    Salir
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="text-sm font-medium text-[#1F2933] hover:text-[#00875A] transition-colors"
                  >
                    Iniciar sesión
                  </Link>
                  <Link
                    to="/registro"
                    className="px-3.5 py-2 border border-[#00875A] text-sm font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                  >
                    Crear cuenta
                  </Link>
                </>
              )}
            </div>
          </div>

          {/* Navegación móvil plana */}
          <nav
            aria-label="Navegación móvil"
            className="flex md:hidden items-center gap-5 border-t border-[#E4E7EB] overflow-x-auto"
          >
            <Link
              to="/"
              className={`shrink-0 py-2.5 text-xs border-b-2 ${
                isActive("/")
                  ? "border-[#00875A] text-[#00875A] font-semibold"
                  : "border-transparent text-[#52606D]"
              }`}
            >
              Inicio
            </Link>
            <Link
              to="/laboratorio"
              className={`shrink-0 py-2.5 text-xs border-b-2 ${
                isActive("/laboratorio") || isActive("/web")
                  ? "border-[#00875A] text-[#00875A] font-semibold"
                  : "border-transparent text-[#52606D]"
              }`}
            >
              Estudios y citas
            </Link>
            {patient && (
              <Link
                to="/mi-cuenta"
                className={`shrink-0 py-2.5 text-xs border-b-2 ${
                  isActive("/mi-cuenta")
                    ? "border-[#00875A] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D]"
                }`}
              >
                Mis citas
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 bg-[#FFFFFF]">{children}</main>

      {/* Pie de página estructural en #F7F8F9 */}
      <footer className="bg-[#F7F8F9] border-t border-[#E4E7EB] mt-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-[#52606D]">
          <p>© {new Date().getFullYear()} Salud Digna A.C. · Atención omnicanal al paciente</p>
          <ul className="flex flex-wrap items-center gap-6">
            <li>
              <Link to="/laboratorio" className="hover:text-[#00875A] font-medium">
                Estudios y citas
              </Link>
            </li>
            <li>
              <Link to="/mi-cuenta" className="hover:text-[#00875A] font-medium">
                Mi cuenta
              </Link>
            </li>
            <li>
              <Link to="/privacy" className="hover:text-[#00875A] font-medium">
                Aviso de privacidad
              </Link>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
};
