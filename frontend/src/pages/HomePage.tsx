import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getPatientToken } from "../lib/api";

const FEATURED_SERVICES = [
  {
    title: "Laboratorio Clínico",
    category: "Laboratorio",
    desc: "Biometría hemática, química sanguínea y perfiles preventivos con resultados rápidos y confiables.",
    priceFrom: "Desde $110 MXN",
  },
  {
    title: "Ultrasonido",
    category: "Ultrasonido",
    desc: "Ultrasonido obstétrico, abdominal y Doppler con médicos especialistas y tecnología de alta definición.",
    priceFrom: "Desde $320 MXN",
  },
  {
    title: "Cardiología (ECG)",
    category: "Cardiología",
    desc: "Electrocardiograma en reposo interpretado con precisión diagnóstica para prevención cardiovascular.",
    priceFrom: "Desde $150 MXN",
  },
  {
    title: "Imagenología",
    category: "Imagenología",
    desc: "Mastografía bilateral, rayos X digitales y estudios preventivos de baja radiación.",
    priceFrom: "Desde $295 MXN",
  },
];

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const isLoggedIn = Boolean(getPatientToken());
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchTerm.trim();
    navigate(q ? `/laboratorio?q=${encodeURIComponent(q)}` : "/laboratorio");
  };

  return (
    <div className="bg-[#FFFFFF] text-[#1F2933]">
      {/* Hero editorial abierto en dos columnas con amplio margen vertical */}
      <section className="border-b border-[#E4E7EB]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
            <div className="lg:col-span-7 space-y-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                Prevención y diagnóstico clínico
              </p>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight tracking-tight text-[#1F2933]">
                Agenda tus estudios de salud en minutos, sin repetir tus datos
              </h1>
              <p className="text-base text-[#52606D] max-w-2xl leading-relaxed">
                Solicita estudios de laboratorio, ultrasonido e imagenología con precios claros.
                Conserva tu avance y continúa tu atención por sitio web, WhatsApp o teléfono desde
                el mismo punto.
              </p>

              {/* Buscador plano con borde simple de 1px */}
              <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3 max-w-xl pt-2">
                <label htmlFor="home-study-search" className="sr-only">
                  Buscar estudio clínico
                </label>
                <input
                  id="home-study-search"
                  type="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar estudio (ej. ultrasonido, biometría, rayos X)..."
                  className="flex-1 h-12 px-4 border border-[#E4E7EB] bg-[#FFFFFF] text-sm text-[#1F2933] placeholder:text-[#52606D] focus:border-[#00875A]"
                />
                <button
                  type="submit"
                  className="h-12 px-5 border border-[#00875A] bg-[#FFFFFF] text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] text-sm font-semibold transition-colors shrink-0"
                >
                  Buscar
                </button>
              </form>

              {/* Acción principal única en naranja cálido #E86A17 */}
              <div className="flex flex-wrap items-center gap-6 pt-2">
                <Link
                  to="/laboratorio"
                  className="inline-flex items-center justify-center h-12 px-6 bg-[#E86A17] hover:bg-[#CF5B0E] text-[#FFFFFF] text-sm font-semibold transition-colors"
                >
                  Agendar cita
                </Link>

                {isLoggedIn ? (
                  <Link
                    to="/mi-cuenta"
                    className="text-sm font-semibold text-[#00875A] hover:underline"
                  >
                    Ver mis citas →
                  </Link>
                ) : (
                  <Link
                    to="/registro"
                    className="text-sm font-semibold text-[#00875A] hover:underline"
                  >
                    Crear cuenta de paciente →
                  </Link>
                )}
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-6 border-t border-[#E4E7EB] text-xs">
                <div>
                  <dt className="font-semibold text-[#1F2933]">10% de descuento</dt>
                  <dd className="text-[#52606D] mt-1">Al pagar tus estudios en línea</dd>
                </div>
                <div>
                  <dt className="font-semibold text-[#1F2933]">Clínicas cercanas</dt>
                  <dd className="text-[#52606D] mt-1">Horarios amplios y atención puntual</dd>
                </div>
                <div>
                  <dt className="font-semibold text-[#1F2933]">Atención continua</dt>
                  <dd className="text-[#52606D] mt-1">Web, WhatsApp y Call Center sincronizados</dd>
                </div>
              </dl>
            </div>

            {/* Columna derecha abierta con divisor vertical */}
            <aside className="lg:col-span-5 lg:border-l lg:border-[#E4E7EB] lg:pl-12 space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
                  Cuenta de paciente
                </p>
                <h2 className="text-xl font-bold text-[#1F2933] mt-1">
                  Todo tu historial de citas en un solo lugar
                </h2>
              </div>

              <ul className="divide-y divide-[#E4E7EB] border-t border-b border-[#E4E7EB] text-sm">
                <li className="py-4">
                  <strong className="block font-semibold text-[#1F2933]">
                    Pre-registro automático
                  </strong>
                  <p className="text-[#52606D] mt-1 leading-relaxed">
                    Completa tu perfil una sola vez con generación automática de CURP para ti y tus
                    familiares.
                  </p>
                </li>
                <li className="py-4">
                  <strong className="block font-semibold text-[#1F2933]">
                    Sin perder tu avance
                  </strong>
                  <p className="text-[#52606D] mt-1 leading-relaxed">
                    Guarda una cotización y retómala después desde tu cuenta, WhatsApp o por
                    teléfono.
                  </p>
                </li>
                <li className="py-4">
                  <strong className="block font-semibold text-[#1F2933]">
                    Folio e indicaciones claras
                  </strong>
                  <p className="text-[#52606D] mt-1 leading-relaxed">
                    Consulta tu folio de confirmación y los requisitos de preparación antes de
                    acudir a clínica.
                  </p>
                </li>
              </ul>

              <div className="flex flex-wrap items-center gap-4">
                {isLoggedIn ? (
                  <Link
                    to="/mi-cuenta"
                    className="inline-flex items-center justify-center px-5 py-2.5 border border-[#00875A] text-sm font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                  >
                    Ir a mi cuenta
                  </Link>
                ) : (
                  <>
                    <Link
                      to="/registro"
                      className="inline-flex items-center justify-center px-5 py-2.5 border border-[#00875A] text-sm font-semibold text-[#00875A] hover:bg-[#00875A] hover:text-[#FFFFFF] transition-colors"
                    >
                      Registrarme
                    </Link>
                    <Link
                      to="/login"
                      className="inline-flex items-center justify-center px-5 py-2.5 border border-[#E4E7EB] text-sm font-medium text-[#1F2933] hover:border-[#1F2933] transition-colors"
                    >
                      Iniciar sesión
                    </Link>
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* Catálogo de áreas médicas en lista vertical limpia separada por 1px #E4E7EB */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-[#E4E7EB]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Servicios médicos
            </p>
            <h2 className="text-2xl font-bold text-[#1F2933] mt-1">
              ¿Qué estudio necesitas hoy?
            </h2>
          </div>
          <Link
            to="/laboratorio"
            className="text-sm font-semibold text-[#00875A] hover:underline"
          >
            Ver catálogo completo →
          </Link>
        </div>

        <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
          {FEATURED_SERVICES.map((svc) => (
            <li
              key={svc.title}
              className="py-6 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="max-w-2xl">
                <h3 className="text-lg font-bold text-[#1F2933]">{svc.title}</h3>
                <p className="text-sm text-[#52606D] mt-1 leading-relaxed">{svc.desc}</p>
              </div>
              <div className="flex items-center justify-between md:justify-end gap-8 shrink-0">
                <strong className="text-base font-bold text-[#1F2933]">{svc.priceFrom}</strong>
                <Link
                  to={`/laboratorio?cat=${encodeURIComponent(svc.category)}`}
                  className="text-sm font-semibold text-[#00875A] hover:underline"
                >
                  Seleccionar →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Proceso en 3 pasos en lista ordenada semántica */}
      <section className="border-t border-[#E4E7EB]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="pb-8 border-b border-[#E4E7EB]">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
              Proceso de atención
            </p>
            <h2 className="text-2xl font-bold text-[#1F2933] mt-1">
              Agenda tu estudio en tres pasos
            </h2>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#E4E7EB] border-b border-[#E4E7EB]">
            {[
              {
                num: "01",
                title: "Elige estudio y clínica",
                desc: "Consulta precios transparentes, requisitos de preparación y selecciona la sucursal y horario que prefieras.",
              },
              {
                num: "02",
                title: "Pre-registro rápido",
                desc: "Utiliza tu cuenta de Salud Digna para precargar tus datos o completa el perfil del paciente en segundos.",
              },
              {
                num: "03",
                title: "Confirma o retoma después",
                desc: "Selecciona tu forma de pago o guarda tu borrador para concluirlo desde tu cuenta, WhatsApp o teléfono.",
              },
            ].map((item, idx) => (
              <li
                key={item.num}
                className={`py-8 ${idx === 0 ? "md:pr-8" : idx === 1 ? "md:px-8" : "md:pl-8"}`}
              >
                <strong className="block text-xs font-bold uppercase tracking-widest text-[#00875A]">
                  Paso {item.num}
                </strong>
                <h3 className="text-base font-bold text-[#1F2933] mt-2">{item.title}</h3>
                <p className="text-sm text-[#52606D] mt-2 leading-relaxed">{item.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
};
