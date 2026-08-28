CREATE TYPE "ErpOrderManualResolutionTerminalState" AS ENUM ('manually_resolved_not_found');

ALTER TABLE "ErpOrderManualResolution"
  ADD COLUMN "terminalState" "ErpOrderManualResolutionTerminalState" NOT NULL DEFAULT 'manually_resolved_not_found',
  ADD COLUMN "statusCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "statusCheckCorrelationId" TEXT NOT NULL DEFAULT 'migration-backfill-unavailable';

ALTER TABLE "ErpOrderManualResolution"
  ALTER COLUMN "terminalState" DROP DEFAULT,
  ALTER COLUMN "statusCheckedAt" DROP DEFAULT,
  ALTER COLUMN "statusCheckCorrelationId" DROP DEFAULT;
