-- These objects are introduced together because both migrations belong to this unmerged PR.
CREATE TYPE "ErpOrderManualResolutionCategory" AS ENUM ('manual_verified_not_found');
CREATE TYPE "ErpOrderManualResolutionTerminalState" AS ENUM ('manually_resolved_not_found');

ALTER TABLE "ErpOrderSync" ADD COLUMN "supersedesErpOrderSyncId" TEXT;

CREATE TABLE "ErpOrderManualResolution" (
    "id" TEXT NOT NULL,
    "erpOrderSyncId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "resolvedById" TEXT NOT NULL,
    "resolvedRole" "Role" NOT NULL,
    "category" "ErpOrderManualResolutionCategory" NOT NULL,
    "terminalState" "ErpOrderManualResolutionTerminalState" NOT NULL,
    "justification" TEXT NOT NULL,
    "originalPedidoIdImportacao" TEXT NOT NULL,
    "originalCorrelationId" TEXT NOT NULL,
    "statusCheckedAt" TIMESTAMP(3) NOT NULL,
    "statusCheckCorrelationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ErpOrderManualResolution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErpOrderManualResolution_erpOrderSyncId_key" ON "ErpOrderManualResolution"("erpOrderSyncId");
CREATE INDEX "ErpOrderManualResolution_opportunityId_createdAt_idx" ON "ErpOrderManualResolution"("opportunityId", "createdAt");
CREATE INDEX "ErpOrderManualResolution_resolvedById_createdAt_idx" ON "ErpOrderManualResolution"("resolvedById", "createdAt");
CREATE INDEX "ErpOrderSync_supersedesErpOrderSyncId_idx" ON "ErpOrderSync"("supersedesErpOrderSyncId");

ALTER TABLE "ErpOrderSync" ADD CONSTRAINT "ErpOrderSync_supersedesErpOrderSyncId_fkey" FOREIGN KEY ("supersedesErpOrderSyncId") REFERENCES "ErpOrderSync"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ErpOrderManualResolution" ADD CONSTRAINT "ErpOrderManualResolution_erpOrderSyncId_fkey" FOREIGN KEY ("erpOrderSyncId") REFERENCES "ErpOrderSync"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ErpOrderManualResolution" ADD CONSTRAINT "ErpOrderManualResolution_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ErpOrderManualResolution" ADD CONSTRAINT "ErpOrderManualResolution_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
