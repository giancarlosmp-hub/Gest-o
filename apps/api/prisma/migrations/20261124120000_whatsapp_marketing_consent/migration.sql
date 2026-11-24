-- Campanhas WhatsApp Fase 1: histórico de aceite/descadastro dos boletins por telefone e culturas do cliente.
-- Somente aditiva: dois enums novos, duas tabelas novas, três índices e quatro chaves estrangeiras.
-- Nenhum dado existente é tocado.
-- CreateEnum
CREATE TYPE "MarketingConsentStatus" AS ENUM ('ACEITE', 'DESCADASTRO');

-- CreateEnum
CREATE TYPE "MarketingConsentSource" AS ENUM ('VENDEDOR_MANUAL', 'WHATSAPP_LINK', 'WHATSAPP_BOTAO', 'WHATSAPP_PALAVRA', 'OUTRO');

-- CreateTable
CREATE TABLE "MarketingConsentEvent" (
    "id" TEXT NOT NULL,
    "tenantId" VARCHAR(64) NOT NULL,
    "phone" VARCHAR(13) NOT NULL,
    "clientId" TEXT,
    "status" "MarketingConsentStatus" NOT NULL,
    "source" "MarketingConsentSource" NOT NULL,
    "note" VARCHAR(280),
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientCulture" (
    "clientId" TEXT NOT NULL,
    "cultureId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientCulture_pkey" PRIMARY KEY ("clientId","cultureId")
);

-- CreateIndex
CREATE INDEX "MarketingConsentEvent_tenantId_phone_createdAt_idx" ON "MarketingConsentEvent"("tenantId", "phone", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingConsentEvent_clientId_createdAt_idx" ON "MarketingConsentEvent"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientCulture_cultureId_idx" ON "ClientCulture"("cultureId");

-- AddForeignKey
ALTER TABLE "MarketingConsentEvent" ADD CONSTRAINT "MarketingConsentEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsentEvent" ADD CONSTRAINT "MarketingConsentEvent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCulture" ADD CONSTRAINT "ClientCulture_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCulture" ADD CONSTRAINT "ClientCulture_cultureId_fkey" FOREIGN KEY ("cultureId") REFERENCES "CultureCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

