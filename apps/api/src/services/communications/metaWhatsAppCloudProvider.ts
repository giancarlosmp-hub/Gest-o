import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { CommunicationContactNormalizationService } from "./phoneNormalizationService.js";
import type { CommunicationProvider, ParsedCommunicationEvent, ParsedExternalContact } from "./types.js";

const sanitizeText = (value: unknown, max = 1000) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const getString = (value: unknown) => typeof value === "string" ? value : undefined;
const timestampDate = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(); };

export class MetaWhatsAppCloudProvider implements CommunicationProvider {
  readonly providerType = "META_WHATSAPP_CLOUD" as const;
  readonly channelType = "WHATSAPP" as const;
  constructor(private normalizer = new CommunicationContactNormalizationService()) {}
  verifyWebhookChallenge(input: any) { const valid = input?.["hub.mode"] === "subscribe" && input?.["hub.verify_token"] === env.whatsappWebhookVerifyToken && !!env.whatsappWebhookVerifyToken; return { valid, challenge: valid ? String(input?.["hub.challenge"] ?? "") : undefined }; }
  verifyWebhookSignature(input: { rawBody: Buffer; signatureHeader?: string }) {
    if (!env.whatsappAppSecret || !input.signatureHeader?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", env.whatsappAppSecret).update(input.rawBody).digest("hex")}`;
    const a = Buffer.from(expected); const b = Buffer.from(input.signatureHeader);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  normalizeExternalContact(input: unknown): ParsedExternalContact { const result = this.normalizer.normalizePhone({ rawValue: String(input ?? ""), defaultCountryCode: "55", channelType: "WHATSAPP" }); return { rawValue: result.rawValue, normalizedValue: result.normalizedValue, displayValue: result.normalizedValue ? `${result.normalizedValue.slice(0,5)}***${result.normalizedValue.slice(-2)}` : undefined, valid: result.valid, warnings: result.warnings }; }
  parseWebhook({ parsedBody }: { rawBody: Buffer; parsedBody: any; headers: Record<string, string | string[] | undefined> }): ParsedCommunicationEvent[] {
    const events: ParsedCommunicationEvent[] = [];
    const entries = Array.isArray(parsedBody?.entry) ? parsedBody.entry : [];
    for (const entry of entries) for (const change of (Array.isArray(entry?.changes) ? entry.changes : [])) {
      const value = change?.value ?? {}; const accountId = getString(value?.metadata?.phone_number_id) || getString(entry?.id);
      const contactsByWaId = new Map((Array.isArray(value.contacts) ? value.contacts : []).map((c: any) => [String(c.wa_id ?? ""), c]));
      for (const msg of (Array.isArray(value.messages) ? value.messages : [])) {
        const from = getString(msg.from) || ""; const type = String(msg.type || "unknown").toUpperCase(); const contact: any = contactsByWaId.get(from);
        const externalMessageId = getString(msg.id) || `${entry.id}:${msg.timestamp}:${from}`;
        const media = ["image","document","audio","video","sticker"].includes(msg.type) ? msg[msg.type] : undefined;
        events.push({ providerType: this.providerType, channelType: this.channelType, externalEventKey: `message:${externalMessageId}`, eventType: "MESSAGE_RECEIVED", externalMessageId, externalConversationKey: from, externalAccountId: accountId, externalContact: from, contactName: sanitizeText(contact?.profile?.name, 120) || undefined, direction: "INBOUND", messageType: ["TEXT","IMAGE","DOCUMENT","AUDIO","VIDEO","STICKER"].includes(type) ? type as any : type === "INTERACTIVE" ? "INTERACTIVE" : "UNKNOWN", textContent: msg.type === "text" ? sanitizeText(msg.text?.body, 4000) : undefined, providerTimestamp: timestampDate(msg.timestamp), status: "RECEIVED", media: media ? { externalMediaId: sanitizeText(media.id, 255), mimeType: sanitizeText(media.mime_type, 120) || undefined, filename: sanitizeText(media.filename, 255) || undefined, sizeBytes: Number.isFinite(Number(media.file_size)) ? Number(media.file_size) : undefined } : undefined, replyToExternalMessageId: getString(msg.context?.id), metadata: { metaType: msg.type } });
      }
      for (const st of (Array.isArray(value.statuses) ? value.statuses : [])) {
        const statusMap: any = { sent: ["MESSAGE_STATUS_SENT", "SENT"], delivered: ["MESSAGE_STATUS_DELIVERED", "DELIVERED"], read: ["MESSAGE_STATUS_READ", "READ"], failed: ["MESSAGE_STATUS_FAILED", "FAILED"] };
        const [eventType, status] = statusMap[String(st.status)] || ["UNKNOWN", "FAILED"];
        const externalMessageId = getString(st.id) || `${entry.id}:${st.timestamp}:status`;
        const err = Array.isArray(st.errors) ? st.errors[0] : undefined;
        events.push({ providerType: this.providerType, channelType: this.channelType, externalEventKey: `status:${externalMessageId}:${st.status}:${st.timestamp ?? ""}`, eventType, externalMessageId, externalConversationKey: getString(st.recipient_id), externalAccountId: accountId, externalContact: getString(st.recipient_id), providerTimestamp: timestampDate(st.timestamp), status, errorCode: err?.code ? String(err.code).slice(0,64) : undefined, errorMessageSanitized: err?.title ? sanitizeText(err.title, 255) : undefined });
      }
    }
    return events;
  }
}
