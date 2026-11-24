import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { CHANNEL_META, EVENT_TYPE_LABELS, formatTimeShort } from "../lib/constants";
import { AdminOverviewResponse, Channel } from "../types/api";

interface LivePulseEvent {
  id: string;
  eventType: string;
  channel?: Channel;
  correlationId?: string;
  timestamp: string;
}

interface BusArchitectureViewProps {
  overview: AdminOverviewResponse | null;
  latestEvent: LivePulseEvent | null;
  sseConnected: boolean;
}

export const BusArchitectureView: React.FC<BusArchitectureViewProps> = ({
  overview,
  latestEvent,
  sseConnected,
}) => {
  const [gatewayCount, setGatewayCount] = useState<number>(0);

  useEffect(() => {
    api
      .getWhatsAppGatewayStatus()
      .then((res) => setGatewayCount(res.connectedGateways))
      .catch(() => setGatewayCount(0));
  }, [latestEvent?.id]);

  const activeChannel = latestEvent?.channel;
  const activeEventType = latestEvent?.eventType;
  const isOtpPulse =
    activeEventType === "OTP_CHALLENGE_SENT" ||
    activeEventType === "IDENTITY_VERIFIED_OTP" ||
    activeEventType === "OTP_VALIDATION_FAILED";

  return (
    <div className="space-y-8">
      {/* Encabezado editorial de arquitectura */}
      <header className="pb-6 border-b border-[#E4E7EB] flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#00875A]">
            Arquitectura de datos · Bus omnicanal
          </p>
          <h2 className="text-2xl font-bold text-[#1F2933]">
            Flujo de eventos y módulos activos en tiempo real
          </h2>
          <p className="text-sm text-[#52606D] max-w-3xl">
            Cada interacción en Web, WhatsApp (Baileys firmado HMAC-SHA256) o Call Center actualiza
            los módulos recorridos en vivo mediante Redis Pub/Sub.
          </p>
        </div>

        <dl className="flex flex-wrap gap-6 text-xs shrink-0">
          <div>
            <dt className="text-[#52606D]">Gateways Baileys</dt>
            <dd className="font-semibold text-[#1F2933] mt-0.5">{gatewayCount} activos</dd>
          </div>
          <div>
            <dt className="text-[#52606D]">Telemetría SSE</dt>
            <dd className={`font-semibold mt-0.5 ${sseConnected ? "text-[#00875A]" : "text-[#52606D]"}`}>
              {sseConnected ? "Conectada" : "Reconectando"}
            </dd>
          </div>
        </dl>
      </header>

      {/* Último paquete trazado en el bus */}
      {latestEvent && (
        <section className="border-l-2 border-[#00875A] pl-4 py-1 flex flex-wrap items-baseline justify-between gap-3 text-sm">
          <p className="text-[#1F2933]">
            <strong className="text-[#00875A]">Último evento en el bus:</strong>{" "}
            {EVENT_TYPE_LABELS[latestEvent.eventType]?.label || latestEvent.eventType}
            {latestEvent.channel
              ? ` vía ${CHANNEL_META[latestEvent.channel]?.label || latestEvent.channel}`
              : ""}
          </p>
          <time dateTime={latestEvent.timestamp} className="text-xs font-mono text-[#52606D]">
            {latestEvent.correlationId ? `cid=${latestEvent.correlationId.slice(0, 12)} · ` : ""}
            {formatTimeShort(latestEvent.timestamp)}
          </time>
        </section>
      )}

      {/* Diagrama de 3 columnas separadas por líneas verticales de 1px */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Columna 1: Canales */}
        <section className="xl:col-span-3 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A] pb-2 border-b border-[#E4E7EB]">
            1. Canales de entrada y salida
          </h3>
          <ul className="divide-y divide-[#E4E7EB]">
            <ModuleRow
              title="Portal público web"
              subtitle="React SPA · Cuentas propias, 9 campos Salud Digna y familiares"
              meta="HTTPS + JWT Paciente"
              active={activeChannel === "WEB"}
            />
            <ModuleRow
              title="Gateway WhatsApp local"
              subtitle="Baileys (número propio) · Firma HMAC-SHA256 E2E bidireccional"
              meta="POST /inbound + SSE /outbound"
              active={activeChannel === "WHATSAPP"}
            />
            <ModuleRow
              title="Estación Call Center"
              subtitle="Consola asesor aislada · Screen-Pop SSE y folio/QR en un clic"
              meta="JWT RBAC (ASESOR)"
              active={activeChannel === "CALL_CENTER"}
            />
            <ModuleRow
              title="Consola 2FA (Out-of-Band)"
              subtitle="Verificación Step-Up OTP 6 dígitos para cambios de canal y terceros"
              meta="TTL 5m · Máx. 3 intentos"
              active={isOtpPulse}
            />
          </ul>
        </section>

        {/* Columna 2: Orquestador */}
        <section className="xl:col-span-5 xl:border-l xl:border-[#E4E7EB] xl:pl-8 space-y-6">
          <div className="flex items-baseline justify-between gap-2 pb-2 border-b border-[#E4E7EB]">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
              2. Orquestador stateless (AWS ECS Fargate)
            </h3>
            <code className="text-[11px] font-mono text-[#52606D]">Node 20 · Fastify v5</code>
          </div>

          <div className="pb-4 border-b border-[#E4E7EB] space-y-2">
            <h4 className="text-xs font-bold text-[#1F2933]">
              Perímetro criptográfico y control de acceso
            </h4>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-[#52606D] list-disc pl-4">
              <li>Firma E2E HMAC-SHA256 (<code>timingSafeEqual</code>)</li>
              <li>Anti-replay <code>X-Gateway-Timestamp</code> (±300s)</li>
              <li>JWT separado (<code>PATIENT</code> vs <code>STAFF</code>)</li>
              <li>Enmascarado PII automático en observabilidad</li>
            </ul>
          </div>

          <ul className="divide-y divide-[#E4E7EB]">
            <ModuleRow
              title="Identity Resolution multibeneficiario"
              subtitle="Separa titular (teléfono/cuenta) de beneficiario (expediente clínico por CURP)"
              meta="patient_relationships"
              active={activeEventType === "IDENTITY_LINKED" || isOtpPulse}
            />
            <ModuleRow
              title="Máquina de estados (8 estados)"
              subtitle="Determinística · N-saltos bidireccionales y lock optimista"
              meta="service_cases.version"
              active={Boolean(latestEvent)}
            />
            <ModuleRow
              title="Worker BullMQ WhatsApp"
              subtitle="Menú multibeneficiario numerado, cotización, dudas y firma saliente"
              meta={`Completados: ${overview?.queues.whatsappInbound.completed ?? 0}`}
              active={activeChannel === "WHATSAPP"}
            />
            <ModuleRow
              title="Event Bus y auditoría"
              subtitle="Persiste journey_events inmutable y difunde por Redis Pub/Sub"
              meta={`Eventos: ${overview?.kpis.totalEventsRecorded ?? 0}`}
              active={Boolean(latestEvent)}
            />
          </ul>

          <p className="pt-4 border-t border-[#E4E7EB] text-xs font-medium text-[#1F2933]">
            Ingesta firmada → Redis SETNX → BullMQ Worker → PostgreSQL + JSONB → Pub/Sub → SSE vivo
          </p>
        </section>

        {/* Columna 3: Redis y PostgreSQL */}
        <section className="xl:col-span-4 xl:border-l xl:border-[#E4E7EB] xl:pl-8 space-y-6">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2 pb-2 border-b border-[#E4E7EB]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A]">
                3. Bus Redis 7 / AWS Valkey
              </h3>
              <code className="text-[11px] font-mono text-[#52606D]">prefix: {"{bull}"}</code>
            </div>

            <ul className="divide-y divide-[#E4E7EB]">
              <BusChannelRow
                name="SETNX wamid:<id>"
                desc="Idempotencia 24h anti-duplicados"
                metric="0 duplicados"
              />
              <BusChannelRow
                name="BullMQ: whatsapp-inbound + DLQ"
                desc="3 reintentos exponenciales y cola de fallos"
                metric={`DLQ: ${overview?.queues.whatsappDlq.waiting ?? 0}`}
              />
              <BusChannelRow
                name="Pub/Sub: journey:events"
                desc="Alimenta Admin SSE y rastreo de paciente"
                metric={`SSE: ${overview?.kpis.activeSseSubscribers ?? 0}`}
              />
              <BusChannelRow
                name="Pub/Sub: whatsapp:outbound"
                desc="Envía respuestas firmadas HMAC al Gateway Baileys"
                metric={`GW: ${gatewayCount}`}
              />
              <BusChannelRow
                name="TTL: otp:challenge + wa:active_case"
                desc="Retos OTP 5m y selección activa de familiar (30m)"
                metric="Auto-expira"
              />
            </ul>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#00875A] pb-2 border-b border-[#E4E7EB]">
              Persistencia PostgreSQL 16 RDS
            </h3>
            <dl className="divide-y divide-[#E4E7EB] text-xs">
              <DbTableRow name="patients" desc="9 campos + CURP única + cuenta" />
              <DbTableRow name="patient_relationships" desc="Titular → Familiar + consentimiento" />
              <DbTableRow name="identity_links" desc="Hashes HMAC + PII enmascarada" />
              <DbTableRow name="service_cases" desc="Beneficiario + Titular + JSONB + version" />
              <DbTableRow name="journey_events" desc="Audit trail inmutable (13 eventos)" />
              <DbTableRow name="users_staff" desc="Roles RBAC (ADMIN / ASESOR)" />
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
};

const ModuleRow: React.FC<{
  title: string;
  subtitle: string;
  meta: string;
  active?: boolean;
}> = ({ title, subtitle, meta, active }) => (
  <li
    className={`py-3.5 pl-3 border-l-2 ${
      active ? "border-[#00875A]" : "border-transparent"
    }`}
  >
    <div className="flex items-baseline justify-between gap-2">
      <h4 className={`text-sm font-semibold ${active ? "text-[#00875A]" : "text-[#1F2933]"}`}>
        {title}
      </h4>
      {active && <small className="text-[11px] font-semibold text-[#00875A]">Activo</small>}
    </div>
    <p className="text-xs text-[#52606D] mt-1 leading-relaxed">{subtitle}</p>
    <code className="inline-block mt-1.5 text-[11px] font-mono text-[#52606D]">{meta}</code>
  </li>
);

const BusChannelRow: React.FC<{ name: string; desc: string; metric: string }> = ({
  name,
  desc,
  metric,
}) => (
  <li className="py-2.5 flex items-baseline justify-between gap-3">
    <div className="min-w-0">
      <code className="block text-xs font-mono font-semibold text-[#1F2933] truncate">{name}</code>
      <p className="text-xs text-[#52606D] truncate">{desc}</p>
    </div>
    <strong className="shrink-0 text-xs font-semibold text-[#00875A]">{metric}</strong>
  </li>
);

const DbTableRow: React.FC<{ name: string; desc: string }> = ({ name, desc }) => (
  <div className="py-2 flex items-baseline justify-between gap-3">
    <dt className="font-mono font-semibold text-[#1F2933]">{name}</dt>
    <dd className="text-[#52606D] text-right">{desc}</dd>
  </div>
);
