import { CLINICS_CATALOG, STUDIES_CATALOG } from "./catalog";

/**
 * Plantillas de mensajes predeterminados del Bot Salud Digna (100% determinístico).
 * Edita cualquier texto aquí para personalizar las respuestas automáticas de WhatsApp.
 */
export const BOT_TEMPLATES = {
  welcomeMenu: () =>
    [
      "👋 ¡Hola! Bienvenido a *Salud Digna*.",
      "Soy tu asistente omnicanal de citas. Elige una opción rápida respondiendo con el número:",
      "",
      "1️⃣ *Agendar o cotizar una nueva cita*",
      "2️⃣ *Ver mis citas y folios activos*",
      "3️⃣ *Editar o reagendar una cita confirmada*",
      "4️⃣ *Ver estudios, precios y clínicas*",
      "5️⃣ *Pausar o cambiar de trámite*",
      "6️⃣ *Hablar con un asesor de Call Center*",
      "",
      "💡 También puedes escribir directo lo que necesitas (ej. *Química sanguínea*, *Cambiar hora de mi cita* o *MENÚ*).",
    ].join("\n"),

  studiesCatalog: () => {
    const lines = STUDIES_CATALOG.map(
      (s, i) => `${i + 1}. *${s.name}* — $${s.price} MXN\n   _${s.prep}_`
    );
    return [
      "🧪 *Catálogo de estudios disponibles en Salud Digna:*",
      "",
      ...lines,
      "",
      "Escribe el nombre del estudio que deseas cotizar (ej. *Ultrasonido* o *Química*) para guardar tu avance omnicanal.",
    ].join("\n");
  },

  clinicsList: () => {
    const lines = CLINICS_CATALOG.map(
      (c) => `📍 *${c.name}*\n   ${c.address}\n   🕒 ${c.hours}`
    );
    return [
      "🏥 *Clínicas Salud Digna disponibles:*",
      "",
      ...lines,
      "",
      "Escribe la ciudad de la clínica que prefieres (*Culiacán*, *Guadalajara*, *CDMX* o *Monterrey*).",
    ].join("\n");
  },

  paymentInfo: (studyName?: string, price?: number) => {
    const discountLine =
      studyName && price
        ? `Para *${studyName}* ($${price} MXN), pagando en línea te queda en *$${Math.round(price * 0.9)} MXN* (10% de descuento).\n\n`
        : "";
    return (
      `💳 *Formas de pago en Salud Digna:*\n` +
      discountLine +
      `• *En línea (Web):* Tarjeta Visa/Mastercard con *10% de descuento* y recepción express.\n` +
      `• *OXXO Pay:* Pago en efectivo con referencia.\n` +
      `• *En clínica:* Efectivo o tarjeta el día de tu cita.\n\n` +
      `Si deseas confirmar tu cita ahora por aquí, responde *CONFIRMAR*.`
    );
  },

  studyQuoted: (name: string, price: number, prep: string) =>
    [
      `✅ Cotizamos *${name}* ($${price} MXN · $${Math.round(price * 0.9)} MXN pagando en línea).`,
      `📋 *Preparación:* ${prep}`,
      "",
      "🏥 ¿En qué clínica te gustaría agendar? Responde con tu ciudad:",
      "• *Culiacán*",
      "• *Guadalajara*",
      "• *CDMX*",
      "• *Monterrey*",
    ].join("\n"),

  clinicSelected: (clinicName: string, address: string) =>
    [
      `📍 ¡Perfecto! Guardamos *${clinicName}* (${address}).`,
      "",
      "¿Cómo deseas continuar?",
      "• Responde *CONFIRMAR* para generar tu folio de cita ahora.",
      "• Escribe cualquier duda (ej. *¿Requiero ayuno?* o *¿Cómo puedo pagar?*).",
      "• Responde *ASESOR* si prefieres atención personalizada en Call Center.",
    ].join("\n"),

  escalatedToAdvisor: (studyName?: string, clinicName?: string) =>
    [
      "🎧 *Solicitud turnada a Call Center*",
      `Tu expediente (${studyName ?? "Estudio"} · ${clinicName ?? "Clínica pendiente"}) ya apareció en pantalla del asesor con todo tu contexto.`,
      "",
      "Un asesor podrá confirmar tu cita en 1 clic sin que tengas que repetir tus datos. También puedes seguir tu estatus en tiempo real desde *Mi Cuenta* en el portal web.",
    ].join("\n"),

  appointmentConfirmed: (folio: string, studyName: string, clinicName: string, prep: string) =>
    [
      `🎉 *¡Cita confirmada en Salud Digna!*`,
      `• *Folio:* ${folio}`,
      `• *Estudio:* ${studyName}`,
      `• *Clínica:* ${clinicName}`,
      `• *Preparación:* ${prep}`,
      "",
      "Presenta este folio o tu código QR (disponible en *Mi Cuenta*) 15 minutos antes de tu cita.",
    ].join("\n"),
};
