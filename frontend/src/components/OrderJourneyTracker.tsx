import React, { useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FlaskConical,
  Globe,
  Headphones,
  MessageCircle,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import {
  CHANNEL_META,
  EVENT_TYPE_LABELS,
  formatDateTime,
  formatTimeShort,
  STATE_META,
} from "../lib/constants";
import { CaseState, Channel, JourneyEventItem } from "../types/api";

interface OrderJourneyTrackerProps {
  currentState: CaseState;
  currentChannel: Channel;
  events?: JourneyEventItem[];
  isThirdParty?: boolean;
  beneficiaryLabel?: string;
  relationshipLabel?: string;
  showAuditDetails?: boolean;
  defaultExpanded?: boolean;
}

const TRACKING_STAGES = [
  {
    key: "start",
    label: "Solicitud iniciada",
    states: ["INICIADO"] as CaseState[],
    icon: Sparkles,
  },
  {
    key: "quote",
    label: "Estudio cotizado",
    states: ["COTIZANDO"] as CaseState[],
    icon: FlaskConical,
  },
  {
    key: "clinic",
    label: "Clínica y horario",
    states: ["CLINICA_ELEGIDA"] as CaseState[],
    icon: Building2,
  },
  {
    key: "followup",
    label: "Seguimiento / Validación",
    states: ["PAUSADO_PENDIENTE", "EN_PROGRESO", "DUDAS_ABIERTAS"] as CaseState[],
    icon: Clock,
  },
  {
    key: "advisor",
    label: "Atención Asesor",
    states: ["EN_ATENCION_ASESOR"] as CaseState[],
    icon: Headphones,
  },
  {
    key: "confirmed",
    label: "Cita confirmada",
    states: ["CITA_CONFIRMADA"] as CaseState[],
    icon: PackageCheck,
  },
];

function getStageIndex(state: CaseState): number {
  const idx = TRACKING_STAGES.findIndex((s) => s.states.includes(state));
  return idx === -1 ? 0 : idx;
}

function getChannelIcon(ch: Channel) {
  switch (ch) {
    case "WEB":
      return <Globe className="w-3.5 h-3.5 text-[#0066B3]" />;
    case "WHATSAPP":
      return <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />;
    case "CALL_CENTER":
      return <Headphones className="w-3.5 h-3.5 text-violet-600" />;
    default:
      return <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />;
  }
}

/**
 * Componente de rastreo visual estilo Amazon / Mercado Libre:
 * Barra de progreso por hitos + guía cronológica de saltos entre canales en tiempo real.
 */
export const OrderJourneyTracker: React.FC<OrderJourneyTrackerProps> = ({
  currentState,
  currentChannel,
  events = [],
  isThirdParty = false,
  beneficiaryLabel,
  relationshipLabel,
  showAuditDetails = false,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const activeIdx = getStageIndex(currentState);
  const progressPct = Math.round((activeIdx / (TRACKING_STAGES.length - 1)) * 100);
  const stMeta = STATE_META[currentState];
  const chMeta = CHANNEL_META[currentChannel];

  // Eventos en orden más reciente primero para el estilo de rastreo de envío
  const orderedEvents = [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Detectar cuántos canales distintos ha recorrido este expediente
  const uniqueChannels = Array.from(
    new Set(events.map((e) => e.channel).filter((c) => c !== "SYSTEM"))
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4">
      {/* Cabecera estilo rastreo de paquete */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${stMeta.badgeClass}`}
          >
            <span className={`w-2 h-2 rounded-full ${stMeta.dotColor}`} />
            {stMeta.label}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${chMeta.badgeClass}`}
          >
            {getChannelIcon(currentChannel)}
            Último canal: {chMeta.label}
          </span>
          {isThirdParty && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
              <Users className="w-3.5 h-3.5" />
              Para: {beneficiaryLabel || "Familiar"} ({relationshipLabel || "Tercero"})
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500">
          {uniqueChannels.length > 1 && (
            <span className="px-2 py-0.5 rounded bg-[#E6F4EC] text-[#005A2B] font-bold">
              {uniqueChannels.length} canales sincronizados
            </span>
          )}
          <span className="font-bold text-[#00843D]">{progressPct}%</span>
        </div>
      </div>

      {/* Barra de progreso horizontal tipo Amazon / Mercado Libre */}
      <div className="relative pt-2 pb-1">
        {/* Línea de fondo */}
        <div className="hidden sm:block absolute top-[26px] left-6 right-6 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#00843D] to-[#10B981] transition-all duration-700 ease-out rounded-full"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 relative z-10">
          {TRACKING_STAGES.map((stage, idx) => {
            const Icon = stage.icon;
            const isCompleted = idx < activeIdx || currentState === "CITA_CONFIRMADA";
            const isCurrent = idx === activeIdx && currentState !== "CITA_CONFIRMADA";
            return (
              <div key={stage.key} className="flex sm:flex-col items-center sm:text-center gap-2">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border-2 transition-all ${
                    isCompleted
                      ? "bg-[#00843D] border-[#00843D] text-white shadow-sm"
                      : isCurrent
                      ? "bg-white border-[#00843D] text-[#00843D] ring-4 ring-emerald-100 shadow-sm"
                      : "bg-white border-slate-200 text-slate-300"
                  }`}
                >
                  {isCompleted ? <Check className="w-4 h-4 stroke-[3]" /> : <Icon className="w-4 h-4" />}
                </div>
                <div className="min-w-0">
                  <div
                    className={`text-[11px] leading-tight font-bold ${
                      isCompleted || isCurrent ? "text-slate-900" : "text-slate-400"
                    }`}
                  >
                    {stage.label}
                  </div>
                  {isCurrent && (
                    <div className="text-[10px] font-semibold text-[#00843D] mt-0.5">
                      Paso actual
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Historial tipo guía de envío (desplegable o abierto por defecto) */}
      {orderedEvents.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between text-xs font-bold text-[#0066B3] hover:text-[#004f8c] py-1 transition"
          >
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#00843D]" />
              Historial de seguimiento omnicanal ({orderedEvents.length} movimientos)
            </span>
            <span className="inline-flex items-center gap-1">
              {expanded ? "Ocultar historial" : "Ver historial completo"}
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </span>
          </button>

          {expanded && (
            <ol className="mt-3 relative border-l-2 border-emerald-200 ml-3 space-y-3">
              {orderedEvents.map((ev, idx) => {
                const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                  label: ev.eventType,
                  tone: "text-slate-700 bg-slate-100",
                };
                const isLatest = idx === 0;
                return (
                  <li key={ev.id} className="ml-4 relative">
                    <span
                      className={`absolute -left-[23px] top-1.5 w-3.5 h-3.5 rounded-full border-2 ${
                        isLatest
                          ? "bg-[#00843D] border-emerald-200 ring-2 ring-emerald-100"
                          : "bg-white border-[#00843D]"
                      }`}
                    />
                    <div
                      className={`rounded-xl border px-3.5 py-2.5 text-xs space-y-1 ${
                        isLatest
                          ? "bg-[#E6F4EC]/50 border-[#00843D]/30"
                          : "bg-slate-50/70 border-slate-200/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`px-2 py-0.5 rounded font-bold ${evMeta.tone}`}>
                            {evMeta.label}
                          </span>
                          <span className="inline-flex items-center gap-1 text-slate-600 font-semibold">
                            {getChannelIcon(ev.channel)}
                            {CHANNEL_META[ev.channel]?.label || ev.channel}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400">
                          {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                        </span>
                      </div>

                      {ev.nextState && (
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-700 font-medium">
                          <span>{ev.prevState ? STATE_META[ev.prevState]?.label : "Inicio"}</span>
                          <ArrowRight className="w-3 h-3 text-slate-400" />
                          <span className="font-bold text-slate-900">
                            {STATE_META[ev.nextState]?.label || ev.nextState}
                          </span>
                        </div>
                      )}

                      {showAuditDetails && (
                        <div className="text-[10px] font-mono text-slate-400 pt-0.5 flex flex-wrap gap-3">
                          <span>actor: {ev.actorRole}</span>
                          <span>correlation_id: {ev.correlationId}</span>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
};
