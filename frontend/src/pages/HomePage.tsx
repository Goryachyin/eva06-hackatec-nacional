import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FlaskConical,
  HeartPulse,
  MapPin,
  MessageSquareHeart,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import { getPatientToken } from "../lib/api";

const FEATURED_SERVICES = [
  {
    title: "Laboratorio Clínico",
    category: "Laboratorio",
    desc: "Biometría hemática, química sanguínea y perfiles preventivos con resultados rápidos y confiables.",
    priceFrom: "Desde $110 MXN",
    icon: FlaskConical,
    accent: "bg-emerald-50 text-[#00843D]",
  },
  {
    title: "Ultrasonido",
    category: "Ultrasonido",
    desc: "Ultrasonido obstétrico, abdominal y Doppler con médicos especialistas y tecnología de alta definición.",
    priceFrom: "Desde $320 MXN",
    icon: Stethoscope,
    accent: "bg-blue-50 text-[#0066B3]",
  },
  {
    title: "Cardiología (ECG)",
    category: "Cardiología",
    desc: "Electrocardiograma en reposo interpretado con precisión diagnóstica para prevención cardiovascular.",
    priceFrom: "Desde $150 MXN",
    icon: HeartPulse,
    accent: "bg-rose-50 text-rose-600",
  },
  {
    title: "Imagenología",
    category: "Imagenología",
    desc: "Mastografía bilateral, rayos X digitales y estudios preventivos de baja radiación.",
    priceFrom: "Desde $295 MXN",
    icon: ScanLine,
    accent: "bg-indigo-50 text-indigo-600",
  },
];

