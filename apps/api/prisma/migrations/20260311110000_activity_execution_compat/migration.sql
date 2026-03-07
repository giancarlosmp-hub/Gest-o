-- Extend ActivityType enum with execution-oriented values (backward compatible)
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'followup';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'proposta_enviada';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'proposta_negociacao';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'fechamento';

-- Add optional execution fields in Activity for incremental rollout
ALTER TABLE "Activity"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "result" TEXT,
  ADD COLUMN IF NOT EXISTS "date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "duration" INTEGER,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "crop" TEXT,
  ADD COLUMN IF NOT EXISTS "areaEstimated" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "product" TEXT,
  ADD COLUMN IF NOT EXISTS "clientId" TEXT,
  ADD COLUMN IF NOT EXISTS "agendaEventId" TEXT;

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_agendaEventId_fkey"
  FOREIGN KEY ("agendaEventId") REFERENCES "AgendaEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Activity_clientId_idx" ON "Activity"("clientId");
CREATE INDEX IF NOT EXISTS "Activity_agendaEventId_idx" ON "Activity"("agendaEventId");
