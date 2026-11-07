import type { ClientPhoneMatch } from "./clientPhoneIndex.js";
import type {
  ConnectedInstance,
  ConversationCreate,
  ConversationRow,
  ConversationUpdate,
  MessageCreate,
  MessageRow,
  MessageUpdate,
  WhatsAppMessageStore
} from "./whatsappMessageStore.js";

// Apoio dos testes da Fase B do WhatsApp (não é carregado pela aplicação): armazenamento em memória com a
// mesma unicidade do banco (conversa por número comercial + contato; mensagem por número comercial + id).
// Só dados fictícios.

type StoredConversation = ConversationRow & ConversationCreate & Record<string, unknown>;
type StoredMessage = MessageCreate & { id: string; mediaMetadata: Record<string, unknown> | null };

export function createMemoryWhatsAppMessageStore() {
  const instances = new Map<string, ConnectedInstance>();
  const phoneIndex = new Map<string, string[]>();
  const clientTenants = new Map<string, string | null>();
  const internal = new Set<string>();
  const conversations: StoredConversation[] = [];
  const messages: StoredMessage[] = [];
  let sequence = 0;
  let failNext: Error | null = null;

  const failIfAsked = () => {
    if (failNext) {
      const error = failNext;
      failNext = null;
      throw error;
    }
  };

  const store: WhatsAppMessageStore = {
    async findConnectedInstance(instanceName) {
      failIfAsked();
      return instances.get(instanceName) ?? null;
    },
    async internalPhones() {
      return internal;
    },
    async matchClient(phone): Promise<ClientPhoneMatch> {
      const ids = phoneIndex.get(phone) ?? [];
      if (ids.length === 0) return { status: "no_match" };
      if (ids.length > 1) return { status: "ambiguous", clientIds: [...ids].sort() };
      return { status: "linked", clientId: ids[0], tenantId: clientTenants.get(ids[0]) ?? null };
    },
    async findConversation(account, contactPhone) {
      return conversations.find((row) => row.account === account && row.contactPhone === contactPhone) ?? null;
    },
    async createConversation(data) {
      if (conversations.some((row) => row.account === data.account && row.contactPhone === data.contactPhone)) return "conflict";
      const row: StoredConversation = { ...data, id: `conversation-${++sequence}`, lastMessageAt: null, lastInboundAt: null, lastOutboundAt: null };
      conversations.push(row);
      return row;
    },
    async updateConversation(id, data: ConversationUpdate) {
      const row = conversations.find((item) => item.id === id);
      if (!row) throw new Error("conversa inexistente");
      Object.assign(row, data);
    },
    async createMessage(data) {
      failIfAsked();
      if (messages.some((row) => row.account === data.account && row.externalMessageId === data.externalMessageId)) return "duplicate";
      messages.push({ ...data, id: `message-${++sequence}` });
      return "created";
    },
    async findMessage(account, externalMessageId): Promise<MessageRow | null> {
      const row = messages.find((item) => item.account === account && item.externalMessageId === externalMessageId);
      return row ? { id: row.id, direction: row.direction, type: row.type, textContent: row.textContent, metadata: { ...row.metadata } } : null;
    },
    async updateMessage(id, data: MessageUpdate) {
      const row = messages.find((item) => item.id === id);
      if (!row) throw new Error("mensagem inexistente");
      if (data.type) row.type = data.type;
      if (data.textContent !== undefined) row.textContent = data.textContent;
      if (data.mediaMetadata !== undefined) row.mediaMetadata = data.mediaMetadata;
      row.metadata = data.metadata;
    }
  };

  return {
    store,
    instances,
    phoneIndex,
    clientTenants,
    internal,
    conversations,
    messages,
    failNextWith(error: Error) {
      failNext = error;
    }
  };
}