export const HomePage: React.FC = () => {
  const isLoggedIn = Boolean(getPatientToken());

  return (
    <div className="space-y-14 pb-12">
      {/* Hero Comercial Limpio estilo salud-digna.org */}
      <section className="bg-gradient-to-br from-[#005A2B] via-[#007A38] to-[#00843D] text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-7 space-y-5">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 text-emerald-100 text-xs font-semibold tracking-wide">
                <ShieldCheck className="w-4 h-4 text-emerald-300" />
                Prevención y diagnóstico accesible en todo México
              </div>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold leading-tight tracking-tight">
                Agenda tus estudios de salud en minutos,{" "}
                <span className="text-emerald-200">sin repetir tus datos</span>
              </h1>
              <p className="text-emerald-50/90 text-base sm:text-lg max-w-2xl leading-relaxed">
                Crea tu cuenta de paciente para solicitar estudios de laboratorio, ultrasonido e
                imagenología, consultar tus citas confirmadas y continuar tu atención por WhatsApp o
                teléfono exactamente donde la dejaste.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link
                  to="/laboratorio"
                  className="inline-flex items-center gap-2 bg-white text-[#005A2B] hover:bg-emerald-50 font-bold px-6 py-3.5 rounded-xl shadow-md transition"
                >
                  <CalendarCheck className="w-5 h-5" />
                  Solicitar estudio ahora
                  <ArrowRight className="w-4 h-4" />
                </Link>

                {isLoggedIn ? (
                  <Link
                    to="/mi-cuenta"
                    className="inline-flex items-center gap-2 bg-[#004421]/60 hover:bg-[#004421] text-white border border-white/25 font-semibold px-5 py-3.5 rounded-xl transition"
                  >
                    Ver mis citas
                  </Link>
                ) : (
                  <Link
                    to="/registro"
                    className="inline-flex items-center gap-2 bg-[#004421]/60 hover:bg-[#004421] text-white border border-white/25 font-semibold px-5 py-3.5 rounded-xl transition"
                  >
                    <UserPlus className="w-4 h-4 text-emerald-300" />
                    Crear cuenta de paciente
                  </Link>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 max-w-xl text-xs sm:text-sm text-emerald-100/95">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-300 shrink-0" />
                  <span>10% de descuento en línea</span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-emerald-300 shrink-0" />
                  <span>Clínicas cerca de ti</span>
                </div>
                <div className="flex items-center gap-2">
                  <MessageSquareHeart className="w-4 h-4 text-emerald-300 shrink-0" />
                  <span>Atención continua multicanal</span>
                </div>
              </div>
            </div>

            {/* Tarjeta de Beneficios de Cuenta Salud Digna */}
            <div className="lg:col-span-5">
              <div className="bg-white text-slate-800 rounded-2xl p-6 sm:p-7 shadow-xl border border-emerald-900/10 space-y-5">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-[#00843D]">
                    Tu Cuenta de Paciente
                  </span>
                  <h2 className="text-xl font-extrabold text-slate-900 mt-1">
                    Todo tu historial de citas en un solo lugar
                  </h2>
                </div>

                <ul className="space-y-3 text-sm text-slate-600">
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-5 h-5 text-[#00843D] shrink-0 mt-0.5" />
                    <span>
                      <strong>Pre-registro automático:</strong> llena tu perfil una sola vez con tu
                      CURP generada al instante.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-5 h-5 text-[#00843D] shrink-0 mt-0.5" />
                    <span>
                      <strong>Sin perder tu avance:</strong> guarda una cotización y retómala desde
                      tu cuenta, WhatsApp o teléfono.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-5 h-5 text-[#00843D] shrink-0 mt-0.5" />
                    <span>
                      <strong>Folio y preparación a la mano:</strong> consulta tu código QR e
                      indicaciones de ayuno antes de acudir.
                    </span>
                  </li>
                </ul>

                <div className="pt-2 flex flex-col sm:flex-row gap-2.5">
                  {isLoggedIn ? (
                    <Link
                      to="/mi-cuenta"
                      className="w-full text-center bg-[#00843D] hover:bg-[#006E32] text-white font-bold py-3 px-4 rounded-xl text-sm transition shadow-sm"
                    >
                      Ir a Mi Cuenta
                    </Link>
                  ) : (
                    <>
                      <Link
                        to="/registro"
                        className="flex-1 text-center bg-[#00843D] hover:bg-[#006E32] text-white font-bold py-3 px-4 rounded-xl text-sm transition shadow-sm"
                      >
                        Registrarme
                      </Link>
                      <Link
                        to="/login"
                        className="flex-1 text-center bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold py-3 px-4 rounded-xl text-sm transition"
                      >
                        Iniciar sesión
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Servicios principales */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-[#00843D]">
              Servicios Médicos
            </span>
            <h2 className="text-2xl font-extrabold text-slate-900 mt-1">
              ¿Qué estudio necesitas hoy?
            </h2>
          </div>
          <Link
            to="/laboratorio"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0066B3] hover:underline"
          >
            Ver catálogo completo
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {FEATURED_SERVICES.map((svc) => {
            const Icon = svc.icon;
            return (
              <Link
                key={svc.title}
                to={`/laboratorio?cat=${encodeURIComponent(svc.category)}`}
                className="group bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md hover:border-[#00843D]/40 transition flex flex-col justify-between"
              >
                <div>
                  <div
                    className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${svc.accent}`}
                  >
                    <Icon className="w-6 h-6" />
                  </div>
                  <h3 className="text-base font-bold text-slate-900 group-hover:text-[#00843D] transition">
                    {svc.title}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{svc.desc}</p>
                </div>

                <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs font-bold text-[#00843D]">{svc.priceFrom}</span>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#0066B3] group-hover:translate-x-0.5 transition">
                    Agendar
                    <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Pasos claros para el paciente */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <span className="text-xs font-bold uppercase tracking-wider text-[#0066B3]">
              ¿Cómo funciona?
            </span>
            <h2 className="text-2xl font-extrabold text-slate-900 mt-1">
              Agenda tu estudio en 3 sencillos pasos
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              {
                num: "01",
                title: "Elige estudio y clínica",
                desc: "Consulta precios transparentes, requisitos de ayuno y selecciona la clínica y horario que prefieras.",
              },
              {
                num: "02",
                title: "Pre-registro rápido",
                desc: "Usa tu cuenta de Salud Digna para cargar tus datos automáticamente o completa tu perfil en segundos.",
              },
              {
                num: "03",
                title: "Confirma o retoma después",
                desc: "Elige tu método de pago o guarda tu borrador para concluirlo desde tu cuenta, WhatsApp o teléfono.",
              },
            ].map((item) => (
              <div
                key={item.num}
                className="p-5 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2"
              >
                <div className="text-xs font-extrabold text-[#00843D] tracking-widest">
                  PASO {item.num}
                </div>
                <h3 className="text-base font-bold text-slate-900">{item.title}</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};
