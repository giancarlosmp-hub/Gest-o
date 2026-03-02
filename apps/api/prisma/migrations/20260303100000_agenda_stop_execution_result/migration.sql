ALTER TABLE "AgendaStop"
ADD COLUMN "resultStatus" TEXT,
ADD COLUMN "resultReason" TEXT,
ADD COLUMN "resultSummary" TEXT,
ADD COLUMN "nextStep" TEXT,
ADD COLUMN "nextStepDate" TIMESTAMP(3);
