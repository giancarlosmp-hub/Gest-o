-- SAFE_PRODUCTION_SCHEMA_TRANSITION
-- Additive, repeatable cutover migration. No data backfill is performed.
-- Incident recovery tables are deliberately outside Prisma ownership and MUST remain untouched.

DO $$ BEGIN CREATE TYPE "CommunicationChannelType" AS ENUM ('WHATSAPP','INSTAGRAM','FACEBOOK_MESSENGER','EMAIL','SMS','RCS','TELEGRAM','WEBSITE_CHAT','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationProviderType" AS ENUM ('META_WHATSAPP_CLOUD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND','OUTBOUND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationMessageType" AS ENUM ('TEXT','IMAGE','DOCUMENT','AUDIO','VIDEO','LOCATION','CONTACT','STICKER','REACTION','INTERACTIVE','TEMPLATE','UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationMessageStatus" AS ENUM ('RECEIVED','QUEUED','SENT','DELIVERED','READ','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationConversationStatus" AS ENUM ('OPEN','PENDING','RESOLVED','ARCHIVED','BLOCKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CommunicationWebhookStatus" AS ENUM ('RECEIVED','PROCESSING','PROCESSED','FAILED','DUPLICATE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phoneHash" VARCHAR(64);
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phoneNormalized" VARCHAR(32);

CREATE TABLE IF NOT EXISTS "ClientCodeAudit" (
 "id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "partnerErp" TEXT, "oldValue" TEXT,
 "newValue" TEXT, "origin" TEXT NOT NULL, "actorUserId" TEXT, "actorEmail" TEXT,
 "requestIp" TEXT, "requestId" TEXT NOT NULL, "metadata" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommunicationIntegrationAccount" (
 "id" TEXT PRIMARY KEY, "tenantId" VARCHAR(64) NOT NULL, "provider" "CommunicationProviderType" NOT NULL,
 "channel" "CommunicationChannelType" NOT NULL, "externalAccountId" VARCHAR(128) NOT NULL,
 "displayName" VARCHAR(120), "status" VARCHAR(40) NOT NULL DEFAULT 'pending_configuration',
 "enabled" BOOLEAN NOT NULL DEFAULT true, "configurationState" VARCHAR(40) NOT NULL DEFAULT 'incomplete',
 "credentialReference" VARCHAR(160), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommunicationConversation" (
 "id" TEXT PRIMARY KEY, "channel" "CommunicationChannelType" NOT NULL, "provider" "CommunicationProviderType" NOT NULL,
 "externalConversationKey" TEXT NOT NULL, "externalAccountId" TEXT NOT NULL, "tenantId" VARCHAR(64),
 "integrationAccountId" TEXT, "contactPhoneHash" VARCHAR(64), "clientId" TEXT, "assignedSellerId" TEXT,
 "contactNormalized" VARCHAR(32), "contactDisplay" VARCHAR(64), "contactName" VARCHAR(120),
 "status" "CommunicationConversationStatus" NOT NULL DEFAULT 'OPEN', "lastMessageAt" TIMESTAMP(3),
 "lastInboundAt" TIMESTAMP(3), "lastOutboundAt" TIMESTAMP(3), "unreadCount" INTEGER NOT NULL DEFAULT 0,
 "previewSanitized" VARCHAR(240), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommunicationMessage" (
 "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "channel" "CommunicationChannelType" NOT NULL,
 "provider" "CommunicationProviderType" NOT NULL, "externalMessageId" TEXT NOT NULL, "externalAccountId" TEXT NOT NULL,
 "tenantId" VARCHAR(64), "integrationAccountId" TEXT, "contactPhoneHash" VARCHAR(64),
 "direction" "CommunicationDirection" NOT NULL, "type" "CommunicationMessageType" NOT NULL,
 "textContent" TEXT, "mediaMetadata" JSONB, "providerTimestamp" TIMESTAMP(3), "replyToExternalMessageId" TEXT,
 "status" "CommunicationMessageStatus" NOT NULL DEFAULT 'RECEIVED', "errorSanitized" VARCHAR(240), "metadata" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommunicationWebhookEvent" (
 "id" TEXT PRIMARY KEY, "channel" "CommunicationChannelType" NOT NULL, "provider" "CommunicationProviderType" NOT NULL,
 "externalEventKey" TEXT NOT NULL, "externalAccountId" TEXT NOT NULL, "tenantId" VARCHAR(64),
 "integrationAccountId" TEXT, "eventType" VARCHAR(64) NOT NULL, "payloadHash" VARCHAR(64) NOT NULL,
 "status" "CommunicationWebhookStatus" NOT NULL DEFAULT 'RECEIVED', "attempts" INTEGER NOT NULL DEFAULT 0,
 "processedAt" TIMESTAMP(3), "errorSanitized" VARCHAR(240), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Read-only duplicate diagnostics run before every unique index. Existing duplicates fail closed.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "CommunicationIntegrationAccount" GROUP BY "tenantId","provider","channel","externalAccountId" HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate CommunicationIntegrationAccount identity'; END IF;
 IF EXISTS (SELECT 1 FROM "CommunicationConversation" GROUP BY "provider","externalAccountId","externalConversationKey" HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate CommunicationConversation identity'; END IF;
 IF EXISTS (SELECT 1 FROM "CommunicationMessage" GROUP BY "provider","externalAccountId","externalMessageId" HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate CommunicationMessage identity'; END IF;
 IF EXISTS (SELECT 1 FROM "CommunicationWebhookEvent" GROUP BY "provider","externalAccountId","externalEventKey" HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate CommunicationWebhookEvent identity'; END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_tenant_provider_channel_external_key" ON "CommunicationIntegrationAccount"("tenantId","provider","channel","externalAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationConversation_provider_externalAccountId_externalConversationKey_key" ON "CommunicationConversation"("provider","externalAccountId","externalConversationKey");
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationMessage_provider_externalAccountId_externalMessageId_key" ON "CommunicationMessage"("provider","externalAccountId","externalMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationWebhookEvent_provider_externalAccountId_externalEventKey_key" ON "CommunicationWebhookEvent"("provider","externalAccountId","externalEventKey");

CREATE INDEX IF NOT EXISTS "ClientCodeAudit_clientId_createdAt_idx" ON "ClientCodeAudit"("clientId","createdAt");
CREATE INDEX IF NOT EXISTS "ClientCodeAudit_requestId_idx" ON "ClientCodeAudit"("requestId");
CREATE INDEX IF NOT EXISTS "ClientCodeAudit_origin_createdAt_idx" ON "ClientCodeAudit"("origin","createdAt");
CREATE INDEX IF NOT EXISTS "Contact_phoneHash_idx" ON "Contact"("phoneHash");
CREATE INDEX IF NOT EXISTS "Contact_ownerSellerId_phoneHash_idx" ON "Contact"("ownerSellerId","phoneHash");
CREATE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_provider_channel_external_idx" ON "CommunicationIntegrationAccount"("provider","channel","externalAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationIntegrationAccount_tenant_enabled_idx" ON "CommunicationIntegrationAccount"("tenantId","enabled");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_integrationAccountId_idx" ON "CommunicationConversation"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_tenant_phoneHash_idx" ON "CommunicationConversation"("tenantId","contactPhoneHash");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_tenantId_idx" ON "CommunicationConversation"("tenantId");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_clientId_idx" ON "CommunicationConversation"("clientId");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_assignedSellerId_idx" ON "CommunicationConversation"("assignedSellerId");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_contactNormalized_idx" ON "CommunicationConversation"("contactNormalized");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_status_idx" ON "CommunicationConversation"("status");
CREATE INDEX IF NOT EXISTS "CommunicationConversation_lastMessageAt_idx" ON "CommunicationConversation"("lastMessageAt");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_integrationAccountId_idx" ON "CommunicationMessage"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_tenant_phoneHash_idx" ON "CommunicationMessage"("tenantId","contactPhoneHash");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_conversationId_idx" ON "CommunicationMessage"("conversationId");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_tenantId_idx" ON "CommunicationMessage"("tenantId");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_providerTimestamp_idx" ON "CommunicationMessage"("providerTimestamp");
CREATE INDEX IF NOT EXISTS "CommunicationMessage_status_idx" ON "CommunicationMessage"("status");
CREATE INDEX IF NOT EXISTS "CommunicationWebhookEvent_integrationAccountId_idx" ON "CommunicationWebhookEvent"("integrationAccountId");
CREATE INDEX IF NOT EXISTS "CommunicationWebhookEvent_tenantId_idx" ON "CommunicationWebhookEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "CommunicationWebhookEvent_status_createdAt_idx" ON "CommunicationWebhookEvent"("status","createdAt");
CREATE INDEX IF NOT EXISTS "CommunicationWebhookEvent_payloadHash_idx" ON "CommunicationWebhookEvent"("payloadHash");

-- Add foreign keys only when absent. NOT VALID avoids a full validation scan/long lock; VALIDATE is a post-cutover task.
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT * FROM (VALUES
 ('ClientCodeAudit','ClientCodeAudit_clientId_fkey','FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
 ('CommunicationConversation','CommunicationConversation_clientId_fkey','FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
 ('CommunicationConversation','CommunicationConversation_assignedSellerId_fkey','FOREIGN KEY ("assignedSellerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
 ('CommunicationConversation','CommunicationConversation_integrationAccountId_fkey','FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
 ('CommunicationMessage','CommunicationMessage_conversationId_fkey','FOREIGN KEY ("conversationId") REFERENCES "CommunicationConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
 ('CommunicationMessage','CommunicationMessage_integrationAccountId_fkey','FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
 ('CommunicationWebhookEvent','CommunicationWebhookEvent_integrationAccountId_fkey','FOREIGN KEY ("integrationAccountId") REFERENCES "CommunicationIntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
 ('AgendaEvent','AgendaEvent_clientId_fkey','FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE')
 ) AS v(tbl,con,definition)
 LOOP
  IF to_regclass(format('public.%I',x.tbl)) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=x.con AND conrelid=to_regclass(format('public.%I',x.tbl))) THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID',x.tbl,x.con,x.definition);
  END IF;
 END LOOP;
END $$;
