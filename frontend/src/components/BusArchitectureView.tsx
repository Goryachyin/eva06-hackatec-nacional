import React, { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Cpu,
  Database,
  Globe,
  Headphones,
  KeyRound,
  Layers,
  Lock,
  MessageCircle,
  Radio,
  Server,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
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

/**
 * Representación gráfica interactiva y en tiempo real del Bus de Datos y todos los módulos
 * (solicitada por los jueces): resalta en vivo cada capa cuando cruza un evento por SSE.
 */
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
    <div className="space-y-6">
      {/* Banner superior explicativo con pulso en vivo */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#00843D] bg-[#E6F4EC] px-2.5 py-1 rounded-full mb-2">
            <Cpu className="w-3.5 h-3.5" />
            Arquitectura Detallada · Bus de Datos y Módulos en Vivo
          </div>
          <h2 className="text-xl font-extrabold text-slate-900">
            Flujo de Datos por el Bus Omnicanal (Cero Meta · Firma Digital E2E)
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
            Cada vez que un paciente interactúa en Web, WhatsApp (Baileys firmado HMAC-SHA256) o
            Call Center, los módulos recorridos se iluminan en tiempo real mediante Redis Pub/Sub.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border ${
              gatewayCount > 0
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : "bg-slate-50 text-slate-600 border-slate-200"
            }`}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            Gateways Baileys activos: {gatewayCount}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border ${
              sseConnected
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${sseConnected ? "animate-pulse" : ""}`} />
            {sseConnected ? "Telemetría SSE conectada" : "Reconectando"}
          </span>
        </div>
      </div>

      {/* Último paquete trazado en el bus */}
      {latestEvent && (
        <div className="p-4 rounded-2xl bg-[#0B1F16] text-white flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-2.5 text-xs sm:text-sm">
            <Zap className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />
            <span className="font-bold text-emerald-300">Último evento en el Bus:</span>
            <span className="px-2 py-0.5 rounded bg-white/15 font-bold">
              {EVENT_TYPE_LABELS[latestEvent.eventType]?.label || latestEvent.eventType}
            </span>
            {latestEvent.channel && (
              <span className="text-slate-300">
                vía <strong>{CHANNEL_META[latestEvent.channel]?.label || latestEvent.channel}</strong>
              </span>
            )}
          </div>
          <div className="text-xs font-mono text-emerald-200/80">
            {latestEvent.correlationId ? `cid=${latestEvent.correlationId.slice(0, 12)} · ` : ""}
            {formatTimeShort(latestEvent.timestamp)}
          </div>
        </div>
      )}

      {/* Diagrama Arquitectónico Interactivo de 3 Capas + Bus Central */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-stretch">
        {/* COLUMNA 1: CANALES Y ADAPTADORES EXTERNOS */}
        <div className="xl:col-span-3 bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-3 flex flex-col">
          <div className="text-xs font-extrabold uppercase tracking-wider text-slate-500 border-b border-slate-100 pb-2">
            1. Canales de Entrada / Salida
          </div>

          <ModuleBox
            title="Portal Público Web"
            subtitle="React SPA · Cuentas propias, 9 campos Salud Digna + Familiares"
            badge="HTTPS + JWT Paciente"
            icon={<Globe className="w-4 h-4 text-[#0066B3]" />}
            active={activeChannel === "WEB"}
          />

          <ModuleBox
            title="Gateway WhatsApp Local"
            subtitle="Baileys (número propio) · Firma HMAC-SHA256 E2E bidireccional"
            badge="POST /inbound + SSE /outbound"
            icon={<MessageCircle className="w-4 h-4 text-emerald-600" />}
            active={activeChannel === "WHATSAPP"}
          />

          <ModuleBox
            title="Estación Call Center"
            subtitle="Consola Asesor aislada · Screen-Pop SSE + Folio/QR en 1 clic"
            badge="JWT RBAC (ASESOR)"
            icon={<Headphones className="w-4 h-4 text-violet-600" />}
            active={activeChannel === "CALL_CENTER"}
          />

          <ModuleBox
            title="Consola 2FA (Out-of-Band)"
            subtitle="Verificación Step-Up OTP 6 dígitos (cambios de canal y terceros)"
            badge="TTL 5m · Máx. 3 intentos"
            icon={<KeyRound className="w-4 h-4 text-amber-600" />}
            active={isOtpPulse}
          />
        </div>

        {/* COLUMNA 2: CEREBRO ORQUESTADOR (AWS ECS FARGATE STATELESS) */}
        <div className="xl:col-span-5 bg-gradient-to-b from-white to-emerald-50/40 rounded-2xl border-2 border-[#00843D]/30 p-5 shadow-sm space-y-4 flex flex-col">
          <div className="flex items-center justify-between border-b border-emerald-100 pb-2.5">
            <div className="text-xs font-extrabold uppercase tracking-wider text-[#005A2B] flex items-center gap-1.5">
              <Server className="w-4 h-4 text-[#00843D]" />
              2. Cerebro Orquestador Stateless (AWS ECS Fargate)
            </div>
            <span className="text-[10px] font-mono bg-[#E6F4EC] text-[#005A2B] px-2 py-0.5 rounded font-bold">
              Node 20 · Fastify v5
            </span>
          </div>

          {/* Perímetro de Seguridad */}
          <div className="p-3.5 rounded-xl bg-slate-900 text-white space-y-1.5">
            <div className="text-xs font-bold flex items-center gap-1.5 text-emerald-300">
              <Lock className="w-3.5 h-3.5" />
              Perímetro Criptográfico y Control de Acceso
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
              <div>• Firma E2E HMAC-SHA256 (`timingSafeEqual`)</div>
              <div>• Anti-replay `X-Gateway-Timestamp` (±300s)</div>
              <div>• JWT separado (`PATIENT` vs `STAFF`)</div>
              <div>• PII Masking automático en observabilidad</div>
            </div>
          </div>

          {/* 4 Módulos internos del Orquestador */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
            <ModuleBox
              title="Identity Resolution Multibeneficiario"
              subtitle="Separa Titular (teléfono/cuenta) de Beneficiario (expediente clínico por CURP)"
              badge="patient_relationships"
              icon={<Users className="w-4 h-4 text-[#0066B3]" />}
              active={activeEventType === "IDENTITY_LINKED" || isOtpPulse}
            />

            <ModuleBox
              title="Máquina de Estados (8 Estados)"
              subtitle="100% determinística (sin Bot-Bot) · N-saltos bidireccionales + Lock Optimista"
              badge="service_cases.version"
              icon={<Layers className="w-4 h-4 text-[#00843D]" />}
              active={Boolean(latestEvent)}
            />

            <ModuleBox
              title="Worker BullMQ WhatsApp"
              subtitle="Menú multibeneficiario numerado, cotización, dudas y firma de respuestas salientes"
              badge={`Completados: ${overview?.queues.whatsappInbound.completed ?? 0}`}
              icon={<Activity className="w-4 h-4 text-emerald-700" />}
              active={activeChannel === "WHATSAPP"}
            />

            <ModuleBox
              title="Event Bus & Auditoría"
              subtitle="Persiste journey_events inmutable y difunde por Redis Pub/Sub con correlation_id"
              badge={`Eventos: ${overview?.kpis.totalEventsRecorded ?? 0}`}
              icon={<ShieldCheck className="w-4 h-4 text-indigo-600" />}
              active={Boolean(latestEvent)}
            />
          </div>

          {/* Flecha visual del flujo de datos */}
          <div className="rounded-xl bg-white border border-emerald-200 px-3.5 py-2.5 flex flex-wrap items-center justify-center gap-2 text-[11px] font-bold text-slate-700">
            <span>Ingesta Firmada</span>
            <ArrowRight className="w-3.5 h-3.5 text-[#00843D]" />
            <span>Redis SETNX</span>
            <ArrowRight className="w-3.5 h-3.5 text-[#00843D]" />
            <span>BullMQ Worker</span>
            <ArrowRight className="w-3.5 h-3.5 text-[#00843D]" />
            <span>PostgreSQL + JSONB</span>
            <ArrowRight className="w-3.5 h-3.5 text-[#00843D]" />
            <span>Pub/Sub → SSE Vivo</span>
          </div>
        </div>

        {/* COLUMNA 3: BUS DE EVENTOS (REDIS) Y PERSISTENCIA (POSTGRESQL) */}
        <div className="xl:col-span-4 bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-4 flex flex-col">
          <div className="text-xs font-extrabold uppercase tracking-wider text-slate-500 border-b border-slate-100 pb-2">
            3. Bus Distribuido (Redis) y Persistencia (PostgreSQL)
          </div>

          {/* Bus Redis */}
          <div className="p-4 rounded-xl bg-rose-50/60 border border-rose-200/80 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="text-xs font-extrabold text-rose-800 flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-rose-600" />
                Bus Efímero · Redis 7 / AWS Valkey
              </div>
              <span className="text-[10px] font-mono bg-white px-1.5 py-0.5 rounded border border-rose-200 text-rose-700">
                prefix: {"{bull}"}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2 text-xs">
              <BusChannelPill
                name="SETNX wamid:<id>"
                desc="Idempotencia 24h anti-duplicados"
                metric="0 duplicados"
              />
              <BusChannelPill
                name="BullMQ: whatsapp-inbound + DLQ"
                desc="3 reintentos exponenciales + cola de fallos"
                metric={`DLQ: ${overview?.queues.whatsappDlq.waiting ?? 0}`}
              />
              <BusChannelPill
                name="Pub/Sub: journey:events"
                desc="Alimenta Admin SSE + Tracking Paciente en vivo"
                metric={`SSE: ${overview?.kpis.activeSseSubscribers ?? 0}`}
              />
              <BusChannelPill
                name="Pub/Sub: whatsapp:outbound"
                desc="Envía respuestas firmadas HMAC al Gateway Baileys"
                metric={`GW: ${gatewayCount}`}
              />
              <BusChannelPill
                name="TTL: otp:challenge + wa:active_case"
                desc="Retos OTP 5m y selección activa de familiar (30m)"
                metric="Auto-expira"
              />
            </div>
          </div>

          {/* PostgreSQL 16 RDS */}
          <div className="p-4 rounded-xl bg-blue-50/60 border border-blue-200/80 space-y-2.5 flex-1">
            <div className="flex items-center justify-between">
              <div className="text-xs font-extrabold text-[#005291] flex items-center gap-1.5">
                <Database className="w-4 h-4 text-[#0066B3]" />
                Persistencia Transaccional · PostgreSQL 16 RDS
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <DbTableTag name="patients" desc="9 campos + CURP única + cuenta" />
              <DbTableTag name="patient_relationships" desc="Titular → Familiar + consentimiento" />
              <DbTableTag name="identity_links" desc="Hashes HMAC + PII enmascarada" />
              <DbTableTag name="service_cases" desc="Beneficiario + Titular + JSONB + version" />
              <DbTableTag name="journey_events" desc="Audit trail inmutable (13 eventos)" />
              <DbTableTag name="users_staff" desc="Roles RBAC (ADMIN / ASESOR)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ModuleBox: React.FC<{
  title: string;
  subtitle: string;
  badge: string;
  icon: React.ReactNode;
  active?: boolean;
}> = ({ title, subtitle, badge, icon, active }) => (
  <div
    className={`p-3.5 rounded-xl border transition-all ${
      active
        ? "bg-[#E6F4EC] border-[#00843D] ring-2 ring-[#00843D]/25 shadow-sm"
        : "bg-white border-slate-200/90 hover:border-slate-300"
    }`}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-slate-50 border border-slate-100 shrink-0">{icon}</div>
        <div className="text-xs font-extrabold text-slate-900 leading-tight">{title}</div>
      </div>
      {active && <span className="w-2 h-2 rounded-full bg-[#00843D] animate-ping shrink-0 mt-1" />}
    </div>
    <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">{subtitle}</p>
    <div className="mt-2 inline-block px-2 py-0.5 rounded bg-slate-100 text-[10px] font-mono font-semibold text-slate-700">
      {badge}
    </div>
  </div>
);

const BusChannelPill: React.FC<{ name: string; desc: string; metric: string }> = ({
  name,
  desc,
  metric,
}) => (
  <div className="bg-white rounded-lg px-3 py-2 border border-rose-200/70 flex items-center justify-between gap-2">
    <div className="min-w-0">
      <div className="text-[11px] font-bold font-mono text-slate-800 truncate">{name}</div>
      <div className="text-[10px] text-slate-500 truncate">{desc}</div>
    </div>
    <span className="shrink-0 px-2 py-0.5 rounded bg-rose-50 text-rose-700 text-[10px] font-bold">
      {metric}
    </span>
  </div>
);

const DbTableTag: React.FC<{ name: string; desc: string }> = ({ name, desc }) => (
  <div className="bg-white rounded-lg p-2.5 border border-blue-200/70">
    <div className="font-mono font-bold text-[#005291]">{name}</div>
    <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">{desc}</div>
  </div>
);
