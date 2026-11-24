-- AlterTable: Add optional email and password_hash to patients for real patient portal accounts
ALTER TABLE "patients"
  ADD COLUMN IF NOT EXISTS "email" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "password_hash" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "patients_email_key" ON "patients"("email");
