import React from "react";

export const PrivacyPage: React.FC = () => (
  <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 bg-[#FFFFFF] text-[#1F2933] space-y-8">
    <header className="pb-6 border-b border-[#E4E7EB] space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
        Privacidad y protección de datos
      </p>
      <h1 className="text-3xl font-bold text-[#1F2933]">
        Política de privacidad — Prototipo Omnicanal (HackaTec 2026)
      </h1>
    </header>

    <p className="text-sm text-[#52606D] leading-relaxed">
      Esta aplicación corresponde a un prototipo tecnológico académico desarrollado en el marco del
      HackaTec Nacional 2026 (TecNM × Salud Digna) para demostrar la continuidad omnicanal de
      atención al paciente bajo el principio <em>"Un paciente, una sola conversación"</em>.
    </p>

    <section className="pt-6 border-t border-[#E4E7EB] space-y-2">
      <h2 className="text-base font-bold text-[#00875A]">1. Datos tratados</h2>
      <p className="text-sm text-[#52606D] leading-relaxed">
        Únicamente se procesan datos de prueba proporcionados voluntariamente durante la
        demostración (perfil del paciente, número telefónico y selección de estudios simulados) con
        el fin de conservar el contexto del trámite entre Sitio Web, WhatsApp y Call Center.
      </p>
    </section>

    <section className="pt-6 border-t border-[#E4E7EB] space-y-2">
      <h2 className="text-base font-bold text-[#00875A]">
        2. Seguridad y privacidad por diseño
      </h2>
      <p className="text-sm text-[#52606D] leading-relaxed">
        Los identificadores se almacenan con hash criptográfico HMAC-SHA256, el acceso entre canales
        requiere verificación Step-Up OTP temporal (TTL 5 minutos en Redis con límite de 3 intentos)
        y el Panel Administrador despliega datos estrictamente enmascarados (PII protegida).
      </p>
    </section>

    <section className="pt-6 border-t border-[#E4E7EB] space-y-2">
      <h2 className="text-base font-bold text-[#00875A]">3. Eliminación de datos de prueba</h2>
      <p className="text-sm text-[#52606D] leading-relaxed">
        Los expedientes de prueba pueden reiniciarse en cualquier momento desde la consola
        administrativa.
      </p>
    </section>
  </article>
);
