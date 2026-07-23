import { createHash } from "node:crypto";
import { CommunicationMessageStatus, CommunicationWebhookStatus, EventType, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { env } from "../../config/env.js";
import { logApiEvent } from "../../utils/logger.js";
import { MetaWhatsAppCloudProvider, sanitizeError } from "./metaWhatsAppCloudProvider.js";
import { hashContact, hashPhoneForTenant, maskContact } from "./phoneNormalization.js";
import { communicationTenantResolver, type CommunicationTenantResolver } from "./communicationTenantResolver.js";
import type { CommunicationProvider, NormalizedCommunicationEvent } from "./types.js";

const statusOrder = { RECEIVED: 0, QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: -1 } as const;
const timelineDescription = "Nova mensagem recebida pelo WhatsApp oficial.";

export class CommunicationIntegrationService {
  constructor(private readonly prisma = defaultPrisma, private readonly providers: CommunicationProvider[] = [new MetaWhatsAppCloudProvider()], private readonly tenantResolver: CommunicationTenantResolver = communicationTenantResolver) {}
  getProvider() { return this.providers[0]; }
  ensureEnabled() { return env.communicationsEnabled && env.whatsappIntegrationEnabled; }
  validateEnabledConfig() {
    if (!this.ensureEnabled()) return { ok: true as const };
    const required = { verifyToken: env.whatsappWebhookVerifyToken, appSecret: env.whatsappAppSecret };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
    return missing.length ? { ok: false as const, missing } : { ok: true as const };
  }

  async processMetaWhatsAppWebhook(rawBody: Buffer, signature: string | undefined, requestId?: string) {
    const started = Date.now(); const config = this.validateEnabledConfig(); const provider = this.getProvider();
    if (!this.ensureEnabled()) return { status: "disabled", processed: 0, duplicates: 0 };
    if (!config.ok) return { status: "misconfigured", processed: 0, duplicates: 0 };
    if (!provider.verifySignature(rawBody, signature, env.whatsappAppSecret)) return { status: "invalid_signature", processed: 0, duplicates: 0 };
    let payload: unknown; try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return { status: "invalid_json", processed: 0, duplicates: 0 }; }
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const events = provider.parseEvents(payload); let processed = 0, duplicates = 0, unknownAccounts = 0, disabledAccounts = 0;
    for (const event of events) {
      const resolution = await this.tenantResolver.resolve({ provider: provider.provider, channel: provider.channel, externalAccountId: event.externalAccountId });
      if (resolution.status === "unknown") { unknownAccounts++; continue; }
      if (resolution.status === "disabled") { disabledAccounts++; continue; }
      if (resolution.status !== "active") { unknownAccounts++; continue; }
      const trustedEvent = { ...event, tenantId: resolution.tenantId, integrationAccountId: resolution.integrationAccountId };
      const result = await this.persistEvent(provider, trustedEvent, payloadHash);
      if (result === "duplicate") duplicates++; else processed++;
    }
    logApiEvent("INFO", "[communications] webhook processed", { requestId, provider: provider.provider, eventCount: events.length, processed, duplicates, unknownAccounts, disabledAccounts, durationMs: Date.now() - started });
    return { status: unknownAccounts > 0 && processed === 0 ? "unknown_account" : disabledAccounts > 0 && processed === 0 ? "disabled_account" : "ok", processed, duplicates, unknownAccounts, disabledAccounts };
  }

  private async persistEvent(provider: CommunicationProvider, event: NormalizedCommunicationEvent, payloadHash: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const webhook = await tx.communicationWebhookEvent.create({ data: { channel: provider.channel, provider: provider.provider, externalEventKey: event.externalEventKey, externalAccountId: event.externalAccountId, tenantId: event.tenantId, integrationAccountId: (event as NormalizedCommunicationEvent & { integrationAccountId?: string }).integrationAccountId, eventType: event.eventType, payloadHash, status: CommunicationWebhookStatus.PROCESSING, attempts: 1 } }).catch((e) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
          throw e;
        });
        if (!webhook) return "duplicate" as const;
        await this.applyNormalizedEvent(tx, provider, event);
        await tx.communicationWebhookEvent.update({ where: { id: webhook.id }, data: { status: CommunicationWebhookStatus.PROCESSED, processedAt: new Date() } });
        return "processed" as const;
      }, { timeout: 5000 });
    } catch (error) {
      logApiEvent("WARN", "[communications] event failed", { provider: provider.provider, externalEventKeyHash: hashContact(event.externalEventKey), error: sanitizeError(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  }

  private async applyNormalizedEvent(tx: Prisma.TransactionClient, provider: CommunicationProvider, event: NormalizedCommunicationEvent) {
    if (event.eventType === "status" && event.externalMessageId && event.messageStatus) {
      const current = await tx.communicationMessage.findUnique({ where: { provider_externalAccountId_externalMessageId: { provider: provider.provider, externalAccountId: event.externalAccountId, externalMessageId: event.externalMessageId } }, select: { id: true, status: true } });
      if (current && shouldAdvance(current.status, event.messageStatus)) await tx.communicationMessage.update({ where: { id: current.id }, data: { status: event.messageStatus, errorSanitized: event.sanitizedError } });
      return;
    }
    if (!event.externalMessageId) return;
    const normalizedPhone = event.contact.status === "valid" ? event.contact.normalized : undefined;
    const contactPhoneHash = normalizedPhone && event.tenantId ? hashPhoneForTenant(event.tenantId, normalizedPhone) : null;
    const integrationAccountId = (event as NormalizedCommunicationEvent & { integrationAccountId?: string }).integrationAccountId ?? null;
    const link = await this.findSafeClientLink(tx, event.tenantId ?? null, normalizedPhone);
    const conversation = await tx.communicationConversation.upsert({ where: { provider_externalAccountId_externalConversationKey: { provider: provider.provider, externalAccountId: event.externalAccountId, externalConversationKey: event.externalConversationKey } }, update: { lastMessageAt: event.providerTimestamp ?? new Date(), lastInboundAt: new Date(), contactName: event.contactName, contactDisplay: event.contact.status === "valid" ? maskContact(event.contact.normalized) : undefined }, create: { channel: provider.channel, provider: provider.provider, externalConversationKey: event.externalConversationKey, externalAccountId: event.externalAccountId, tenantId: event.tenantId, integrationAccountId, contactPhoneHash, clientId: link.clientId, assignedSellerId: link.sellerId, contactNormalized: event.contact.status === "valid" ? event.contact.normalized : undefined, contactDisplay: event.contact.status === "valid" ? maskContact(event.contact.normalized) : undefined, contactName: event.contactName ? "redacted" : undefined, lastMessageAt: event.providerTimestamp ?? new Date(), lastInboundAt: event.providerTimestamp ?? new Date(), unreadCount: 0, previewSanitized: event.textContent ? "Mensagem de texto recebida" : "Mensagem recebida" } });
    const msg = await tx.communicationMessage.create({ data: { conversationId: conversation.id, channel: provider.channel, provider: provider.provider, externalMessageId: event.externalMessageId, externalAccountId: event.externalAccountId, tenantId: event.tenantId, integrationAccountId, contactPhoneHash, direction: event.direction, type: event.messageType, textContent: event.textContent, mediaMetadata: event.sanitizedMediaMetadata as Prisma.InputJsonValue ?? Prisma.JsonNull, providerTimestamp: event.providerTimestamp, replyToExternalMessageId: event.replyToExternalMessageId, status: CommunicationMessageStatus.RECEIVED, metadata: { linkReason: link.reason, ...(event.sanitizedMetadata ?? {}) } as Prisma.InputJsonValue } }).catch((e) => { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null; throw e; });
    if (!msg) return;
    await tx.communicationConversation.update({ where: { id: conversation.id }, data: { unreadCount: { increment: 1 }, lastMessageAt: event.providerTimestamp ?? new Date(), lastInboundAt: event.providerTimestamp ?? new Date(), previewSanitized: event.textContent ? "Mensagem de texto recebida" : "Mensagem recebida" } });
    if (link.clientId && link.sellerId) await tx.timelineEvent.create({ data: { type: EventType.comentario, description: timelineDescription, clientId: link.clientId, ownerSellerId: link.sellerId } });
  }

  async findSafeClientLink(tx: Prisma.TransactionClient, tenantId: string | null, phone?: string) {
    if (!phone || !tenantId) return { reason: "invalid_contact" as const, clientId: null, sellerId: null };
    const phoneHash = hashPhoneForTenant(tenantId, phone);
    const contacts = await tx.contact.findMany({ where: { phoneHash, client: { isArchived: false } }, select: { clientId: true, ownerSellerId: true, client: { select: { id: true, ownerSellerId: true, isArchived: true, code: true } } }, take: 3 });
    const active = contacts.filter((c) => c.client && !c.client.isArchived);
    const ids = new Set(active.map((c) => c.clientId).filter(Boolean));
    if (ids.size === 0) return { reason: "no_match" as const, clientId: null, sellerId: null };
    if (ids.size > 1) return { reason: "ambiguous_match" as const, clientId: null, sellerId: null };
    const only = active[0]; return { reason: "linked_exactly" as const, clientId: only.clientId, sellerId: only.client?.ownerSellerId ?? only.ownerSellerId };
  }

  async getStatus() { return { enabled: this.ensureEnabled(), provider: "meta", channel: "WHATSAPP", apiVersion: env.whatsappApiVersion, configured: { verifyToken: Boolean(env.whatsappWebhookVerifyToken), appSecret: Boolean(env.whatsappAppSecret), accessToken: Boolean(env.whatsappAccessToken), phoneNumberIdConfigured: Boolean(env.whatsappPhoneNumberId), businessAccountIdConfigured: Boolean(env.whatsappBusinessAccountId) }, retentionDays: env.communicationsWebhookRetentionDays }; }
}
function shouldAdvance(current: CommunicationMessageStatus, next: CommunicationMessageStatus) { if (next === CommunicationMessageStatus.FAILED && current === CommunicationMessageStatus.READ) return false; return statusOrder[next] > statusOrder[current]; }
export const communicationIntegrationService = new CommunicationIntegrationService();
