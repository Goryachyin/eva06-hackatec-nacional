import React from "react";
import { StaffUser } from "../../types/api";

export type AdminTab = "overview" | "user-lookup" | "architecture";

interface AdminLayoutProps {
  user: StaffUser | null;
  activeTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
  sseStatus: "disconnected" | "connected" | "reconnecting";
  onLogout: () => void;
  children: React.ReactNode;
}

export const AdminLayout: React.FC<AdminLayoutProps> = ({
  user,
  activeTab,
  onSelectTab,
  sseStatus,
  onLogout,
  children,
}) => {
  return (
    <div className="min-h-screen flex bg-[#FFFFFF] text-[#1F2933]">
      {/* Barra lateral estructural en #F7F8F9 con divisor de 1px */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-[#F7F8F9] border-r border-[#E4E7EB] shrink-0">
        <div className="h-16 px-6 flex items-center gap-3 border-b border-[#E4E7EB]">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="w-5 h-5 text-[#00875A] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="square"
          >
            <path d="M12 4v16M4 12h16" />
          </svg>
          <div className="leading-tight">
            <strong className="block text-sm font-bold text-[#00875A]">Salud Digna</strong>
            <small className="block text-[11px] text-[#52606D]">Administración central</small>
          </div>
        </div>

        <nav aria-label="Navegación administración" className="flex-1 py-6">
          <p className="px-6 pb-2 text-[11px] font-semibold uppercase tracking-wider text-[#52606D]">
            Observabilidad
          </p>
          <ul className="border-t border-[#E4E7EB]">
            <li className="border-b border-[#E4E7EB]">
              <button
                type="button"
                onClick={() => onSelectTab("overview")}
                className={`w-full text-left px-6 py-3 text-sm border-l-2 transition-colors ${
                  activeTab === "overview"
                    ? "border-[#00875A] bg-[#FFFFFF] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                }`}
              >
                Estadísticas del servicio
              </button>
            </li>
            <li className="border-b border-[#E4E7EB]">
              <button
                type="button"
                onClick={() => onSelectTab("user-lookup")}
                className={`w-full text-left px-6 py-3 text-sm border-l-2 transition-colors ${
                  activeTab === "user-lookup"
                    ? "border-[#00875A] bg-[#FFFFFF] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                }`}
              >
                Consultar usuario
              </button>
            </li>
            <li className="border-b border-[#E4E7EB]">
              <button
                type="button"
                onClick={() => onSelectTab("architecture")}
                className={`w-full text-left px-6 py-3 text-sm border-l-2 transition-colors ${
                  activeTab === "architecture"
                    ? "border-[#00875A] bg-[#FFFFFF] text-[#00875A] font-semibold"
                    : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                }`}
              >
                Arquitectura y bus
              </button>
            </li>
          </ul>
        </nav>

        <div className="p-6 border-t border-[#E4E7EB] space-y-4">
          <dl className="text-xs space-y-1">
            <dt className="text-[#52606D]">Conexión SSE</dt>
            <dd
              className={`font-semibold ${
                sseStatus === "connected" ? "text-[#00875A]" : "text-[#52606D]"
              }`}
            >
              {sseStatus === "connected" ? "Stream activo" : "Reconectando"}
            </dd>
            <dt className="text-[#52606D] pt-2">Seguridad</dt>
            <dd className="text-[#1F2933]">PII enmascarada · RBAC ADMIN</dd>
          </dl>

          {user && (
            <div className="pt-4 border-t border-[#E4E7EB] space-y-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#1F2933] truncate">{user.fullName}</p>
                <p className="text-[11px] text-[#52606D] truncate">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="w-full py-2 px-3 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933] hover:border-[#1F2933] transition-colors"
              >
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Área principal blanca */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Encabezado móvil/tablet */}
        <header className="lg:hidden bg-[#F7F8F9] border-b border-[#E4E7EB] px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <strong className="text-sm font-bold text-[#00875A]">
              Salud Digna · Administración
            </strong>
            <button
              type="button"
              onClick={onLogout}
              className="px-2.5 py-1 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-medium text-[#1F2933]"
            >
              Salir
            </button>
          </div>
          <nav aria-label="Navegación móvil administración" className="flex items-center gap-4 border-t border-[#E4E7EB] pt-2">
            <button
              type="button"
              onClick={() => onSelectTab("overview")}
              className={`text-xs pb-1 border-b-2 ${
                activeTab === "overview"
                  ? "border-[#00875A] text-[#00875A] font-semibold"
                  : "border-transparent text-[#52606D]"
              }`}
            >
              Estadísticas
            </button>
            <button
              type="button"
              onClick={() => onSelectTab("user-lookup")}
              className={`text-xs pb-1 border-b-2 ${
                activeTab === "user-lookup"
                  ? "border-[#00875A] text-[#00875A] font-semibold"
                  : "border-transparent text-[#52606D]"
              }`}
            >
              Usuarios
            </button>
            <button
              type="button"
              onClick={() => onSelectTab("architecture")}
              className={`text-xs pb-1 border-b-2 ${
                activeTab === "architecture"
                  ? "border-[#00875A] text-[#00875A] font-semibold"
                  : "border-transparent text-[#52606D]"
              }`}
            >
              Bus de datos
            </button>
          </nav>
        </header>

        {/* Sub-encabezado de escritorio */}
        <header className="hidden lg:flex h-16 bg-[#FFFFFF] border-b border-[#E4E7EB] px-8 items-center justify-between">
          <h1 className="text-base font-bold text-[#1F2933]">
            {activeTab === "overview"
              ? "Panel de estadísticas y telemetría del servicio"
              : activeTab === "user-lookup"
              ? "Consulta de estado y rastreo por usuario"
              : "Arquitectura del bus de datos y módulos en tiempo real"}
          </h1>
          <p
            className={`text-xs font-semibold ${
              sseStatus === "connected" ? "text-[#00875A]" : "text-[#52606D]"
            }`}
          >
            {sseStatus === "connected" ? "En vivo · Redis Pub/Sub y SSE" : "Reconectando stream..."}
          </p>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto bg-[#FFFFFF]">
          {children}
        </main>
      </div>
    </div>
  );
};
