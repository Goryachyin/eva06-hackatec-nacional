import React from "react";
import {
  Activity,
  BarChart3,
  Cpu,
  LogOut,
  Radio,
  Search,
  ShieldCheck,
} from "lucide-react";
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
    <div className="min-h-screen flex bg-[#F1F5F9] text-slate-800">
      {/* Sidebar Corporativo Independiente — Back-Office Administrador */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-[#0B1F16] text-slate-100 shrink-0 border-r border-emerald-950">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-white/10">
          <div className="w-9 h-9 rounded-lg bg-[#00843D] flex items-center justify-center shadow-sm">
            <Activity className="w-5 h-5 text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-extrabold tracking-tight text-white">
              Salud Digna
            </div>
            <div className="text-[11px] text-emerald-300 font-semibold">
              Administración Central
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1.5">
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Observabilidad
          </div>

          <button
            type="button"
            onClick={() => onSelectTab("overview")}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition ${
              activeTab === "overview"
                ? "bg-[#00843D] text-white shadow-sm"
                : "text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <BarChart3 className="w-4 h-4 shrink-0" />
            Estadísticas del Servicio
          </button>

          <button
            type="button"
            onClick={() => onSelectTab("user-lookup")}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition ${
              activeTab === "user-lookup"
                ? "bg-[#00843D] text-white shadow-sm"
                : "text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Search className="w-4 h-4 shrink-0" />
            Consultar Usuario
          </button>

          <button
            type="button"
            onClick={() => onSelectTab("architecture")}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition ${
              activeTab === "architecture"
                ? "bg-[#00843D] text-white shadow-sm"
                : "text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Cpu className="w-4 h-4 shrink-0" />
            Arquitectura y Bus
          </button>
        </nav>

        <div className="p-4 border-t border-white/10 space-y-3">
          <div className="px-3 py-2 rounded-xl bg-white/5 border border-white/10">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span
                className={`w-2 h-2 rounded-full ${
                  sseStatus === "connected" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                }`}
              />
              <span className="text-emerald-200">
                {sseStatus === "connected" ? "Stream SSE activo" : "Reconectando SSE"}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              PII Enmascarada · RBAC ADMIN
            </div>
          </div>

          {user && (
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="min-w-0">
                <div className="text-xs font-bold text-white truncate">{user.fullName}</div>
                <div className="text-[11px] text-slate-400 truncate">{user.email}</div>
              </div>
              <button
                type="button"
                onClick={onLogout}
                title="Cerrar sesión"
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Área Principal del Back-Office */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar móvil/tablet */}
        <header className="lg:hidden bg-[#0B1F16] text-white px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#00843D] flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-extrabold">Admin · Salud Digna</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onSelectTab("overview")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                activeTab === "overview" ? "bg-[#00843D] text-white" : "text-slate-300"
              }`}
            >
              Estadísticas
            </button>
            <button
              type="button"
              onClick={() => onSelectTab("user-lookup")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                activeTab === "user-lookup" ? "bg-[#00843D] text-white" : "text-slate-300"
              }`}
            >
              Usuarios
            </button>
            <button
              type="button"
              onClick={() => onSelectTab("architecture")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                activeTab === "architecture" ? "bg-[#00843D] text-white" : "text-slate-300"
              }`}
            >
              Bus
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="p-1.5 rounded-lg text-slate-300 hover:bg-white/10"
              title="Salir"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Sub-barra de estado de conexión (desktop) */}
        <div className="hidden lg:flex h-14 bg-white border-b border-slate-200 px-8 items-center justify-between">
          <div className="text-sm font-bold text-slate-800">
            {activeTab === "overview"
              ? "Panel de Estadísticas y Telemetría del Servicio"
              : activeTab === "user-lookup"
              ? "Consulta de Estado y Rastreo por Usuario"
              : "Arquitectura del Bus de Datos y Módulos en Tiempo Real"}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-semibold border ${
                sseStatus === "connected"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-amber-50 text-amber-700 border-amber-200"
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${sseStatus === "connected" ? "animate-pulse" : ""}`} />
              {sseStatus === "connected" ? "EN VIVO · Redis Pub/Sub + SSE" : "Reconectando..."}
            </span>
          </div>
        </div>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
