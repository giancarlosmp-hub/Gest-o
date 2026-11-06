-- WhatsApp Fase A: conexão por QR do número comercial de cada usuário (Evolution API).
-- Somente aditiva: enum e tabela novos, sem tocar em dados existentes.
-- CreateEnum
CREATE TYPE "WhatsAppConnectionStatus" AS ENUM ('PENDING_QR', 'CONNECTED', 'DISCONNECTED', 'REJECTED_WRONG_NUMBER', 'ERROR');

-- CreateTable
CREATE TABLE "WhatsAppConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" VARCHAR(64),
    "provider" VARCHAR(32) NOT NULL DEFAULT 'evolution',
    "instanceName" VARCHAR(64) NOT NULL,
    "expectedPhone" VARCHAR(13) NOT NULL,
    "connectedPhone" VARCHAR(13),
    "status" "WhatsAppConnectionStatus" NOT NULL DEFAULT 'PENDING_QR',
    "statusReason" VARCHAR(64),
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedById" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConnection_userId_key" ON "WhatsAppConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConnection_instanceName_key" ON "WhatsAppConnection"("instanceName");

-- CreateIndex
CREATE INDEX "WhatsAppConnection_status_idx" ON "WhatsAppConnection"("status");

-- CreateIndex
CREATE INDEX "WhatsAppConnection_connectedPhone_idx" ON "WhatsAppConnection"("connectedPhone");

-- AddForeignKey
ALTER TABLE "WhatsAppConnection" ADD CONSTRAINT "WhatsAppConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
