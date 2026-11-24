import React from "react";
import { Headphones, LogOut, Radio } from "lucide-react";
import { StaffUser } from "../../types/api";

interface CallCenterLayoutProps {
  user: StaffUser | null;
  sseConnected: boolean;
  onLogout?: () => void;
  children: React.ReactNode;
}

export const CallCenterLayout: React.FC<CallCenterLayoutProps> = ({
  user,
  sseConnected,
  onLogout,
  children,
}) => {
  return (
    <div className="min-h-screen flex flex-col bg-[#F1F5F9]">
      <header className="bg-[#0F172A] text-white border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#0066B3] flex items-center justify-center">
              <Headphones className="w-5 h-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-extrabold tracking-tight">
                Salud Digna · Mesa de Atención Call Center
              </div>
              <div className="text-[11px] text-slate-400">
                Estación Operativa de Asesores (Screen-Pop Omnicanal)
              </div>
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-3">
              <span
                className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                  sseConnected
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                }`}
              >
                <Radio className={`w-3.5 h-3.5 ${sseConnected ? "animate-pulse" : ""}`} />
                {sseConnected ? "Screen-Pop en línea" : "Reconectando..."}
              </span>
              <div className="text-right hidden md:block">
                <div className="text-xs font-bold text-white">{user.fullName}</div>
                <div className="text-[10px] text-slate-400">{user.email}</div>
              </div>
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-rose-500/20 hover:text-rose-200 text-xs font-semibold transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Salir
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
};
