import React from "react";
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
    <div className="min-h-screen flex flex-col bg-[#FFFFFF] text-[#1F2933]">
      <header className="bg-[#F7F8F9] border-b border-[#E4E7EB]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
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
              <strong className="block text-sm font-bold text-[#00875A]">
                Salud Digna · Mesa de Atención Call Center
              </strong>
              <small className="block text-[11px] text-[#52606D]">
                Estación operativa de asesores (Screen-Pop omnicanal)
              </small>
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-5">
              <p
                className={`hidden sm:block text-xs font-semibold ${
                  sseConnected ? "text-[#00875A]" : "text-[#52606D]"
                }`}
              >
                {sseConnected ? "Screen-Pop en línea" : "Reconectando"}
              </p>
              <div className="text-right hidden md:block border-l border-[#E4E7EB] pl-5">
                <p className="text-xs font-semibold text-[#1F2933]">{user.fullName}</p>
                <p className="text-[11px] text-[#52606D]">{user.email}</p>
              </div>
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="px-3 py-1.5 border border-[#E4E7EB] bg-[#FFFFFF] text-xs font-semibold text-[#1F2933] hover:border-[#1F2933] transition-colors"
                >
                  Salir
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 bg-[#FFFFFF]">{children}</main>
    </div>
  );
};
