ALTER TABLE "AppConfig"
  ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "AppConfig"
  ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT;

ALTER TABLE "AppConfig"
  ADD COLUMN IF NOT EXISTS "key" TEXT,
  ADD COLUMN IF NOT EXISTS "value" TEXT;

UPDATE "AppConfig"
SET
  "key" = COALESCE("key", 'minimumWeeklyVisits'),
  "value" = COALESCE("value", "minimumWeeklyVisits"::TEXT);

DELETE FROM "AppConfig" a
USING "AppConfig" b
WHERE a."key" = b."key"
  AND a."updatedAt" < b."updatedAt";

ALTER TABLE "AppConfig"
  ALTER COLUMN "key" SET NOT NULL,
  ALTER COLUMN "value" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'AppConfig_key_key'
  ) THEN
    ALTER TABLE "AppConfig" ADD CONSTRAINT "AppConfig_key_key" UNIQUE ("key");
  END IF;
END $$;

ALTER TABLE "AppConfig"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

INSERT INTO "AppConfig" ("key", "value", "updatedAt")
VALUES ('minimumWeeklyVisits', '25', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "AppConfig" DROP COLUMN IF EXISTS "minimumWeeklyVisits";
