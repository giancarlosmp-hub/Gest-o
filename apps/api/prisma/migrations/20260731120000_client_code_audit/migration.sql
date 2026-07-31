CREATE TABLE "ClientCodeAudit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "partnerErp" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "origin" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "requestIp" TEXT,
    "requestId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientCodeAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientCodeAudit_clientId_createdAt_idx" ON "ClientCodeAudit"("clientId", "createdAt");
CREATE INDEX "ClientCodeAudit_requestId_idx" ON "ClientCodeAudit"("requestId");
CREATE INDEX "ClientCodeAudit_origin_createdAt_idx" ON "ClientCodeAudit"("origin", "createdAt");
ALTER TABLE "ClientCodeAudit" ADD CONSTRAINT "ClientCodeAudit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
