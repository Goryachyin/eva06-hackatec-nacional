import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ExternalLink,
  Headphones,
  KeyRound,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { getApiBaseUrl } from "../lib/api";

export const LabHomePage: React.FC = () => {
  const apiBase = getApiBaseUrl();

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full">
          <ShieldCheck className="w-3.5 h-3.5" />
          Entorno de Pruebas Aislado (No expuesto al portal público)
        </div>
        <h1 className="text-2xl font-extrabold text-slate-900">
          Herramientas de Validación Omnicanal
        </h1>
        <p className="text-sm text-slate-500">
          Utiliza estas herramientas internas para probar el Gateway WhatsApp (Baileys + HMAC E2E),
          la verificación Step-Up OTP fuera de banda y continuidad hacia Call Center contra{" "}
          <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs text-slate-800">
            {apiBase}
          </code>
          .
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Link
          to="/lab/whatsapp"
          className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:border-[#00843D] transition flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 text-[#00843D] flex items-center justify-center">
              <MessageCircle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900">Simulador WhatsApp (Respaldo)</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Ejecuta exactamente la misma máquina de estados multibeneficiario e idempotencia{" "}
              <code className="bg-slate-100 px-1 rounded">SETNX</code> que el Gateway Baileys local.
            </p>
          </div>
          <div className="mt-5 pt-3 border-t border-slate-100 text-xs font-bold text-[#00843D] inline-flex items-center gap-1">
            Abrir simulador
            <ArrowRight className="w-3.5 h-3.5" />
          </div>
        </Link>

        <Link
          to="/lab/otp-2fa"
          className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:border-[#0066B3] transition flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div className="w-11 h-11 rounded-xl bg-blue-50 text-[#0066B3] flex items-center justify-center">
              <KeyRound className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900">Consola 2FA (OTP)</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Bandeja externa independiente (SMS/Correo) con los códigos temporales de 6 dígitos
              activos en Redis.
            </p>
          </div>
          <div className="mt-5 pt-3 border-t border-slate-100 text-xs font-bold text-[#0066B3] inline-flex items-center gap-1">
            Abrir consola 2FA
            <ArrowRight className="w-3.5 h-3.5" />
          </div>
        </Link>

        <a
          href="/call-center"
          target="_blank"
          rel="noreferrer"
          className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:border-violet-500 transition flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div className="w-11 h-11 rounded-xl bg-violet-50 text-violet-700 flex items-center justify-center">
              <Headphones className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900">Estación Call Center</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Abre en otra pestaña la consola aislada de asesores para recibir el Screen-Pop SSE y
              confirmar citas.
            </p>
          </div>
          <div className="mt-5 pt-3 border-t border-slate-100 text-xs font-bold text-violet-700 inline-flex items-center gap-1">
            Abrir en pestaña aparte
            <ExternalLink className="w-3.5 h-3.5" />
          </div>
        </a>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <span>Accesos independientes de los otros entornos (en pestañas separadas):</span>
        <div className="flex flex-wrap gap-3 font-semibold">
          <a href="/" target="_blank" rel="noreferrer" className="text-[#00843D] hover:underline">
            Portal Público (/)
          </a>
          <a href="/admin" target="_blank" rel="noreferrer" className="text-[#0066B3] hover:underline">
            Back-Office Admin (/admin)
          </a>
          <a
            href={`${apiBase}/docs`}
            target="_blank"
            rel="noreferrer"
            className="text-slate-700 hover:underline"
          >
            Swagger OpenAPI (/docs)
          </a>
        </div>
      </div>
    </div>
  );
};
