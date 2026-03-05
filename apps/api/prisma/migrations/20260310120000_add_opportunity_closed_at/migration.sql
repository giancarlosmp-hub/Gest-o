ALTER TABLE "Opportunity"
ADD COLUMN "closedAt" TIMESTAMP(3);

CREATE INDEX "Opportunity_closedAt_idx" ON "Opportunity"("closedAt");
