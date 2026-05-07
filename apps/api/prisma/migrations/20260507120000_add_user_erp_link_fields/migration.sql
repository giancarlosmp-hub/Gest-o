ALTER TABLE "User"
  ADD COLUMN "erpCode" TEXT,
  ADD COLUMN "erpOperatorCode" TEXT,
  ADD COLUMN "erpRawPayload" JSONB;
