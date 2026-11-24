-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('WEB_SESSION', 'PHONE', 'EMAIL', 'CURP', 'APP');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB', 'WHATSAPP', 'CALL_CENTER', 'APP', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CaseState" AS ENUM ('INICIADO', 'COTIZANDO', 'CLINICA_ELEGIDA', 'PAUSADO_PENDIENTE', 'EN_PROGRESO', 'DUDAS_ABIERTAS', 'EN_ATENCION_ASESOR', 'CITA_CONFIRMADA');

-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('PATIENT', 'BOT', 'ADVISOR', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('SESSION_STARTED', 'STUDY_QUOTED', 'CLINIC_SELECTED', 'IDENTITY_LINKED', 'FLOW_INTERRUPTED', 'CHANNEL_SWITCH_DETECTED', 'OTP_CHALLENGE_SENT', 'OTP_VALIDATION_FAILED', 'IDENTITY_VERIFIED_OTP', 'CONTEXT_REHYDRATED', 'PATIENT_QUESTION_LOGGED', 'ADVISOR_ASSIGNED', 'APPOINTMENT_CONFIRMED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ASESOR', 'ADMIN');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "nombres" VARCHAR(120),
    "apellido_paterno" VARCHAR(100),
    "apellido_materno" VARCHAR(100),
    "fecha_nacimiento" DATE,
    "genero" "Gender",
    "estado_nacimiento" VARCHAR(80),
    "pais" VARCHAR(80) NOT NULL DEFAULT 'México',
    "curp" VARCHAR(18),
    "telefono" VARCHAR(20),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_links" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "identifier_type" "IdentifierType" NOT NULL,
    "identifier_hash" VARCHAR(128) NOT NULL,
    "identifier_masked" VARCHAR(120) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_cases" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "case_type" VARCHAR(60) NOT NULL DEFAULT 'CITA_ESTUDIO',
    "current_state" "CaseState" NOT NULL DEFAULT 'INICIADO',
    "current_channel" "Channel" NOT NULL,
    "context_json" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "assigned_advisor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_events" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "actor_role" "ActorRole" NOT NULL,
    "event_type" "EventType" NOT NULL,
    "prev_state" "CaseState",
    "next_state" "CaseState",
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users_staff" (
    "id" UUID NOT NULL,
    "email" VARCHAR(180) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "StaffRole" NOT NULL,
    "full_name" VARCHAR(180) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_curp_key" ON "patients"("curp");

-- CreateIndex
CREATE UNIQUE INDEX "patients_telefono_key" ON "patients"("telefono");

-- CreateIndex
CREATE INDEX "idx_patients_full_name" ON "patients"("apellido_paterno", "apellido_materno", "nombres");

-- CreateIndex
CREATE INDEX "idx_identity_links_patient" ON "identity_links"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_links_identifier_type_identifier_hash_key" ON "identity_links"("identifier_type", "identifier_hash");

-- CreateIndex
CREATE UNIQUE INDEX "service_cases_journey_id_key" ON "service_cases"("journey_id");

-- CreateIndex
CREATE INDEX "idx_cases_patient_state" ON "service_cases"("patient_id", "current_state");

-- CreateIndex
CREATE INDEX "idx_cases_state_updated" ON "service_cases"("current_state", "updated_at");

-- CreateIndex
CREATE INDEX "idx_cases_advisor" ON "service_cases"("assigned_advisor_id");

-- CreateIndex
CREATE INDEX "idx_events_case_time" ON "journey_events"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_events_patient_time" ON "journey_events"("patient_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_events_journey_time" ON "journey_events"("journey_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_events_correlation" ON "journey_events"("correlation_id");

-- CreateIndex
CREATE INDEX "idx_events_type_time" ON "journey_events"("event_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_staff_email_key" ON "users_staff"("email");

-- AddForeignKey
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_cases" ADD CONSTRAINT "service_cases_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_cases" ADD CONSTRAINT "service_cases_assigned_advisor_id_fkey" FOREIGN KEY ("assigned_advisor_id") REFERENCES "users_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "service_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
