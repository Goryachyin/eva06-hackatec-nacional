import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AWS_API_URL, getApiBaseUrl, LOCAL_API_URL, setApiBaseUrl } from "../../lib/api";

interface LabLayoutProps {
  children: React.ReactNode;
}

export const LabLayout: React.FC<LabLayoutProps> = ({ children }) => {
  const location = useLocation();
  const [apiBase, setApiBase] = useState<string>(() => getApiBaseUrl());
  const isAws = apiBase.includes("ecs.us-east-2.on.aws");

  const handleSwitchBackend = (target: "local" | "aws") => {
    const next = target === "aws" ? AWS_API_URL : LOCAL_API_URL;
    setApiBaseUrl(next);
    setApiBase(next);
    window.location.reload();
  };

  const nav = [
    { to: "/lab", label: "Resumen QA", exact: true },
    { to: "/lab/whatsapp", label: "Simulador WhatsApp", exact: false },
    { to: "/lab/otp-2fa", label: "Consola 2FA (OTP)", exact: false },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#FFFFFF] text-[#1F2933]">
      <header className="bg-[#F7F8F9] border-b border-[#E4E7EB]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="leading-tight">
            <strong className="block text-sm font-bold text-[#00875A]">
              Entorno de Pruebas y Simuladores · QA Interno
            </strong>
            <small className="block text-[11px] text-[#52606D]">
              Aislado del portal público de pacientes y de administración
            </small>
          </div>

          <nav aria-label="Navegación QA" className="hidden md:flex items-center gap-6 h-16">
            {nav.map((item) => {
              const active = item.exact
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to) ||
                  (item.to === "/lab/whatsapp" &&
                    (location.pathname === "/whatsapp" || location.pathname === "/whatsapp-sim")) ||
                  (item.to === "/lab/otp-2fa" && location.pathname === "/otp-2fa");
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`h-full inline-flex items-center text-xs border-b-2 transition-colors ${
                    active
                      ? "border-[#00875A] text-[#00875A] font-semibold"
                      : "border-transparent text-[#52606D] hover:text-[#1F2933]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Selector de entorno API plano con bordes de 1px */}
          <div className="inline-flex border border-[#E4E7EB] bg-[#FFFFFF] shrink-0">
            <button
              type="button"
              onClick={() => handleSwitchBackend("local")}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                !isAws
                  ? "bg-[#00875A] text-[#FFFFFF]"
                  : "text-[#52606D] hover:text-[#1F2933]"
              }`}
            >
              Local
            </button>
            <button
              type="button"
              onClick={() => handleSwitchBackend("aws")}
              className={`px-3 py-1.5 text-xs font-semibold border-l border-[#E4E7EB] transition-colors ${
                isAws
                  ? "bg-[#00875A] text-[#FFFFFF]"
                  : "text-[#52606D] hover:text-[#1F2933]"
              }`}
            >
              AWS Live
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 bg-[#FFFFFF]">{children}</main>
    </div>
  );
};
