import {
  CommunicationChannelType,
  CommunicationDirection,
  CommunicationMessageStatus,
  CommunicationMessageType,
  CommunicationProviderType,
  Prisma,
  WhatsAppConnectionStatus,
  type PrismaClient
} from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { normalizeWhatsAppContactPhone } from "../whatsappConnection/phoneMatch.js";
import { findClientsByPhone, type ClientPhoneMatch } from "./clientPhoneIndex.js";

// WhatsApp Fase B: o que a ingestão precisa do banco, atrás de uma interface (os testes usam uma versão em
// memória). Conversa = número comercial (externalAccountId) + número do contato (externalConversationKey).

export const EVOLUTION_PROVIDER = CommunicationProviderType.evolution_whatsapp;

export type ConnectedInstance = { userId: string; account: string };

export type LinkStatus = "linked" | "unlinked" | "ambiguous";

export type ConversationRow = {
  id: string;
  clientId: string | null;
  tenantId: string | null;
  linkStatus: string | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
};

export type ConversationCreate = {
  account: string;
  contactPhone: string;
  numberOwnerUserId: string;
  clientId: string | null;
  tenantId: string | null;
  linkStatus: LinkStatus;
  linkSource: "auto" | null;
  linkedAt: Date | null;
  unlinkedExpiresAt: Date | null;
  contactName: string | null;
  contactDisplay: string | null;
};

export type ConversationUpdate = Partial<{
  clientId: string | null;
  tenantId: string | null;
  linkStatus: LinkStatus;
  linkSource: "auto" | null;
  linkedAt: Date | null;
  unlinkedExpiresAt: Date | null;
  contactName: string | null;
  numberOwnerUserId: string;
  lastMessageAt: Date;
  lastInboundAt: Date;
  lastOutboundAt: Date;
  previewSanitized: string;
}>;

export type MessageCreate = {
  conversationId: string;
  account: string;
  externalMessageId: string;
  tenantId: string | null;
  direction: CommunicationDirection;
  status: CommunicationMessageStatus;
  type: CommunicationMessageType;
  textContent: string;
  mediaMetadata: Record<string, unknown> | null;
  providerTimestamp: Date;
  metadata: Record<string, unknown>;
};

export type MessageRow = {
  id: string;
  direction: CommunicationDirection;
  type: CommunicationMessageType;
  textContent: string | null;
  metadata: Record<string, unknown>;
};

