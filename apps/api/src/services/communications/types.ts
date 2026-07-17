import type { CommunicationChannelType, CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType, CommunicationProviderType } from "@prisma/client";

export type ParsedCommunicationEventType = "MESSAGE_RECEIVED" | "MESSAGE_STATUS_SENT" | "MESSAGE_STATUS_DELIVERED" | "MESSAGE_STATUS_READ" | "MESSAGE_STATUS_FAILED" | "CONTACT_UPDATED" | "UNKNOWN";

export interface ParsedExternalContact { rawValue: string; normalizedValue: string | null; displayValue?: string; contactName?: string; valid: boolean; warnings: string[]; }
export interface ProviderMediaMetadata { externalMediaId: string; mimeType?: string; filename?: string; sizeBytes?: number; }
export interface ProviderMediaDownload { metadata: ProviderMediaMetadata; data: Buffer; }
export interface ProviderSendTextInput { to: string; text: string; }
export interface ProviderSendTemplateInput { to: string; templateName: string; languageCode: string; variables?: string[]; }
export interface ProviderSendResult { externalMessageId: string; status: CommunicationMessageStatus; }
export interface ParsedCommunicationEvent {
  providerType: CommunicationProviderType; channelType: CommunicationChannelType; externalEventKey: string; eventType: ParsedCommunicationEventType;
  externalMessageId?: string; externalConversationKey?: string; externalAccountId?: string; externalContact?: string; contactName?: string;
  direction?: CommunicationDirection; messageType?: CommunicationMessageType; textContent?: string; providerTimestamp?: Date; status?: CommunicationMessageStatus;
  media?: ProviderMediaMetadata; replyToExternalMessageId?: string; errorCode?: string; errorMessageSanitized?: string; metadata?: Record<string, unknown>;
}
export interface CommunicationProvider {
  readonly providerType: CommunicationProviderType; readonly channelType: CommunicationChannelType;
  verifyWebhookChallenge(input: unknown): { valid: boolean; challenge?: string };
  verifyWebhookSignature(input: { rawBody: Buffer; signatureHeader?: string }): boolean;
  parseWebhook(input: { rawBody: Buffer; parsedBody: unknown; headers: Record<string, string | string[] | undefined> }): ParsedCommunicationEvent[];
  normalizeExternalContact(input: unknown): ParsedExternalContact;
  getMediaMetadata?(externalMediaId: string): Promise<ProviderMediaMetadata>;
  downloadMedia?(externalMediaId: string): Promise<ProviderMediaDownload>;
  sendText?(input: ProviderSendTextInput): Promise<ProviderSendResult>;
  sendTemplate?(input: ProviderSendTemplateInput): Promise<ProviderSendResult>;
}
