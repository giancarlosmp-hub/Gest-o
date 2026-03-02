ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'follow_up';

ALTER TABLE "AgendaEvent"
ADD COLUMN "opportunityId" TEXT;

CREATE INDEX "AgendaEvent_opportunityId_idx" ON "AgendaEvent"("opportunityId");

ALTER TABLE "AgendaEvent"
ADD CONSTRAINT "AgendaEvent_opportunityId_fkey"
FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
