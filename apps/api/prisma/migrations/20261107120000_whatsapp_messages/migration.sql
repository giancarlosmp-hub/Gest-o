-- WhatsApp Fase B: gravar as conversas do número comercial conectado (Evolution) e ligá-las ao cliente.
-- Somente aditiva: valor de enum (em minúsculas, exigência do gate de preview), colunas anuláveis,
-- tabela nova, índices e chaves estrangeiras. Nenhum dado existente é tocado e o valor novo do enum
-- não é usado aqui (nem default nem dado), o que permite rodar tudo numa transação única.
-- AlterEnum
ALTER TYPE "CommunicationProviderType" ADD VALUE IF NOT EXISTS 'evolution_whatsapp';

-- AlterTable
ALTER TABLE "CommunicationConversation" ADD COLUMN     "linkSource" VARCHAR(16),
ADD COLUMN     "linkStatus" VARCHAR(16),
ADD COLUMN     "linkedAt" TIMESTAMP(3),
ADD COLUMN     "linkedById" TEXT,
ADD COLUMN     "numberOwnerUserId" TEXT,
ADD COLUMN     "unlinkedExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClientPhoneIndex" (
    "id" TEXT NOT NULL,
    "tenantId" VARCHAR(64),
    "phone" VARCHAR(13) NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPhoneIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPhoneIndex_phone_idx" ON "ClientPhoneIndex"("phone");

-- CreateIndex
CREATE INDEX "ClientPhoneIndex_clientId_idx" ON "ClientPhoneIndex"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPhoneIndex_phone_clientId_source_key" ON "ClientPhoneIndex"("phone", "clientId", "source");

-- CreateIndex
CREATE INDEX "CommunicationConversation_numberOwnerUserId_linkStatus_idx" ON "CommunicationConversation"("numberOwnerUserId", "linkStatus");

-- CreateIndex
CREATE INDEX "CommunicationConversation_unlinkedExpiresAt_idx" ON "CommunicationConversation"("unlinkedExpiresAt");

-- CreateIndex
CREATE INDEX "CommunicationMessage_conversationId_providerTimestamp_idx" ON "CommunicationMessage"("conversationId", "providerTimestamp");

-- AddForeignKey
ALTER TABLE "CommunicationConversation" ADD CONSTRAINT "CommunicationConversation_numberOwnerUserId_fkey" FOREIGN KEY ("numberOwnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPhoneIndex" ADD CONSTRAINT "ClientPhoneIndex_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

