CREATE TYPE "ErpOrderSyncStatus" AS ENUM ('pending', 'sent', 'error');
CREATE TYPE "ErpOrderFulfillmentStatus" AS ENUM ('pendente', 'faturado', 'parcial', 'cancelado', 'entregue');

CREATE TABLE "ErpOrderSync" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "pedidoIdImportacao" TEXT NOT NULL,
    "numPedido" TEXT,
    "erpOrderNumber" TEXT,
    "status" "ErpOrderSyncStatus" NOT NULL DEFAULT 'pending',
    "orderStatus" "ErpOrderFulfillmentStatus",
    "payloadSent" JSONB NOT NULL,
    "erpResponse" JSONB,
    "syncErrors" JSONB,
    "lastStatusPayload" JSONB,
    "sentAt" TIMESTAMP(3),
    "statusSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpOrderSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErpOrderSync_pedidoIdImportacao_key" ON "ErpOrderSync"("pedidoIdImportacao");
CREATE INDEX "ErpOrderSync_opportunityId_createdAt_idx" ON "ErpOrderSync"("opportunityId", "createdAt");
CREATE INDEX "ErpOrderSync_status_idx" ON "ErpOrderSync"("status");
CREATE INDEX "ErpOrderSync_orderStatus_idx" ON "ErpOrderSync"("orderStatus");
CREATE INDEX "ErpOrderSync_numPedido_idx" ON "ErpOrderSync"("numPedido");

ALTER TABLE "ErpOrderSync" ADD CONSTRAINT "ErpOrderSync_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErpOrderSync" ADD CONSTRAINT "ErpOrderSync_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
