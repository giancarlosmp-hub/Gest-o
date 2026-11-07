import { CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType } from "@prisma/client";
import { isWhatsAppMessagesEnabled } from "../whatsappConnection/config.js";
import { parseEvolutionMessageEvent, type ParsedEvolutionEvent } from "./evolutionMessageParser.js";
import { PrismaWhatsAppMessageStore, type ConversationRow, type ConversationUpdate, type LinkStatus, type WhatsAppMessageStore } from "./whatsappMessageStore.js";

// WhatsApp Fase B: grava as mensagens do número comercial conectado (enviadas pelo app do celular e
// recebidas) e liga a conversa ao cliente pelo telefone. Não existe envio.
//
// - Idempotência: (provedor, número comercial, id da mensagem) é único; reentrega vira "duplicate".
// - Vínculo: um cliente com o telefone = vinculada; nenhum ou mais de um = fila "não vinculadas" do dono do
//   número, que expira em 7 dias. A cada mensagem nova de uma conversa sem vínculo a busca roda de novo.
// - Editada: troca o texto e marca editedAt. Apagada: do vendedor, mantém o texto com a marca; do contato,
//   o texto vira "[mensagem apagada]".
// - Relógio: messageTimestamp do WhatsApp; ausente ou mais de 5 min no futuro, vale a hora de chegada.
// O resultado nunca traz texto, nome, número, JID ou id da mensagem: só códigos para log.

export const UNLINKED_RETENTION_DAYS = 7;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const DELETED_BY_CONTACT_TEXT = "[mensagem apagada]";

export type IngestionResult = {
  status: "ignored" | "unknown_instance" | "stored" | "duplicate" | "updated" | "not_found";
  event: "upsert" | "edit" | "delete" | "other";
  reason?: string;
  userId?: string;
  link?: "linked" | "unlinked" | "ambiguous";
  direction?: "inbound" | "outbound";
};

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const later = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);

/** "(DD) ****-NNNN": nunca o número completo fora da coluna do próprio número. */
export const maskContactPhone = (e164: string) => `(${e164.slice(2, 4)}) ****-${e164.slice(-4)}`;

export class WhatsAppMessageIngestion {
  constructor(
    public store: WhatsAppMessageStore = new PrismaWhatsAppMessageStore(),
    private readonly enabled: () => boolean = isWhatsAppMessagesEnabled
  ) {}

  async handle(payload: unknown, now = new Date()): Promise<IngestionResult> {
    if (!this.enabled()) return { status: "ignored", event: "other", reason: "disabled" };
    const parsed = parseEvolutionMessageEvent(payload);
    if (parsed.kind === "ignored") return { status: "ignored", event: "other", reason: parsed.reason };
    const connection = await this.store.findConnectedInstance(parsed.instance);
    if (!connection) return { status: "unknown_instance", event: parsed.kind };
    if (parsed.kind === "upsert") return this.upsert(parsed, connection, now);
    if (parsed.kind === "edit") return this.edit(parsed, connection.account, connection.userId, now);
    return this.delete(parsed, connection.account, connection.userId, now);
  }

  private async conversationFor(account: string, contactPhone: string, ownerUserId: string, pushName: string | null, now: Date) {
    const existing = await this.store.findConversation(account, contactPhone);
    if (existing) return existing;
    const match = await this.store.matchClient(contactPhone);
    const linked = match.status === "linked";
    const created = await this.store.createConversation({
      account,
      contactPhone,
      numberOwnerUserId: ownerUserId,
      clientId: linked ? match.clientId : null,
      tenantId: linked ? match.tenantId : null,
      linkStatus: linked ? "linked" : match.status === "ambiguous" ? "ambiguous" : "unlinked",
      linkSource: linked ? "auto" : null,
      linkedAt: linked ? now : null,
      unlinkedExpiresAt: linked ? null : addDays(now, UNLINKED_RETENTION_DAYS),
      // O nome do contato no WhatsApp só ajuda a vincular: fica enquanto a conversa não tem cliente.
      contactName: linked ? null : pushName,
      contactDisplay: maskContactPhone(contactPhone)
    });
    if (created !== "conflict") return created;
    // Duas mensagens da mesma conversa nova ao mesmo tempo: a outra criou primeiro.
    const again = await this.store.findConversation(account, contactPhone);
    if (!again) throw new Error("whatsapp_conversation_conflict");
    return again;
  }

  /**
   * Conversa ainda sem cliente: tenta de novo (o telefone pode ter entrado no ERP ou nos contatos).
   * Devolve o vínculo efetivo e o que precisa ser gravado na conversa.
   */
  private async relink(conversation: ConversationRow, contactPhone: string, now: Date) {
    const current = {
      clientId: conversation.clientId,
      tenantId: conversation.tenantId,
      linkStatus: (conversation.linkStatus ?? (conversation.clientId ? "linked" : "unlinked")) as LinkStatus
    };
    if (current.linkStatus === "linked" || current.clientId) return { ...current, linkStatus: "linked" as LinkStatus, update: {} as ConversationUpdate };
    const match = await this.store.matchClient(contactPhone);
    if (match.status === "linked") {
      return {
        clientId: match.clientId,
        tenantId: match.tenantId,
        linkStatus: "linked" as LinkStatus,
        update: { clientId: match.clientId, tenantId: match.tenantId, linkStatus: "linked", linkSource: "auto", linkedAt: now, unlinkedExpiresAt: null, contactName: null } as ConversationUpdate
      };
    }
    const linkStatus: LinkStatus = match.status === "ambiguous" ? "ambiguous" : "unlinked";
    return { ...current, linkStatus, update: (linkStatus !== current.linkStatus ? { linkStatus } : {}) as ConversationUpdate };
  }

