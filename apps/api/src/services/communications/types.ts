import type { CommunicationChannelType, CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType, CommunicationProviderType } from "@prisma/client";

export type NormalizedContactResult =
  | { status: "valid"; normalized: string; display: string; countryCode?: string; contactHash: string }
  | { status: "invalid" | "ambiguous"; reason: string; contactHash?: string };

export type NormalizedCommunicationEvent = {
  externalEventKey: string;
  eventType: "message" | "status" | "unknown";
  externalConversationKey: string;
  externalAccountId: string;
  tenantId?: string;
  externalMessageId?: string;
  direction: CommunicationDirection;
  messageType: CommunicationMessageType;
  textContent?: string;
  providerTimestamp?: Date;
  contact: NormalizedContactResult;
  contactName?: string;
  replyToExternalMessageId?: string;
  messageStatus?: CommunicationMessageStatus;
  sanitizedMediaMetadata?: Record<string, unknown>;
  sanitizedMetadata?: Record<string, unknown>;
  sanitizedError?: string;
};

export interface CommunicationProvider {
  channel: CommunicationChannelType;
  provider: CommunicationProviderType;
  verifyChallenge(query: Record<string, unknown>, expectedToken: string): { ok: true; challenge: string } | { ok: false; status: 400 | 403; reason: string };
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean;
  parseEvents(payload: unknown): NormalizedCommunicationEvent[];
  normalizeExternalContact(input: string | undefined): NormalizedContactResult;
}
