DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClientType') THEN
    CREATE TYPE "ClientType" AS ENUM ('PJ', 'PF');
  END IF;
END $$;

ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "clientType" "ClientType" NOT NULL DEFAULT 'PJ',
  ADD COLUMN IF NOT EXISTS "cnpj" TEXT,
  ADD COLUMN IF NOT EXISTS "segment" TEXT;

CREATE TEMP TABLE company_client_map (
  company_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO "Client" (
    "id", "name", "city", "state", "region", "potentialHa", "farmSizeHa", "clientType", "cnpj", "segment", "ownerSellerId", "createdAt"
  )
  SELECT
    c."id",
    c."name",
    'Não informado',
    'NI',
    COALESCE(u."region", 'Nacional'),
    0,
    0,
    'PJ'::"ClientType",
    c."cnpj",
    c."segment",
    c."ownerSellerId",
    c."createdAt"
  FROM "Company" c
  LEFT JOIN "User" u ON u."id" = c."ownerSellerId"
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
INSERT INTO company_client_map (company_id, client_id)
SELECT c."id", c."id"
FROM "Company" c;

UPDATE "Contact" ct
SET "clientId" = map.client_id
FROM company_client_map map
WHERE ct."companyId" = map.company_id
  AND (ct."clientId" IS NULL OR ct."clientId" = '');

ALTER TABLE "Contact" DROP COLUMN IF EXISTS "companyId";
DROP TABLE IF EXISTS "Company";
