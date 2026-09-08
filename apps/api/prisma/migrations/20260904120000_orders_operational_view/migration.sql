BEGIN;

ALTER TABLE "ErpOrderSync"
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "erpOrderId" TEXT,
  ADD COLUMN "operationalStatusRaw" TEXT;

CREATE TYPE "ErpOperationalOrderStatus" AS ENUM ('DIGITADO', 'ACEITO', 'EXPEDINDO', 'FATURAR', 'PARCIAL', 'FINALIZADO', 'CANCELADO', 'SUSPENSO', 'UNKNOWN');
CREATE TYPE "ErpRequestAuthorizationStatus" AS ENUM ('NONE_OR_NOT_APPLICABLE', 'PARTIALLY_AUTHORIZED', 'NONE_AUTHORIZED', 'ALL_AUTHORIZED', 'UNKNOWN');

ALTER TABLE "ErpOrderSync"
  ADD COLUMN "operationalOrderStatus" "ErpOperationalOrderStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "requestAuthorizationStatus" "ErpRequestAuthorizationStatus" NOT NULL DEFAULT 'UNKNOWN';

CREATE TEMP TABLE orders_history_guard ON COMMIT DROP AS
SELECT orders.id AS order_id,
       orders."sellerId" AS seller_id,
       orders."opportunityId" AS opportunity_id,
       orders.status AS sync_status,
       orders."orderStatus" AS order_status,
       opportunities."clientId" AS client_id,
       (SELECT count(*) FROM "TimelineEvent" timeline WHERE timeline."clientId" = opportunities."clientId") AS timeline_count,
       (SELECT count(*) FROM "Activity" activity WHERE activity."clientId" = opportunities."clientId") AS activity_count,
       (SELECT count(*) FROM "OpportunityChangeLog" change_log WHERE change_log."opportunityId" = opportunities.id) AS change_log_count
FROM "ErpOrderSync" orders
LEFT JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId";

-- Historical ownership is proved from the immutable Opportunity -> Client chain.  A
-- seller (or a current membership) is deliberately not an ownership authority: both
-- may have become inactive after the order was created.
DO $$
DECLARE
  tenant_count bigint;
  active_tenant_count bigint;
  order_count bigint;
  order_without_opportunity_count bigint;
  order_without_client_count bigint;
  order_with_foreign_tenant_count bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'active')
    INTO tenant_count, active_tenant_count
    FROM "Tenant";
  SELECT count(*) INTO order_count FROM "ErpOrderSync";
  SELECT count(*) INTO order_without_opportunity_count
    FROM "ErpOrderSync" orders
    LEFT JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId"
   WHERE opportunities.id IS NULL;
  SELECT count(*) INTO order_without_client_count
    FROM "ErpOrderSync" orders
    JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId"
    LEFT JOIN "Client" clients ON clients.id = opportunities."clientId"
   WHERE clients.id IS NULL;
  SELECT count(*) INTO order_with_foreign_tenant_count
    FROM "ErpOrderSync" orders
    JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId"
    JOIN "Client" clients ON clients.id = opportunities."clientId"
   WHERE clients."tenantId" IS NOT NULL
     AND clients."tenantId" IS DISTINCT FROM (SELECT id FROM "Tenant" LIMIT 1);

  IF order_count > 0 AND (tenant_count <> 1 OR active_tenant_count <> 1
     OR order_without_opportunity_count <> 0 OR order_without_client_count <> 0
     OR order_with_foreign_tenant_count <> 0) THEN
    RAISE EXCEPTION
      'orders tenant authority rejected tenants=% active_tenants=% orders=% missing_opportunity=% missing_client=% conflicting_tenant=%',
      tenant_count, active_tenant_count, order_count, order_without_opportunity_count,
      order_without_client_count, order_with_foreign_tenant_count;
  END IF;
END $$;

UPDATE "Client" AS clients
SET "tenantId" = (SELECT id FROM "Tenant")
WHERE clients."tenantId" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "Opportunity" opportunities
    JOIN "ErpOrderSync" orders ON orders."opportunityId" = opportunities.id
    WHERE opportunities."clientId" = clients.id
  );

UPDATE "ErpOrderSync" AS orders
SET "tenantId" = clients."tenantId"
FROM "Opportunity" AS opportunities
JOIN "Client" AS clients ON clients."id" = opportunities."clientId"
WHERE opportunities."id" = orders."opportunityId"
  AND orders."tenantId" IS NULL;

DO $$
DECLARE unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count FROM "ErpOrderSync" WHERE "tenantId" IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'orders tenant backfill unresolved_count=%', unresolved_count;
  END IF;
END $$;

ALTER TABLE "ErpOrderSync" ALTER COLUMN "tenantId" SET NOT NULL;

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
FROM "ErpOrderSync"
ON CONFLICT ("id") DO NOTHING;

DO $$
DECLARE changed_history_count bigint;
BEGIN
  SELECT count(*) INTO changed_history_count
  FROM orders_history_guard guard
  FULL JOIN "ErpOrderSync" orders ON orders.id = guard.order_id
  LEFT JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId"
  WHERE guard.order_id IS NULL OR orders.id IS NULL
     OR orders."sellerId" IS DISTINCT FROM guard.seller_id
     OR orders."opportunityId" IS DISTINCT FROM guard.opportunity_id
     OR orders.status IS DISTINCT FROM guard.sync_status
     OR orders."orderStatus" IS DISTINCT FROM guard.order_status
     OR opportunities."clientId" IS DISTINCT FROM guard.client_id
     OR (SELECT count(*) FROM "TimelineEvent" timeline WHERE timeline."clientId" = guard.client_id) <> guard.timeline_count
     OR (SELECT count(*) FROM "Activity" activity WHERE activity."clientId" = guard.client_id) <> guard.activity_count
     OR (SELECT count(*) FROM "OpportunityChangeLog" change_log WHERE change_log."opportunityId" = guard.opportunity_id) <> guard.change_log_count;
  IF changed_history_count <> 0 THEN
    RAISE EXCEPTION 'orders historical preservation rejected changed_count=%', changed_history_count;
  END IF;

  SELECT count(*) INTO changed_history_count
  FROM "ErpOrderSync" orders
  LEFT JOIN LATERAL (
    SELECT count(*) AS history_count
    FROM "ErpOrderStatusHistory" history
    WHERE history."erpOrderSyncId" = orders.id
      AND history.source = 'migration-backfill'
  ) history ON true
  WHERE history.history_count <> 1;
  IF changed_history_count <> 0 THEN
    RAISE EXCEPTION 'orders migration history rejected invalid_count=%', changed_history_count;
  END IF;
END $$;

COMMIT;
