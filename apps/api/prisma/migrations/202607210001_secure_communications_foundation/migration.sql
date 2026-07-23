-- Secure omnichannel communications foundation.
-- Execute as postgres/migration owner, never as the restricted gesto_app runtime role.
-- Additive only: rollback is operational by disabling COMMUNICATIONS_ENABLED/WHATSAPP_INTEGRATION_ENABLED.

CREATE TYPE "CommunicationChannelType" AS ENUM ('WHATSAPP','INSTAGRAM','FACEBOOK_MESSENGER','EMAIL','SMS','RCS','TELEGRAM','WEBSITE_CHAT','OTHER');
CREATE TYPE "CommunicationProviderType" AS ENUM ('META_WHATSAPP_CLOUD');
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND','OUTBOUND');
CREATE TYPE "CommunicationMessageType" AS ENUM ('TEXT','IMAGE','DOCUMENT','AUDIO','VIDEO','LOCATION','CONTACT','STICKER','REACTION','INTERACTIVE','TEMPLATE','UNKNOWN');
CREATE TYPE "CommunicationMessageStatus" AS ENUM ('RECEIVED','QUEUED','SENT','DELIVERED','READ','FAILED');
CREATE TYPE "CommunicationConversationStatus" AS ENUM ('OPEN','PENDING','RESOLVED','ARCHIVED','BLOCKED');
CREATE TYPE "CommunicationWebhookStatus" AS ENUM ('RECEIVED','PROCESSING','PROCESSED','FAILED','DUPLICATE');

CREATE TABLE "CommunicationConversation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" "CommunicationChannelType" NOT NULL,
  "provider" "CommunicationProviderType" NOT NULL,
  "externalConversationKey" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "tenantId" VARCHAR(64),
  "clientId" TEXT,
  "assignedSellerId" TEXT,
  "contactNormalized" VARCHAR(32),
  "contactDisplay" VARCHAR(64),
  "contactName" VARCHAR(120),
  "status" "CommunicationConversationStatus" NOT NULL DEFAULT 'OPEN',
  "lastMessageAt" TIMESTAMP(3),
  "lastInboundAt" TIMESTAMP(3),
  "lastOutboundAt" TIMESTAMP(3),
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "previewSanitized" VARCHAR(240),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CommunicationConversation_assignedSellerId_fkey" FOREIGN KEY ("assignedSellerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommunicationConversation_provider_externalAccountId_externalConversationKey_key" ON "CommunicationConversation"("provider", "externalAccountId", "externalConversationKey");
CREATE INDEX "CommunicationConversation_tenantId_idx" ON "CommunicationConversation"("tenantId");
CREATE INDEX "CommunicationConversation_clientId_idx" ON "CommunicationConversation"("clientId");
CREATE INDEX "CommunicationConversation_assignedSellerId_idx" ON "CommunicationConversation"("assignedSellerId");
CREATE INDEX "CommunicationConversation_contactNormalized_idx" ON "CommunicationConversation"("contactNormalized");
CREATE INDEX "CommunicationConversation_status_idx" ON "CommunicationConversation"("status");
CREATE INDEX "CommunicationConversation_lastMessageAt_idx" ON "CommunicationConversation"("lastMessageAt");

CREATE TABLE "CommunicationMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "channel" "CommunicationChannelType" NOT NULL,
  "provider" "CommunicationProviderType" NOT NULL,
  "externalMessageId" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "tenantId" VARCHAR(64),
  "direction" "CommunicationDirection" NOT NULL,
  "type" "CommunicationMessageType" NOT NULL,
  "textContent" TEXT,
  "mediaMetadata" JSONB,
  "providerTimestamp" TIMESTAMP(3),
  "replyToExternalMessageId" TEXT,
  "status" "CommunicationMessageStatus" NOT NULL DEFAULT 'RECEIVED',
  "errorSanitized" VARCHAR(240),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CommunicationConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommunicationMessage_provider_externalAccountId_externalMessageId_key" ON "CommunicationMessage"("provider", "externalAccountId", "externalMessageId");
CREATE INDEX "CommunicationMessage_conversationId_idx" ON "CommunicationMessage"("conversationId");
CREATE INDEX "CommunicationMessage_tenantId_idx" ON "CommunicationMessage"("tenantId");
CREATE INDEX "CommunicationMessage_providerTimestamp_idx" ON "CommunicationMessage"("providerTimestamp");
CREATE INDEX "CommunicationMessage_status_idx" ON "CommunicationMessage"("status");

CREATE TABLE "CommunicationWebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" "CommunicationChannelType" NOT NULL,
  "provider" "CommunicationProviderType" NOT NULL,
  "externalEventKey" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "tenantId" VARCHAR(64),
  "eventType" VARCHAR(64) NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "status" "CommunicationWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMP(3),
  "errorSanitized" VARCHAR(240),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CommunicationWebhookEvent_provider_externalAccountId_externalEventKey_key" ON "CommunicationWebhookEvent"("provider", "externalAccountId", "externalEventKey");
CREATE INDEX "CommunicationWebhookEvent_tenantId_idx" ON "CommunicationWebhookEvent"("tenantId");
CREATE INDEX "CommunicationWebhookEvent_status_createdAt_idx" ON "CommunicationWebhookEvent"("status", "createdAt");
CREATE INDEX "CommunicationWebhookEvent_payloadHash_idx" ON "CommunicationWebhookEvent"("payloadHash");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gesto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CommunicationConversation", "CommunicationMessage", "CommunicationWebhookEvent" TO gesto_app;
  END IF;
END $$;
