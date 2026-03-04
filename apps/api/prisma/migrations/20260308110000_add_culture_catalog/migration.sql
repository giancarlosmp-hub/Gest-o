CREATE TABLE IF NOT EXISTS "CultureCatalog" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "defaultKgHaMin" DOUBLE PRECISION,
  "defaultKgHaMax" DOUBLE PRECISION,
  "goalsJson" JSONB NOT NULL,
  "notes" TEXT,
  "pmsDefault" DOUBLE PRECISION,
  "germinationDefault" DOUBLE PRECISION,
  "purityDefault" DOUBLE PRECISION,
  "populationTargetDefault" DOUBLE PRECISION,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CultureCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CultureCatalog_slug_key" ON "CultureCatalog"("slug");
CREATE INDEX IF NOT EXISTS "CultureCatalog_isActive_idx" ON "CultureCatalog"("isActive");
