-- Beta v2: Multibeneficiario (Titular != Paciente Beneficiario con privacidad clinica)

-- 1. CreateEnum RelationshipType
DO $$ BEGIN
  CREATE TYPE "RelationshipType" AS ENUM ('SELF', 'HIJO_A', 'PADRE_MADRE', 'CONYUGE', 'ABUELO_A', 'FAMILIAR', 'CONOCIDO');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Drop unique constraint on patients.telefono (permitir telefono compartido entre familiares)
DROP INDEX IF EXISTS "patients_telefono_key";
CREATE INDEX IF NOT EXISTS "idx_patients_phone" ON "patients"("telefono");

-- 3. AlterTable service_cases: separar requester (Titular) de patient (Beneficiario)
ALTER TABLE "service_cases"
  ADD COLUMN IF NOT EXISTS "requester_patient_id" UUID,
  ADD COLUMN IF NOT EXISTS "relationship_label" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "third_party_consent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existente: casos previos eran del propio titular
UPDATE "service_cases"
SET "requester_patient_id" = "patient_id",
    "relationship_label" = COALESCE("relationship_label", 'Titular')
WHERE "requester_patient_id" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_cases_requester_state"
  ON "service_cases"("requester_patient_id", "current_state");

DO $$ BEGIN
  ALTER TABLE "service_cases"
    ADD CONSTRAINT "service_cases_requester_patient_id_fkey"
    FOREIGN KEY ("requester_patient_id") REFERENCES "patients"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 4. CreateTable patient_relationships
CREATE TABLE IF NOT EXISTS "patient_relationships" (
  "id" UUID NOT NULL,
  "holder_patient_id" UUID NOT NULL,
  "beneficiary_patient_id" UUID NOT NULL,
  "relationship" "RelationshipType" NOT NULL DEFAULT 'FAMILIAR',
  "consent_accepted" BOOLEAN NOT NULL DEFAULT true,
  "consent_accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "patient_relationships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_holder_beneficiary"
  ON "patient_relationships"("holder_patient_id", "beneficiary_patient_id");

CREATE INDEX IF NOT EXISTS "idx_relationships_holder"
  ON "patient_relationships"("holder_patient_id");

DO $$ BEGIN
  ALTER TABLE "patient_relationships"
    ADD CONSTRAINT "patient_relationships_holder_patient_id_fkey"
    FOREIGN KEY ("holder_patient_id") REFERENCES "patients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "patient_relationships"
    ADD CONSTRAINT "patient_relationships_beneficiary_patient_id_fkey"
    FOREIGN KEY ("beneficiary_patient_id") REFERENCES "patients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
