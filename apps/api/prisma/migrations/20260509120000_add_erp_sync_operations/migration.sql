CREATE TYPE "ErpSyncRunStatus" AS ENUM ('running', 'success', 'error', 'skipped');
CREATE TYPE "ErpSyncTrigger" AS ENUM ('manual', 'scheduler');

CREATE TABLE "ErpSyncRun" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "trigger" "ErpSyncTrigger" NOT NULL DEFAULT 'manual',
    "status" "ErpSyncRunStatus" NOT NULL DEFAULT 'running',
    "correlationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "syncedCount" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "errors" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ErpSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ErpSyncLock" (
    "scope" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ErpSyncLock_pkey" PRIMARY KEY ("scope")
);

CREATE INDEX "ErpSyncRun_scope_startedAt_idx" ON "ErpSyncRun"("scope", "startedAt");
CREATE INDEX "ErpSyncRun_status_startedAt_idx" ON "ErpSyncRun"("status", "startedAt");
CREATE INDEX "ErpSyncLock_lockedUntil_idx" ON "ErpSyncLock"("lockedUntil");