  private async upsert(parsed: Extract<ParsedEvolutionEvent, { kind: "upsert" }>, connection: { userId: string; account: string }, now: Date): Promise<IngestionResult> {
    const base = { event: "upsert" as const, userId: connection.userId };
    const internal = await this.store.internalPhones();
    if (parsed.contactPhone === connection.account || internal.has(parsed.contactPhone)) {
      return { ...base, status: "ignored", reason: "internal_number" };
    }

    let clock: string | undefined;
    let timestamp = parsed.timestamp;
    if (!timestamp) {
      timestamp = now;
      clock = "received_at";
    } else if (timestamp.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) {
      timestamp = now;
      clock = "received_at_future";
    }

    const conversation = await this.conversationFor(connection.account, parsed.contactPhone, connection.userId, parsed.pushName, now);
    const current = await this.relink(conversation, parsed.contactPhone, now);
    const link = current.linkStatus;
    const direction = parsed.fromMe ? CommunicationDirection.OUTBOUND : CommunicationDirection.INBOUND;

    const created = await this.store.createMessage({
      conversationId: conversation.id,
      account: connection.account,
      externalMessageId: parsed.externalMessageId,
      tenantId: current.tenantId,
      direction,
      status: parsed.fromMe ? CommunicationMessageStatus.SENT : CommunicationMessageStatus.RECEIVED,
      type: parsed.content.type,
      textContent: parsed.content.text,
      mediaMetadata: parsed.content.media,
      providerTimestamp: timestamp,
      // Fase B: tudo o que o vendedor envia sai pelo app do celular ("WhatsApp · via app").
      metadata: { ...(parsed.fromMe ? { origin: "app" } : {}), ...(clock ? { clock } : {}) }
    });
    const directionLabel = parsed.fromMe ? "outbound" : "inbound";
    if (created === "duplicate") return { ...base, status: "duplicate", link, direction: directionLabel };

    await this.store.updateConversation(conversation.id, {
      numberOwnerUserId: connection.userId,
      lastMessageAt: later(conversation.lastMessageAt, timestamp),
      ...(parsed.fromMe
        ? { lastOutboundAt: later(conversation.lastOutboundAt, timestamp), previewSanitized: "Mensagem enviada" }
        : { lastInboundAt: later(conversation.lastInboundAt, timestamp), previewSanitized: "Mensagem recebida" }),
      ...(link !== "linked" && parsed.pushName ? { contactName: parsed.pushName } : {}),
      ...current.update
    });
    return { ...base, status: "stored", link, direction: directionLabel };
  }

  private async edit(parsed: Extract<ParsedEvolutionEvent, { kind: "edit" }>, account: string, userId: string, now: Date): Promise<IngestionResult> {
    const message = await this.store.findMessage(account, parsed.targetMessageId);
    if (!message) return { status: "not_found", event: "edit", userId };
    if (message.metadata.deletedInWhatsAppAt) return { status: "ignored", event: "edit", userId, reason: "already_deleted" };
    await this.store.updateMessage(message.id, {
      // Legenda editada de uma mídia mantém o tipo da mídia.
      ...(parsed.content.type !== CommunicationMessageType.TEXT || message.type === CommunicationMessageType.TEXT ? { type: parsed.content.type } : {}),
      textContent: message.type !== CommunicationMessageType.TEXT && parsed.content.type === CommunicationMessageType.TEXT
        ? `${(message.textContent ?? "").match(/^\[[^\]]+\]/)?.[0] ?? "[mídia]"} ${parsed.content.text}`
        : parsed.content.text,
      metadata: { ...message.metadata, editedAt: now.toISOString() }
    });
    return { status: "updated", event: "edit", userId };
  }

  private async delete(parsed: Extract<ParsedEvolutionEvent, { kind: "delete" }>, account: string, userId: string, now: Date): Promise<IngestionResult> {
    const message = await this.store.findMessage(account, parsed.targetMessageId);
    if (!message) return { status: "not_found", event: "delete", userId };
    if (message.metadata.deletedInWhatsAppAt) return { status: "duplicate", event: "delete", userId };
    const metadata: Record<string, unknown> = { ...message.metadata, deletedInWhatsAppAt: now.toISOString() };
    if (message.direction === CommunicationDirection.OUTBOUND) {
      // Do vendedor: mantém o conteúdo, com a marca "apagada no WhatsApp".
      await this.store.updateMessage(message.id, { metadata });
      return { status: "updated", event: "delete", userId, direction: "outbound" };
    }
    // Do contato: o texto sai, fica só o aviso.
    const { editedAt: _editedAt, ...withoutEdit } = metadata;
    await this.store.updateMessage(message.id, { textContent: DELETED_BY_CONTACT_TEXT, mediaMetadata: null, metadata: withoutEdit });
    return { status: "updated", event: "delete", userId, direction: "inbound" };
  }
}

export const whatsappMessageIngestion = new WhatsAppMessageIngestion();