export type MessageUpdate = {
  type?: CommunicationMessageType;
  textContent?: string;
  mediaMetadata?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export interface WhatsAppMessageStore {
  findConnectedInstance(instanceName: string): Promise<ConnectedInstance | null>;
  /** Números de usuários do CRM (celular cadastrado e número conectado): conversa entre eles é ignorada. */
  internalPhones(): Promise<Set<string>>;
  matchClient(phone: string): Promise<ClientPhoneMatch>;
  findConversation(account: string, contactPhone: string): Promise<ConversationRow | null>;
  createConversation(data: ConversationCreate): Promise<ConversationRow | "conflict">;
  updateConversation(id: string, data: ConversationUpdate): Promise<void>;
  createMessage(data: MessageCreate): Promise<"created" | "duplicate">;
  findMessage(account: string, externalMessageId: string): Promise<MessageRow | null>;
  updateMessage(id: string, data: MessageUpdate): Promise<void>;
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const conversationSelect = {
  id: true,
  clientId: true,
  tenantId: true,
  linkStatus: true,
  lastMessageAt: true,
  lastInboundAt: true,
  lastOutboundAt: true
} as const;

const json = (value: Record<string, unknown> | null) => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

const INTERNAL_PHONES_TTL_MS = 60_000;

export class PrismaWhatsAppMessageStore implements WhatsAppMessageStore {
  private internalCache: { at: number; phones: Set<string> } | null = null;

  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async findConnectedInstance(instanceName: string) {
    const row = await this.db.whatsAppConnection.findUnique({
      where: { instanceName },
      select: { userId: true, status: true, connectedPhone: true }
    });
    if (!row || row.status !== WhatsAppConnectionStatus.CONNECTED || !row.connectedPhone) return null;
    return { userId: row.userId, account: row.connectedPhone };
  }

  async internalPhones() {
    if (this.internalCache && Date.now() - this.internalCache.at < INTERNAL_PHONES_TTL_MS) return this.internalCache.phones;
    const [users, connections] = await Promise.all([
      this.db.user.findMany({ where: { phone: { not: null } }, select: { phone: true } }),
      this.db.whatsAppConnection.findMany({ where: { connectedPhone: { not: null } }, select: { connectedPhone: true } })
    ]);
    const phones = new Set<string>();
    for (const value of [...users.map((row) => row.phone), ...connections.map((row) => row.connectedPhone)]) {
      const phone = normalizeWhatsAppContactPhone(value);
      if (phone) phones.add(phone);
    }
    this.internalCache = { at: Date.now(), phones };
    return phones;
  }

  matchClient(phone: string) {
    return findClientsByPhone(phone, this.db);
  }

  findConversation(account: string, contactPhone: string) {
    return this.db.communicationConversation.findUnique({
      where: { provider_externalAccountId_externalConversationKey: { provider: EVOLUTION_PROVIDER, externalAccountId: account, externalConversationKey: contactPhone } },
      select: conversationSelect
    });
  }

  async createConversation(data: ConversationCreate) {
    try {
      return await this.db.communicationConversation.create({
        data: {
          channel: CommunicationChannelType.WHATSAPP,
          provider: EVOLUTION_PROVIDER,
          externalAccountId: data.account,
          externalConversationKey: data.contactPhone,
          contactNormalized: data.contactPhone,
          contactDisplay: data.contactDisplay,
          contactName: data.contactName,
          numberOwnerUserId: data.numberOwnerUserId,
          clientId: data.clientId,
          tenantId: data.tenantId,
          linkStatus: data.linkStatus,
          linkSource: data.linkSource,
          linkedAt: data.linkedAt,
          unlinkedExpiresAt: data.unlinkedExpiresAt,
          unreadCount: 0
        },
        select: conversationSelect
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "conflict" as const;
      throw error;
    }
  }

  async updateConversation(id: string, data: ConversationUpdate) {
    await this.db.communicationConversation.update({ where: { id }, data });
  }

  async createMessage(data: MessageCreate) {
    try {
      await this.db.communicationMessage.create({
        data: {
          conversationId: data.conversationId,
          channel: CommunicationChannelType.WHATSAPP,
          provider: EVOLUTION_PROVIDER,
          externalMessageId: data.externalMessageId,
          externalAccountId: data.account,
          tenantId: data.tenantId,
          direction: data.direction,
          type: data.type,
          textContent: data.textContent,
          mediaMetadata: json(data.mediaMetadata),
          providerTimestamp: data.providerTimestamp,
          status: data.status,
          metadata: json(data.metadata)
        }
      });
      return "created" as const;
    } catch (error) {
      if (isUniqueViolation(error)) return "duplicate" as const;
      throw error;
    }
  }

  async findMessage(account: string, externalMessageId: string) {
    const row = await this.db.communicationMessage.findUnique({
      where: { provider_externalAccountId_externalMessageId: { provider: EVOLUTION_PROVIDER, externalAccountId: account, externalMessageId } },
      select: { id: true, direction: true, type: true, textContent: true, metadata: true }
    });
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
    return { ...row, metadata };
  }

  async updateMessage(id: string, data: MessageUpdate) {
    await this.db.communicationMessage.update({
      where: { id },
      data: {
        ...(data.type ? { type: data.type } : {}),
        ...(data.textContent !== undefined ? { textContent: data.textContent } : {}),
        ...(data.mediaMetadata !== undefined ? { mediaMetadata: json(data.mediaMetadata) } : {}),
        metadata: json(data.metadata)
      }
    });
  }
}
