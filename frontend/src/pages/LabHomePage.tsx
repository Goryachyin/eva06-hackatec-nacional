import React from "react";
import { Link } from "react-router-dom";
import { getApiBaseUrl } from "../lib/api";

export const LabHomePage: React.FC = () => {
  const apiBase = getApiBaseUrl();

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-12 bg-[#FFFFFF] text-[#1F2933]">
      <header className="pb-8 border-b border-[#E4E7EB] space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
          Entorno de pruebas aislado · QA interno
        </p>
        <h1 className="text-3xl font-bold text-[#1F2933]">
          Herramientas de validación omnicanal
        </h1>
        <p className="text-sm text-[#52606D] max-w-3xl leading-relaxed">
          Utiliza estas herramientas internas para probar el Gateway WhatsApp (Baileys + HMAC E2E),
          la verificación Step-Up OTP fuera de banda y la continuidad hacia Call Center contra{" "}
          <code className="font-mono text-xs text-[#1F2933]">{apiBase}</code>.
        </p>
      </header>

      <ul className="divide-y divide-[#E4E7EB] border-b border-[#E4E7EB]">
        <li className="py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-bold text-[#1F2933]">Simulador WhatsApp (Respaldo)</h2>
            <p className="text-sm text-[#52606D] mt-1 leading-relaxed">
              Ejecuta exactamente la misma máquina de estados multibeneficiario e idempotencia{" "}
              <code className="font-mono text-xs text-[#1F2933]">SETNX</code> que el Gateway
              Baileys local.
            </p>
          </div>
          <Link
            to="/lab/whatsapp"
            className="text-sm font-semibold text-[#00875A] hover:underline shrink-0"
          >
            Abrir simulador →
          </Link>
        </li>

        <li className="py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-bold text-[#1F2933]">Consola 2FA (OTP)</h2>
            <p className="text-sm text-[#52606D] mt-1 leading-relaxed">
              Bandeja externa independiente (SMS/Correo) con los códigos temporales de 6 dígitos
              activos en Redis.
            </p>
          </div>
          <Link
            to="/lab/otp-2fa"
            className="text-sm font-semibold text-[#00875A] hover:underline shrink-0"
          >
            Abrir consola 2FA →
          </Link>
        </li>

        <li className="py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-bold text-[#1F2933]">Estación Call Center</h2>
            <p className="text-sm text-[#52606D] mt-1 leading-relaxed">
              Abre en otra pestaña la consola aislada de asesores para recibir el Screen-Pop SSE y
              confirmar citas.
            </p>
          </div>
          <a
            href="/call-center"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold text-[#00875A] hover:underline shrink-0"
          >
            Abrir en pestaña aparte →
          </a>
        </li>
      </ul>

      <section className="flex flex-wrap items-center justify-between gap-4 text-xs text-[#52606D]">
        <p>Accesos independientes de los otros entornos:</p>
        <ul className="flex flex-wrap gap-6 font-semibold">
          <li>
            <a href="/" target="_blank" rel="noreferrer" className="text-[#00875A] hover:underline">
              Portal público (/)
            </a>
          </li>
          <li>
            <a
              href="/admin"
              target="_blank"
              rel="noreferrer"
              className="text-[#00875A] hover:underline"
            >
              Back-Office Admin (/admin)
            </a>
          </li>
          <li>
            <a
              href={`${apiBase}/docs`}
              target="_blank"
              rel="noreferrer"
              className="text-[#1F2933] hover:underline"
            >
              Swagger OpenAPI (/docs)
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
};
