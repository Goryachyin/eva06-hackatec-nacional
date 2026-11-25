import React, { useState } from "react";
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

const TRACKING_STAGES: Array<{
  key: string;
  stepNum: string;
  label: string;
  states: CaseState[];
}> = [
  { key: "start", stepNum: "01", label: "Solicitud iniciada", states: ["INICIADO"] },
  { key: "quote", stepNum: "02", label: "Estudio cotizado", states: ["COTIZANDO"] },
  { key: "clinic", stepNum: "03", label: "Clínica y horario", states: ["CLINICA_ELEGIDA"] },
  {
    key: "followup",
    stepNum: "04",
    label: "Seguimiento / validación",
    states: ["PAUSADO_PENDIENTE", "EN_PROGRESO", "DUDAS_ABIERTAS"],
  },
  { key: "advisor", stepNum: "05", label: "Atención asesor", states: ["EN_ATENCION_ASESOR"] },
  { key: "confirmed", stepNum: "06", label: "Cita confirmada", states: ["CITA_CONFIRMADA"] },
];

function getStageIndex(state: CaseState): number {
  const idx = TRACKING_STAGES.findIndex((s) => s.states.includes(state));
  return idx === -1 ? 0 : idx;
}

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

  const orderedEvents = [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const uniqueChannels = Array.from(
    new Set(events.map((e) => e.channel).filter((c) => c !== "SYSTEM"))
  );

  return (
    <section className="border-t border-b border-[#E4E7EB] py-5 space-y-5 bg-[#FFFFFF]">
      {/* Resumen de estado en lista de definición semántica */}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
        <div>
          <dt className="text-[#52606D]">Estado actual</dt>
          <dd className={`mt-1 font-semibold ${stMeta.textClass}`}>{stMeta.label}</dd>
        </div>
        <div>
          <dt className="text-[#52606D]">Último canal</dt>
          <dd className={`mt-1 font-semibold ${chMeta.textClass}`}>{chMeta.label}</dd>
        </div>
        <div>
          <dt className="text-[#52606D]">Avance del trámite</dt>
          <dd className="mt-1 font-semibold text-[#00875A]">
            {progressPct}%
            {uniqueChannels.length > 1 ? ` · ${uniqueChannels.length} canales` : ""}
          </dd>
        </div>
        {isThirdParty && (
          <div>
            <dt className="text-[#52606D]">Beneficiario</dt>
            <dd className="mt-1 font-semibold text-[#1F2933]">
              {beneficiaryLabel || "Familiar"} ({relationshipLabel || "Tercero"})
            </dd>
          </div>
        )}
      </dl>

      {/* Barra plana sólida en verde esmeralda */}
      <div className="w-full h-1 bg-[#E4E7EB]">
        <div className="h-full bg-[#00875A]" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Etapas en retícula plana con borde de 1px */}
      <ol className="grid grid-cols-2 sm:grid-cols-6 border-t border-l border-[#E4E7EB]">
        {TRACKING_STAGES.map((stage, idx) => {
          const isCompleted = idx < activeIdx || currentState === "CITA_CONFIRMADA";
          const isCurrent = idx === activeIdx && currentState !== "CITA_CONFIRMADA";
          return (
            <li
              key={stage.key}
              className={`p-3 border-r border-b border-[#E4E7EB] ${
                isCurrent ? "border-t-2 border-t-[#00875A]" : ""
              }`}
            >
              <small
                className={`block text-[11px] font-semibold ${
                  isCompleted || isCurrent ? "text-[#00875A]" : "text-[#52606D]"
                }`}
              >
                {stage.stepNum} {isCompleted ? "· Listo" : isCurrent ? "· Actual" : ""}
              </small>
              <p
                className={`mt-1 text-xs leading-snug ${
                  isCompleted || isCurrent
                    ? "font-semibold text-[#1F2933]"
                    : "text-[#52606D]"
                }`}
              >
                {stage.label}
              </p>
            </li>
          );
        })}
      </ol>

      {/* Historial cronológico desplegable */}
      {orderedEvents.length > 0 && (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between text-xs font-semibold text-[#00875A] hover:underline py-1"
          >
            <strong className="font-semibold">
              Historial de seguimiento omnicanal ({orderedEvents.length} movimientos)
            </strong>
            <small className="text-xs font-semibold">
              {expanded ? "Ocultar historial" : "Ver historial completo"}
            </small>
          </button>

          {expanded && (
            <ol className="mt-3 border-t border-[#E4E7EB] divide-y divide-[#E4E7EB]">
              {orderedEvents.map((ev, idx) => {
                const evMeta = EVENT_TYPE_LABELS[ev.eventType] || {
                  label: ev.eventType,
                  tone: "text-[#1F2933]",
                };
                const isLatest = idx === 0;
                return (
                  <li
                    key={ev.id}
                    className={`py-3 pl-3 border-l-2 ${
                      isLatest ? "border-[#00875A]" : "border-[#E4E7EB]"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <div className="flex flex-wrap items-baseline gap-3">
                        <strong className={`font-semibold ${evMeta.tone}`}>{evMeta.label}</strong>
                        <small className="text-[#52606D]">
                          {CHANNEL_META[ev.channel]?.label || ev.channel}
                        </small>
                      </div>
                      <time dateTime={ev.createdAt} className="font-mono text-[11px] text-[#52606D]">
                        {formatDateTime(ev.createdAt)} · {formatTimeShort(ev.createdAt)}
                      </time>
                    </div>

                    {ev.nextState && (
                      <p className="mt-1 text-xs text-[#52606D]">
                        {ev.prevState ? STATE_META[ev.prevState]?.label : "Inicio"} →{" "}
                        <strong className="text-[#1F2933] font-semibold">
                          {STATE_META[ev.nextState]?.label || ev.nextState}
                        </strong>
                      </p>
                    )}

                    {ev.payloadJson &&
                      typeof ev.payloadJson.patientSafeSummary === "string" &&
                      ev.payloadJson.patientSafeSummary && (
                        <p className="mt-2 border-l-2 border-[#00875A] pl-3 text-xs text-[#1F2933] leading-relaxed">
                          <strong className="text-[#00875A]">Resumen de llamada:</strong>{" "}
                          {ev.payloadJson.patientSafeSummary}
                        </p>
                      )}

                    {showAuditDetails && (
                      <p className="mt-1 text-[11px] font-mono text-[#52606D]">
                        actor: {ev.actorRole} · correlation_id: {ev.correlationId}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
};
