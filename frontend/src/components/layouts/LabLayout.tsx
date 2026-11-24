import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  FlaskConical,
  KeyRound,
  MessageCircle,
  Server,
  Wrench,
} from "lucide-react";
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
    { to: "/lab", label: "Resumen QA", icon: Wrench, exact: true },
    { to: "/lab/whatsapp", label: "Simulador WhatsApp", icon: MessageCircle, exact: false },
    { to: "/lab/otp-2fa", label: "Consola 2FA (OTP)", icon: KeyRound, exact: false },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <header className="bg-slate-900 text-white border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-400/40 text-amber-300 flex items-center justify-center">
              <FlaskConical className="w-5 h-5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-extrabold tracking-tight flex items-center gap-2">
                Entorno de Pruebas y Simuladores
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-400/30">
                  QA Interno
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                Aislado del portal público de pacientes y del Back-Office Admin
              </div>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-1">
            {nav.map((item) => {
              const Icon = item.icon;
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
                  className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${
                    active
                      ? "bg-white/15 text-white"
                      : "text-slate-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Selector de entorno API únicamente disponible dentro del laboratorio de pruebas */}
          <div className="flex items-center gap-2 shrink-0">
            <Server className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
            <div className="inline-flex rounded-full bg-white/10 p-0.5 border border-white/15">
              <button
                type="button"
                onClick={() => handleSwitchBackend("local")}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition ${
                  !isAws ? "bg-white text-slate-900" : "text-slate-300 hover:text-white"
                }`}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => handleSwitchBackend("aws")}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition ${
                  isAws ? "bg-emerald-500 text-white" : "text-slate-300 hover:text-white"
                }`}
              >
                AWS Live
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
};
