import { createHmac, timingSafeEqual } from "node:crypto";
import { CommunicationChannelType, CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType, CommunicationProviderType } from "@prisma/client";
import type { CommunicationProvider, NormalizedCommunicationEvent } from "./types.js";
import { normalizeBrazilianPhone } from "./phoneNormalization.js";

const messageTypeMap = new Set(Object.values(CommunicationMessageType));
const statusRank: Record<string, CommunicationMessageStatus> = { sent: CommunicationMessageStatus.SENT, delivered: CommunicationMessageStatus.DELIVERED, read: CommunicationMessageStatus.READ, failed: CommunicationMessageStatus.FAILED };

export class MetaWhatsAppCloudProvider implements CommunicationProvider {
  channel = CommunicationChannelType.WHATSAPP;
  provider = CommunicationProviderType.META_WHATSAPP_CLOUD;

  verifyChallenge(query: Record<string, unknown>, expectedToken: string) {
    if (query["hub.mode"] !== "subscribe" || typeof query["hub.challenge"] !== "string") return { ok: false as const, status: 400 as const, reason: "invalid_challenge" };
    if (!expectedToken || query["hub.verify_token"] !== expectedToken) return { ok: false as const, status: 403 as const, reason: "invalid_token" };
    return { ok: true as const, challenge: query["hub.challenge"] };
  }

  verifySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string) {
    if (!signatureHeader || !signatureHeader.startsWith("sha256=") || signatureHeader.length !== 71 || !/^[a-f0-9]{64}$/i.test(signatureHeader.slice(7))) return false;
    const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"), "hex");
    const received = Buffer.from(signatureHeader.slice(7), "hex");
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  normalizeExternalContact(input: string | undefined) { return normalizeBrazilianPhone(input); }

  parseEvents(payload: any): NormalizedCommunicationEvent[] {
    const out: NormalizedCommunicationEvent[] = [];
    for (const entry of payload?.entry ?? []) for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const account = typeof value?.metadata?.phone_number_id === "string" ? value.metadata.phone_number_id : undefined;
      if (!account) continue;
      const contactsByWaId = new Map((value?.contacts ?? []).map((c: any) => [c.wa_id, c]));
      for (const msg of value?.messages ?? []) {
        const rawType = String(msg.type ?? "unknown").toUpperCase();
        const messageType = messageTypeMap.has(rawType as CommunicationMessageType) ? rawType as CommunicationMessageType : CommunicationMessageType.UNKNOWN;
        const contact = contactsByWaId.get(msg.from) as any;
        out.push({
          externalEventKey: `message:${msg.id}`,
          eventType: "message",
          externalConversationKey: String(msg.from), externalAccountId: account,
          externalMessageId: String(msg.id), direction: CommunicationDirection.INBOUND, messageType,
          textContent: typeof msg?.text?.body === "string" ? msg.text.body.slice(0, 4000) : undefined,
          providerTimestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : undefined,
          contact: this.normalizeExternalContact(String(msg.from ?? contact?.wa_id ?? "")),
          contactName: typeof contact?.profile?.name === "string" ? contact.profile.name.slice(0, 120) : undefined,
          replyToExternalMessageId: typeof msg?.context?.id === "string" ? msg.context.id : undefined,
          sanitizedMediaMetadata: sanitizeMedia(msg), sanitizedMetadata: { metaChangeField: change?.field ?? "messages" },
        });
      }
      for (const st of value?.statuses ?? []) out.push({
        externalEventKey: `status:${st.id}:${st.status}`,
        eventType: "status", externalConversationKey: String(st.recipient_id ?? st.id), externalAccountId: account,
        externalMessageId: String(st.id), direction: CommunicationDirection.OUTBOUND, messageType: CommunicationMessageType.UNKNOWN,
        contact: this.normalizeExternalContact(String(st.recipient_id ?? "")), messageStatus: statusRank[String(st.status)] ?? CommunicationMessageStatus.FAILED,
        providerTimestamp: st.timestamp ? new Date(Number(st.timestamp) * 1000) : undefined, sanitizedError: sanitizeError(st?.errors?.[0]?.title),
      });
    }
    return out;
  }
}
function sanitizeMedia(msg: any) { const media = msg?.[msg?.type]; if (!media || !["image","document","audio","video","sticker"].includes(msg.type)) return undefined; return { providerMediaId: String(media.id ?? "").slice(0,80), mimeType: String(media.mime_type ?? "").slice(0,80), sha256: String(media.sha256 ?? "").slice(0,80), filename: media.filename ? "redacted" : undefined }; }
export function sanitizeError(value: unknown) { return typeof value === "string" ? value.replace(/[+\d][\d\s().-]{6,}/g, "[redacted]").slice(0, 240) : undefined; }
