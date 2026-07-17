-- CreateEnum
CREATE TYPE "CommunicationChannelType" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK_MESSENGER', 'EMAIL', 'SMS', 'RCS', 'TELEGRAM', 'WEBSITE_CHAT', 'OTHER');
CREATE TYPE "CommunicationProviderType" AS ENUM ('META_WHATSAPP_CLOUD');
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "CommunicationMessageType" AS ENUM ('TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'LOCATION', 'CONTACT', 'STICKER', 'REACTION', 'INTERACTIVE', 'TEMPLATE', 'UNKNOWN');
CREATE TYPE "CommunicationMessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');
CREATE TYPE "CommunicationConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'ARCHIVED', 'BLOCKED');
CREATE TYPE "CommunicationWebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "CommunicationConversation" (
    "id" TEXT NOT NULL,
    "channelType" "CommunicationChannelType" NOT NULL,
    "providerType" "CommunicationProviderType" NOT NULL,
    "externalConversationKey" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "clientId" TEXT,
    "assignedSellerId" TEXT,
    "normalizedContact" TEXT NOT NULL,
    "displayContact" TEXT,
    "contactName" TEXT,
    "status" "CommunicationConversationStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessagePreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunicationConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelType" "CommunicationChannelType" NOT NULL,
    "providerType" "CommunicationProviderType" NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "direction" "CommunicationDirection" NOT NULL,
    "messageType" "CommunicationMessageType" NOT NULL,
    "textContent" TEXT,
    "mediaExternalId" TEXT,
    "mediaMimeType" TEXT,
    "mediaFilename" TEXT,
    "mediaSizeBytes" INTEGER,
    "providerTimestamp" TIMESTAMP(3) NOT NULL,
    "replyToExternalMessageId" TEXT,
    "status" "CommunicationMessageStatus" NOT NULL,
    "errorCode" TEXT,
    "errorMessageSanitized" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunicationMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationWebhookEvent" (
    "id" TEXT NOT NULL,
    "channelType" "CommunicationChannelType" NOT NULL,
    "providerType" "CommunicationProviderType" NOT NULL,
    "externalEventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processingStatus" "CommunicationWebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "errorSanitized" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunicationWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- Indexes and idempotency constraints
CREATE UNIQUE INDEX "CommunicationConversation_providerType_externalConversationKey_key" ON "CommunicationConversation"("providerType", "externalConversationKey");
CREATE INDEX "CommunicationConversation_clientId_idx" ON "CommunicationConversation"("clientId");
CREATE INDEX "CommunicationConversation_assignedSellerId_idx" ON "CommunicationConversation"("assignedSellerId");
CREATE INDEX "CommunicationConversation_lastMessageAt_idx" ON "CommunicationConversation"("lastMessageAt");
CREATE INDEX "CommunicationConversation_status_idx" ON "CommunicationConversation"("status");
CREATE INDEX "CommunicationConversation_normalizedContact_idx" ON "CommunicationConversation"("normalizedContact");
CREATE UNIQUE INDEX "CommunicationMessage_providerType_externalMessageId_key" ON "CommunicationMessage"("providerType", "externalMessageId");
CREATE INDEX "CommunicationMessage_conversationId_providerTimestamp_idx" ON "CommunicationMessage"("conversationId", "providerTimestamp");
CREATE INDEX "CommunicationMessage_status_idx" ON "CommunicationMessage"("status");
CREATE UNIQUE INDEX "CommunicationWebhookEvent_providerType_externalEventKey_key" ON "CommunicationWebhookEvent"("providerType", "externalEventKey");
CREATE INDEX "CommunicationWebhookEvent_processingStatus_idx" ON "CommunicationWebhookEvent"("processingStatus");
CREATE INDEX "CommunicationWebhookEvent_createdAt_idx" ON "CommunicationWebhookEvent"("createdAt");

-- Foreign keys
ALTER TABLE "CommunicationConversation" ADD CONSTRAINT "CommunicationConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationConversation" ADD CONSTRAINT "CommunicationConversation_assignedSellerId_fkey" FOREIGN KEY ("assignedSellerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationMessage" ADD CONSTRAINT "CommunicationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CommunicationConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
