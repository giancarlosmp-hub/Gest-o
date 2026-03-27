ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "code" TEXT,
  ADD COLUMN IF NOT EXISTS "fantasyName" TEXT;

CREATE INDEX IF NOT EXISTS "Client_code_idx" ON "Client" ("code");
CREATE INDEX IF NOT EXISTS "Client_fantasyName_idx" ON "Client" ("fantasyName");
