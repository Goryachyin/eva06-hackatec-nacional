import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  CalendarCheck,
  FlaskConical,
  Home,
  LogIn,
  LogOut,
  Phone,
  ShieldCheck,
  User,
  UserPlus,
} from "lucide-react";
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
    <div className="min-h-screen flex flex-col bg-[#F5F7FA]">
      {/* Barra superior institucional limpia estilo salud-digna.org */}
      <div className="bg-[#005A2B] text-white text-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-9 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 truncate">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
            <span className="font-medium truncate">
              Salud Digna · Prevención y diagnóstico oportuno al alcance de todos
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-emerald-100 shrink-0">
            <span className="inline-flex items-center gap-1.5">
              <Phone className="w-3 h-3" />
              Atención: 55 3956 6729
            </span>
            <span>10% de descuento pagando en línea</span>
          </div>
        </div>
      </div>

      {/* Header público limpio (cero enlaces a Admin, Call Center o Simuladores) */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200/90 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 gap-4">
            {/* Marca Salud Digna */}
            <Link to="/" className="flex items-center gap-3 shrink-0 group">
              <div className="w-10 h-10 rounded-xl bg-[#00843D] flex items-center justify-center shadow-sm group-hover:bg-[#006E32] transition">
                <svg
                  viewBox="0 0 24 24"
                  className="w-6 h-6 text-white"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="text-lg font-extrabold tracking-tight text-[#00843D]">
                  Salud Digna
                </div>
                <div className="text-[11px] font-medium text-slate-500">
                  La salud es para todos
                </div>
              </div>
            </Link>

            {/* Navegación del Paciente */}
            <nav className="hidden md:flex items-center gap-1">
              <Link
                to="/"
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                  isActive("/")
                    ? "bg-[#E6F4EC] text-[#005A2B] font-semibold"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Home className="w-4 h-4" />
                Inicio
              </Link>
              <Link
                to="/laboratorio"
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                  isActive("/laboratorio") || isActive("/web")
                    ? "bg-[#E6F4EC] text-[#005A2B] font-semibold"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <FlaskConical className="w-4 h-4" />
                Estudios y Citas
              </Link>
              {patient && (
                <Link
                  to="/mi-cuenta"
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                    isActive("/mi-cuenta")
                      ? "bg-[#E6F4EC] text-[#005A2B] font-semibold"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <CalendarCheck className="w-4 h-4" />
                  Mis Citas
                </Link>
              )}
            </nav>

            {/* Acciones de Cuenta del Paciente */}
            <div className="flex items-center gap-2 shrink-0">
              {patient ? (
                <>
                  <Link
                    to="/mi-cuenta"
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#E6F4EC] hover:bg-[#d8efe2] text-[#005A2B] text-sm font-semibold transition"
                  >
                    <User className="w-4 h-4" />
                    <span className="max-w-[140px] truncate">
                      {patient.nombres || "Mi Cuenta"}
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={handleLogout}
                    title="Cerrar sesión"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 text-slate-600 text-sm font-medium transition"
                  >
                    <LogOut className="w-4 h-4" />
                    <span className="hidden sm:inline">Salir</span>
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold transition"
                  >
                    <LogIn className="w-4 h-4" />
                    Iniciar sesión
                  </Link>
                  <Link
                    to="/registro"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#00843D] hover:bg-[#006E32] text-white text-sm font-semibold shadow-sm transition"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span className="hidden sm:inline">Crear cuenta</span>
                  </Link>
                </>
              )}
            </div>
          </div>

          {/* Navegación móvil */}
          <div className="flex md:hidden items-center gap-2 pb-2.5 overflow-x-auto">
            <Link
              to="/"
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${
                isActive("/") ? "bg-[#00843D] text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              Inicio
            </Link>
            <Link
              to="/laboratorio"
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${
                isActive("/laboratorio")
                  ? "bg-[#00843D] text-white"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              Estudios y Citas
            </Link>
            {patient && (
              <Link
                to="/mi-cuenta"
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${
                  isActive("/mi-cuenta")
                    ? "bg-[#00843D] text-white"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                Mis Citas
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      {/* Footer público limpio */}
      <footer className="bg-white border-t border-slate-200 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#00843D]" />
            <span>© {new Date().getFullYear()} Salud Digna A.C. · Atención Omnicanal al Paciente</span>
          </div>
          <div className="flex items-center gap-5">
            <Link to="/laboratorio" className="hover:text-[#00843D] font-medium">
              Estudios y Citas
            </Link>
            <Link to="/mi-cuenta" className="hover:text-[#00843D] font-medium">
              Mi Cuenta
            </Link>
            <Link to="/privacy" className="hover:text-[#00843D] font-medium">
              Aviso de Privacidad
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
};
