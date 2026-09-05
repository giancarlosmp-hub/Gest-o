ALTER TABLE "ErpOrderSync"
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "erpOrderId" TEXT,
  ADD COLUMN "operationalStatusRaw" TEXT;

CREATE TYPE "ErpOperationalOrderStatus" AS ENUM ('DIGITADO', 'ACEITO', 'EXPEDINDO', 'FATURAR', 'PARCIAL', 'FINALIZADO', 'CANCELADO', 'SUSPENSO', 'UNKNOWN');
CREATE TYPE "ErpRequestAuthorizationStatus" AS ENUM ('NONE_OR_NOT_APPLICABLE', 'PARTIALLY_AUTHORIZED', 'NONE_AUTHORIZED', 'ALL_AUTHORIZED', 'UNKNOWN');

ALTER TABLE "ErpOrderSync"
  ADD COLUMN "operationalOrderStatus" "ErpOperationalOrderStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "requestAuthorizationStatus" "ErpRequestAuthorizationStatus" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "ErpOrderSync" AS orders
SET "tenantId" = clients."tenantId"
FROM "Opportunity" AS opportunities
JOIN "Client" AS clients ON clients."id" = opportunities."clientId"
WHERE opportunities."id" = orders."opportunityId"
  AND orders."tenantId" IS NULL;

ALTER TABLE "ErpOrderSync"
  ADD CONSTRAINT "ErpOrderSync_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "ErpOrderSync_tenantId_createdAt_idx" ON "ErpOrderSync"("tenantId", "createdAt");
CREATE INDEX "ErpOrderSync_tenantId_sellerId_createdAt_idx" ON "ErpOrderSync"("tenantId", "sellerId", "createdAt");

CREATE TABLE "ErpOrderStatusHistory" (
  "id" TEXT NOT NULL,
  "erpOrderSyncId" TEXT NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "syncStatus" "ErpOrderSyncStatus" NOT NULL,
  "orderStatus" "ErpOrderFulfillmentStatus",
  "operationalStatusRaw" TEXT,
  "source" TEXT NOT NULL,
  "errorMessage" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ErpOrderStatusHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ErpOrderStatusHistory_erpOrderSyncId_fkey" FOREIGN KEY ("erpOrderSyncId") REFERENCES "ErpOrderSync"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ErpOrderStatusHistory_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ErpOrderStatusHistory_erpOrderSyncId_occurredAt_idx" ON "ErpOrderStatusHistory"("erpOrderSyncId", "occurredAt");
CREATE INDEX "ErpOrderStatusHistory_opportunityId_occurredAt_idx" ON "ErpOrderStatusHistory"("opportunityId", "occurredAt");

INSERT INTO "ErpOrderStatusHistory" ("id", "erpOrderSyncId", "opportunityId", "syncStatus", "orderStatus", "operationalStatusRaw", "source", "errorMessage", "occurredAt")
SELECT CONCAT('backfill-', "id"), "id", "opportunityId", "status", "orderStatus", NULL, 'migration-backfill', NULL, "createdAt"
FROM "ErpOrderSync";
