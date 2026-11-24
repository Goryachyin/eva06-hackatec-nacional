import React from "react";
import { ShieldCheck } from "lucide-react";

export const PrivacyPage: React.FC = () => (
  <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
    <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm space-y-5">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#00843D]">
        <ShieldCheck className="w-4 h-4" />
        Privacidad y Protección de Datos
      </div>
      <h1 className="text-2xl font-extrabold text-slate-900 border-b border-slate-200 pb-4">
        Política de Privacidad — Prototipo Omnicanal (HackaTec 2026)
      </h1>
      <p className="text-sm text-slate-600 leading-relaxed">
        Esta aplicación corresponde a un prototipo tecnológico académico desarrollado en el marco
        del HackaTec Nacional 2026 (TecNM × Salud Digna) para demostrar la continuidad omnicanal de
        atención al paciente bajo el principio <em>"Un paciente, una sola conversación"</em>.
      </p>
      <div className="space-y-2">
        <h2 className="text-base font-bold text-[#005A2B]">1. Datos tratados</h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          Únicamente se procesan datos de prueba proporcionados voluntariamente durante la
          demostración (perfil del paciente, número telefónico y selección de estudios simulados)
          con el fin de conservar el contexto del trámite entre Sitio Web, WhatsApp y Call Center.
        </p>
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-bold text-[#005A2B]">2. Seguridad y privacidad por diseño</h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          Los identificadores se almacenan con hash criptográfico HMAC-SHA256, el acceso entre
          canales requiere verificación Step-Up OTP temporal (TTL 5 minutos en Redis con límite de
          3 intentos) y el Panel Administrador despliega datos estrictamente enmascarados (PII
          protegida).
        </p>
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-bold text-[#005A2B]">3. Eliminación de datos de prueba</h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          Los expedientes de prueba pueden reiniciarse en cualquier momento desde el botón{" "}
          <strong>Reset Demo</strong> del Panel Administrador.
        </p>
      </div>
    </div>
  </div>
);
