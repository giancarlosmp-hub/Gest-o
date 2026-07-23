CREATE TABLE IF NOT EXISTS "CommunicationIntegrationAccount" (
  "id" TEXT NOT NULL,
  "tenantId" VARCHAR(64) NOT NULL,
  "provider" "CommunicationProviderType" NOT NULL,
  "channel" "CommunicationChannelType" NOT NULL,
  "externalAccountId" VARCHAR(128) NOT NULL,
  "displayName" VARCHAR(120),
  "status" VARCHAR(40) NOT NULL DEFAULT 'pending_configuration',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "configurationState" VARCHAR(40) NOT NULL DEFAULT 'incomplete',
  "credentialReference" VARCHAR(160),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationIntegrationAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_tenant_provider_channel_external_key" ON "CommunicationIntegrationAccount"("tenantId", "provider", "channel", "externalAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_provider_channel_external_idx" ON "CommunicationIntegrationAccount"("provider", "channel", "externalAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_tenant_enabled_idx" ON "CommunicationIntegrationAccount"("tenantId", "enabled");
ALTER TABLE "CommunicationConversation" ADD COLUMN IF NOT EXISTS "integrationAccountId" TEXT;
ALTER TABLE "CommunicationConversation" ADD COLUMN IF NOT EXISTS "contactPhoneHash" VARCHAR(64);
ALTER TABLE "CommunicationMessage" ADD COLUMN IF NOT EXISTS "integrationAccountId" TEXT;
ALTER TABLE "CommunicationMessage" ADD COLUMN IF NOT EXISTS "contactPhoneHash" VARCHAR(64);
ALTER TABLE "CommunicationWebhookEvent" ADD COLUMN IF NOT EXISTS "integrationAccountId" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phoneNormalized" VARCHAR(32);
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phoneHash" VARCHAR(64);
CREATE INDEX IF NOT EXISTS "CommunicationConversation_integrationAccountId_idx" ON "CommunicationConversation"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_tenant_phoneHash_idx" ON "CommunicationConversation"("tenantId", "contactPhoneHash");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_integrationAccountId_idx" ON "CommunicationMessage"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_tenant_phoneHash_idx" ON "CommunicationMessage"("tenantId", "contactPhoneHash");
CREATE INDEX IF NOT EXISTS "CommunicationWebhookEvent_integrationAccountId_idx" ON "CommunicationWebhookEvent"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "Contact_phoneHash_idx" ON "Contact"("phoneHash");
CREATE INDEX IF NOT EXISTS "Contact_ownerSellerId_phoneHash_idx" ON "Contact"("ownerSellerId", "phoneHash");
ALTER TABLE "CommunicationConversation" ADD CONSTRAINT "CommunicationConversation_integrationAccountId_fkey" FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationMessage" ADD CONSTRAINT "CommunicationMessage_integrationAccountId_fkey" FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunicationWebhookEvent" ADD CONSTRAINT "CommunicationWebhookEvent_integrationAccountId_fkey" FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
