import { createHash, randomUUID } from "node:crypto";
import type { CommunicationMessageStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma.js";
import { env } from "../../config/env.js";
import { logApiEvent } from "../../utils/logger.js";
import { MetaWhatsAppCloudProvider } from "./metaWhatsAppCloudProvider.js";
import { CommunicationContactNormalizationService } from "./phoneNormalizationService.js";
import type { ParsedCommunicationEvent } from "./types.js";

const provider = new MetaWhatsAppCloudProvider(); const normalizer = new CommunicationContactNormalizationService();
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const preview = (v?: string) => v ? v.replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
const statusRank: Record<string, number> = { QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 0, RECEIVED: 5 };
const validateConfig = () => { const missing: string[] = []; if (!env.whatsappWebhookVerifyToken) missing.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN"); if (!env.whatsappAppSecret) missing.push("WHATSAPP_APP_SECRET"); return missing; };
const configured = () => validateConfig().length === 0 && env.whatsappProvider === "meta";

export class CommunicationIntegrationService {
  getProvider() { return provider; }
  verifyMetaWhatsappChallenge(query: unknown) { return provider.verifyWebhookChallenge(query); }
  async processMetaWhatsappWebhook(input: { rawBody: Buffer; headers: Record<string, string|string[]|undefined>; parsedBody: unknown }) {
    if (!env.communicationsEnabled || !env.whatsappIntegrationEnabled) return { accepted: true, disabled: true, processed: 0 };
    const missing = validateConfig(); if (missing.length) return { accepted: false, status: 503, error: "integration_not_configured" };
    if (!provider.verifyWebhookSignature({ rawBody: input.rawBody, signatureHeader: Array.isArray(input.headers["x-hub-signature-256"]) ? input.headers["x-hub-signature-256"]?.[0] : input.headers["x-hub-signature-256"] })) { logApiEvent("WARN", "[communications/meta-whatsapp] signature-invalid", { channelType: "WHATSAPP", providerType: "META_WHATSAPP_CLOUD" }); return { accepted: false, status: 401, error: "invalid_signature" }; }
    const events = provider.parseWebhook(input); let processed = 0, duplicates = 0;
    for (const event of events) { const r = await this.processEvent(event, input.rawBody); processed += r.processed ? 1 : 0; duplicates += r.duplicate ? 1 : 0; }
    return { accepted: true, processed, duplicates };
  }
  private async processEvent(event: ParsedCommunicationEvent, rawBody: Buffer) {
    const started = Date.now(); const contactHash = event.externalContact ? hash(event.externalContact) : undefined;
    try {
      const created = await prisma.communicationWebhookEvent.create({ data: { channelType: event.channelType, providerType: event.providerType, externalEventKey: event.externalEventKey, eventType: event.eventType, payloadHash: hash(rawBody.toString("utf8")), processingStatus: "PROCESSING" } }).catch(async (e) => {
        if ((e as any)?.code === "P2002") { await prisma.communicationWebhookEvent.update({ where: { providerType_externalEventKey: { providerType: event.providerType, externalEventKey: event.externalEventKey } }, data: { attemptCount: { increment: 1 }, processingStatus: "DUPLICATE" } }); return null; }
        throw e;
      });
      if (!created) { logApiEvent("INFO", "[communications/meta-whatsapp] event-duplicate", { eventType: event.eventType, contactHash }); return { duplicate: true, processed: false }; }
      await this.applyEvent(event);
      await prisma.communicationWebhookEvent.update({ where: { id: created.id }, data: { processingStatus: "PROCESSED", processedAt: new Date() } });
      logApiEvent("INFO", "[communications/meta-whatsapp] event-received", { eventType: event.eventType, messageType: event.messageType, direction: event.direction, elapsedMs: Date.now() - started, contactHash });
      return { duplicate: false, processed: true };
    } catch (error) { logApiEvent("ERROR", "[communications/meta-whatsapp] processing-failed", { eventType: event.eventType, contactHash, error: error instanceof Error ? error.message : String(error) }); return { duplicate: false, processed: false }; }
  }
  private async applyEvent(event: ParsedCommunicationEvent) { if (event.eventType === "MESSAGE_RECEIVED") return this.persistInbound(event); if (event.status && event.externalMessageId) return this.updateStatus(event); }
  private async linkClient(normalizedContact: string | null) {
    if (!normalizedContact) return { clientId: null, sellerId: null, reason: "invalid_contact" };
    const contacts = await prisma.contact.findMany({ where: { phone: { not: "" } }, select: { clientId: true, ownerSellerId: true, phone: true, client: { select: { id: true, isArchived: true, ownerSellerId: true } } }, take: 5000 });
    const matches = contacts.filter(c => normalizer.normalizePhone({ rawValue: c.phone, channelType: "WHATSAPP" }).normalizedValue === normalizedContact && c.clientId);
    const active = matches.filter(m => !m.client?.isArchived); const clientIds = [...new Set(active.map(m => m.clientId!))];
    if (!matches.length) return { clientId: null, sellerId: null, reason: "no_match" }; if (!active.length) return { clientId: null, sellerId: null, reason: "inactive_client" }; if (clientIds.length > 1) return { clientId: null, sellerId: null, reason: "ambiguous_match" };
    const m = active[0]; return { clientId: m.clientId, sellerId: m.client?.ownerSellerId || m.ownerSellerId, reason: "linked_exactly" };
  }
  private async persistInbound(event: ParsedCommunicationEvent) {
    if (!event.externalMessageId || !event.externalConversationKey || !event.externalContact) return;
    const normalized = normalizer.normalizePhone({ rawValue: event.externalContact, channelType: "WHATSAPP" }); const link = await this.linkClient(normalized.normalizedValue);
    const conversation = await prisma.communicationConversation.upsert({ where: { providerType_externalConversationKey: { providerType: event.providerType, externalConversationKey: event.externalConversationKey } }, create: { channelType: event.channelType, providerType: event.providerType, externalConversationKey: event.externalConversationKey, externalAccountId: event.externalAccountId, normalizedContact: normalized.normalizedValue || hash(event.externalContact), displayContact: provider.normalizeExternalContact(event.externalContact).displayValue, contactName: event.contactName, clientId: link.clientId, assignedSellerId: link.sellerId, lastMessageAt: event.providerTimestamp, lastInboundAt: event.providerTimestamp, unreadCount: 0, lastMessagePreview: preview(event.textContent) }, update: { lastMessageAt: event.providerTimestamp, lastInboundAt: event.providerTimestamp, contactName: event.contactName, ...(link.clientId ? { clientId: link.clientId, assignedSellerId: link.sellerId } : {}), lastMessagePreview: preview(event.textContent) } });
    const msg = await prisma.communicationMessage.create({ data: { conversationId: conversation.id, channelType: event.channelType, providerType: event.providerType, externalMessageId: event.externalMessageId, direction: "INBOUND", messageType: event.messageType || "UNKNOWN", textContent: event.textContent, mediaExternalId: event.media?.externalMediaId, mediaMimeType: event.media?.mimeType, mediaFilename: event.media?.filename, mediaSizeBytes: event.media?.sizeBytes, providerTimestamp: event.providerTimestamp || new Date(), replyToExternalMessageId: event.replyToExternalMessageId, status: "RECEIVED", metadata: { linkReason: link.reason, mediaOnly: !event.textContent && !!event.media } as Prisma.InputJsonValue } }).catch(e => ((e as any)?.code === "P2002" ? null : Promise.reject(e)));
    if (msg) { await prisma.communicationConversation.update({ where: { id: conversation.id }, data: { unreadCount: { increment: 1 } } }); if (link.clientId && link.sellerId) await prisma.timelineEvent.create({ data: { type: "status", description: event.messageType === "TEXT" ? "Nova mensagem de texto recebida pelo WhatsApp oficial." : "Nova mensagem recebida pelo WhatsApp oficial.", clientId: link.clientId, ownerSellerId: link.sellerId } }); logApiEvent("INFO", link.clientId ? "[communications/meta-whatsapp] client-linked" : "[communications/meta-whatsapp] client-link-ambiguous", { linkedClient: !!link.clientId, linkedSeller: !!link.sellerId, contactHash: event.externalContact ? hash(event.externalContact) : undefined }); }
  }
  private async updateStatus(event: ParsedCommunicationEvent) { const existing = await prisma.communicationMessage.findUnique({ where: { providerType_externalMessageId: { providerType: event.providerType, externalMessageId: event.externalMessageId! } } }); if (!existing || existing.direction === "INBOUND") return; const next = event.status as CommunicationMessageStatus; if (next !== "FAILED" && statusRank[existing.status] > statusRank[next]) return; if (existing.status === "READ" && next === "FAILED") return; await prisma.communicationMessage.update({ where: { id: existing.id }, data: { status: next, errorCode: event.errorCode, errorMessageSanitized: event.errorMessageSanitized } }); }
  async getIntegrationStatus() { const [lastWebhook, lastInbound, lastStatus, lastError] = await Promise.all([prisma.communicationWebhookEvent.findFirst({ where: { providerType: "META_WHATSAPP_CLOUD" }, orderBy: { createdAt: "desc" } }), prisma.communicationMessage.findFirst({ where: { providerType: "META_WHATSAPP_CLOUD", direction: "INBOUND" }, orderBy: { providerTimestamp: "desc" } }), prisma.communicationWebhookEvent.findFirst({ where: { providerType: "META_WHATSAPP_CLOUD", eventType: { startsWith: "MESSAGE_STATUS" } }, orderBy: { createdAt: "desc" } }), prisma.communicationWebhookEvent.findFirst({ where: { providerType: "META_WHATSAPP_CLOUD", processingStatus: "FAILED" }, orderBy: { updatedAt: "desc" } })]); const warnings = validateConfig().map(k => `${k}_missing`); return { enabled: env.communicationsEnabled && env.whatsappIntegrationEnabled, channel: "WHATSAPP", provider: "META_WHATSAPP_CLOUD", configured: configured(), webhookReady: configured() && env.communicationsEnabled && env.whatsappIntegrationEnabled, databaseReady: true, lastWebhookAt: lastWebhook?.createdAt ?? null, lastInboundMessageAt: lastInbound?.providerTimestamp ?? null, lastStatusUpdateAt: lastStatus?.createdAt ?? null, lastErrorAt: lastError?.updatedAt ?? null, warnings }; }
  async getConversationById(id: string) { return prisma.communicationConversation.findUnique({ where: { id } }); } async listConversations() { return prisma.communicationConversation.findMany({ take: 50, orderBy: { lastMessageAt: "desc" } }); } async listMessages(conversationId: string) { return prisma.communicationMessage.findMany({ where: { conversationId }, take: 100, orderBy: { providerTimestamp: "desc" } }); }
}
export const communicationIntegrationService = new CommunicationIntegrationService();
export const validateCommunicationsRuntimeConfigOnStartup = () => { if (env.communicationsEnabled && env.whatsappIntegrationEnabled && validateConfig().length) throw new Error("WhatsApp oficial habilitado sem configuração obrigatória."); };
