ALTER TABLE "ErpSyncRun"
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "sellerName" TEXT,
  ADD COLUMN "authMode" TEXT NOT NULL DEFAULT 'global';

CREATE INDEX "ErpSyncRun_sellerId_startedAt_idx" ON "ErpSyncRun"("sellerId", "startedAt");
CREATE INDEX "ErpSyncRun_authMode_startedAt_idx" ON "ErpSyncRun"("authMode", "startedAt");
