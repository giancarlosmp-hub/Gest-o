-- CreateTable
CREATE TABLE "OpportunityChangeLog" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpportunityChangeLog_opportunityId_createdAt_idx" ON "OpportunityChangeLog"("opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "OpportunityChangeLog" ADD CONSTRAINT "OpportunityChangeLog_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityChangeLog" ADD CONSTRAINT "OpportunityChangeLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
