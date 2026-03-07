-- Refactor Activities module to execution-centric model

-- 1) Enum migration with legacy value remap
ALTER TYPE "ActivityType" RENAME TO "ActivityType_old";
CREATE TYPE "ActivityType" AS ENUM (
  'visita',
  'reuniao',
  'ligacao',
  'followup',
  'proposta_enviada',
  'proposta_negociacao',
  'fechamento'
);

ALTER TABLE "Activity"
  ALTER COLUMN "type" TYPE "ActivityType"
  USING (
    CASE
      WHEN "type"::text = 'follow_up' THEN 'followup'::"ActivityType"
      WHEN "type"::text = 'envio_proposta' THEN 'proposta_enviada'::"ActivityType"
      WHEN "type"::text = 'visita_tecnica' THEN 'visita'::"ActivityType"
      WHEN "type"::text = 'whatsapp' THEN 'ligacao'::"ActivityType"
      WHEN "type"::text = 'cliente_novo' THEN 'visita'::"ActivityType"
      ELSE "type"::text::"ActivityType"
    END
  );

DROP TYPE "ActivityType_old";

-- 2) Activity execution fields
ALTER TABLE "Activity"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "result" TEXT,
  ADD COLUMN "date" TIMESTAMP(3),
  ADD COLUMN "duration" INTEGER,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "crop" TEXT,
  ADD COLUMN "areaEstimated" DOUBLE PRECISION,
  ADD COLUMN "product" TEXT,
  ADD COLUMN "agendaEventId" TEXT,
  ADD COLUMN "clientId" TEXT;

UPDATE "Activity"
SET
  "description" = COALESCE("notes", ''),
  "date" = "dueDate";

ALTER TABLE "Activity"
  ALTER COLUMN "description" SET NOT NULL,
  ALTER COLUMN "date" SET NOT NULL;

ALTER TABLE "Activity"
  DROP COLUMN "notes",
  DROP COLUMN "dueDate",
  DROP COLUMN "done";

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_agendaEventId_fkey" FOREIGN KEY ("agendaEventId") REFERENCES "AgendaEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Activity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Activity_ownerSellerId_date_idx" ON "Activity"("ownerSellerId", "date");
CREATE INDEX "Activity_agendaEventId_idx" ON "Activity"("agendaEventId");
CREATE INDEX "Activity_type_date_idx" ON "Activity"("type", "date");
