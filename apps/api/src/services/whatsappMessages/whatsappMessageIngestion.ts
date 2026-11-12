import { CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType } from "@prisma/client";
import { logApiEvent } from "../../utils/logger.js";
import { env } from "../../config/env.js";
import { isWhatsAppMessagesEnabled, isWhatsAppTranscriptionEnabled } from "../whatsappConnection/config.js";
import { parseEvolutionMessageEvent, type ParsedEvolutionEvent } from "./evolutionMessageParser.js";
import { PrismaWhatsAppMessageStore, type ConversationRow, type ConversationUpdate, type LinkStatus, type WhatsAppMessageStore } from "./whatsappMessageStore.js";
import { initialTranscription, whatsappTranscriptionQueue, type TranscriptionJob } from "./whatsappTranscriptionQueue.js";

// WhatsApp Fase B: grava as mensagens do número comercial conectado (enviadas pelo app do celular e
// recebidas) e liga a conversa ao cliente pelo telefone. O envio pelo CRM (Fase C) grava a própria mensagem
// com o id devolvido pelo Evolution; o eco dela aqui vira "duplicate" (ou, se chegar antes, é gravado
// "via app" e o envio corrige a origem).
//
// - Não lidas (Fase C): a recebida soma 1 na conversa (do dono do número); a enviada pelo app zera.
// - Idempotência: (provedor, número comercial, id da mensagem) é único; reentrega vira "duplicate".
// - Vínculo: um cliente com o telefone = vinculada; nenhum ou mais de um = fila "não vinculadas" do dono do
//   número, que expira em 7 dias. A cada mensagem nova de uma conversa sem vínculo a busca roda de novo.
// - Editada (messages.edited ou protocolMessage MESSAGE_EDIT dentro de messages.upsert): troca o texto e
//   guarda o anterior e editedAt em metadata; nunca cria linha. Apagada (messages.delete ou REVOKE no
//   upsert): do vendedor, mantém o texto com a marca; do contato, o texto vira "[mensagem apagada]" e o
//   texto anterior da edição sai junto. Original não gravada: ignorada.
// - Edição cifrada (secretEncryptedMessage MESSAGE_EDIT no upsert): o texto novo não é legível (o segredo da
//   original não é guardado). Só marca a original com editedInWhatsAppAt em metadata, mantendo o texto;
//   original apagada ou já marcada: nada muda. A apagada pelo contato perde a marca junto com o texto.
// - Tipo desconhecido ("[mensagem não suportada]"): WARN só com os nomes dos campos de data.message.
// - Relógio: messageTimestamp do WhatsApp; ausente ou mais de 5 min no futuro, vale a hora de chegada.
// - Áudio com a transcrição ligada: grava mediaMetadata.transcription (pendente ou pulado) e, se pendente, põe
//   na fila em memória a referência do arquivo (que não é gravada). A transcrição roda fora do webhook.
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
  transcription?: "pending" | "skipped";
};

/** O que a ingestão precisa da transcrição (os testes trocam por uma versão em memória). */
export type TranscriptionHook = {
  enabled: () => boolean;
  maxSeconds: () => number;
  enqueue: (job: TranscriptionJob) => void;
};

const defaultTranscription: TranscriptionHook = {
  enabled: isWhatsAppTranscriptionEnabled,
  maxSeconds: () => env.whatsappTranscriptionMaxSeconds,
  enqueue: (job) => whatsappTranscriptionQueue.enqueue(job)
};

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const later = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);

/** "(DD) ****-NNNN": nunca o número completo fora da coluna do próprio número. */
export const maskContactPhone = (e164: string) => `(${e164.slice(2, 4)}) ****-${e164.slice(-4)}`;

export class WhatsAppMessageIngestion {
  constructor(
    public store: WhatsAppMessageStore = new PrismaWhatsAppMessageStore(),
    private readonly enabled: () => boolean = isWhatsAppMessagesEnabled,
    private readonly transcription: TranscriptionHook = defaultTranscription
  ) {}

  async handle(payload: unknown, now = new Date()): Promise<IngestionResult> {
    if (!this.enabled()) return { status: "ignored", event: "other", reason: "disabled" };
    const parsed = parseEvolutionMessageEvent(payload);
    if (parsed.kind === "ignored") return { status: "ignored", event: "other", reason: parsed.reason };
    const connection = await this.store.findConnectedInstance(parsed.instance);
    if (!connection) return { status: "unknown_instance", event: parsed.kind === "edit_without_text" ? "edit" : parsed.kind };
    if (parsed.kind === "upsert") return this.upsert(parsed, connection, now);
    if (parsed.kind === "edit") return this.edit(parsed, connection.account, connection.userId, now);
    if (parsed.kind === "edit_without_text") return this.editWithoutText(parsed, connection.account, connection.userId, now);
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
    if (parsed.unsupportedFields) {
      logApiEvent("WARN", "[whatsapp] unsupported message type", { fields: parsed.unsupportedFields, direction: parsed.fromMe ? "outbound" : "inbound" });
    }
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
    const audio = parsed.audioSource && parsed.content.media && this.transcription.enabled() ? parsed.audioSource : null;
    const transcription = audio
      ? initialTranscription({ seconds: parsed.content.media?.seconds, fileLength: audio.fileLength, maxSeconds: this.transcription.maxSeconds(), now })
      : null;

    const created = await this.store.createMessage({
      conversationId: conversation.id,
      account: connection.account,
      externalMessageId: parsed.externalMessageId,
      tenantId: current.tenantId,
      direction,
      status: parsed.fromMe ? CommunicationMessageStatus.SENT : CommunicationMessageStatus.RECEIVED,
      type: parsed.content.type,
      textContent: parsed.content.text,
      mediaMetadata: transcription ? { ...parsed.content.media, transcription } : parsed.content.media,
      providerTimestamp: timestamp,
      // Fase B: tudo o que o vendedor envia sai pelo app do celular ("WhatsApp · via app").
      metadata: { ...(parsed.fromMe ? { origin: "app" } : {}), ...(clock ? { clock } : {}) }
    });
    const directionLabel = parsed.fromMe ? "outbound" : "inbound";
    if (created === "duplicate") return { ...base, status: "duplicate", link, direction: directionLabel };
    if (audio && transcription?.status === "pending") {
      this.transcription.enqueue({
        instance: parsed.instance,
        account: connection.account,
        externalMessageId: parsed.externalMessageId,
        seconds: parsed.content.media?.seconds ?? 0,
        source: audio
      });
    }

    await this.store.updateConversation(conversation.id, {
      numberOwnerUserId: connection.userId,
      lastMessageAt: later(conversation.lastMessageAt, timestamp),
      ...(parsed.fromMe
        ? { lastOutboundAt: later(conversation.lastOutboundAt, timestamp), previewSanitized: "Mensagem enviada", unreadCount: 0 }
        : { lastInboundAt: later(conversation.lastInboundAt, timestamp), previewSanitized: "Mensagem recebida", unreadCount: { increment: 1 } }),
      ...(link !== "linked" && parsed.pushName ? { contactName: parsed.pushName } : {}),
      ...current.update
    });
    return {
      ...base,
      status: "stored",
      link,
      direction: directionLabel,
      ...(transcription ? { transcription: transcription.status === "pending" ? ("pending" as const) : ("skipped" as const) } : {})
    };
  }

  private async edit(parsed: Extract<ParsedEvolutionEvent, { kind: "edit" }>, account: string, userId: string, now: Date): Promise<IngestionResult> {
    const message = await this.store.findMessage(account, parsed.targetMessageId);
    if (!message) return { status: "not_found", event: "edit", userId };
    if (message.metadata.deletedInWhatsAppAt) return { status: "ignored", event: "edit", userId, reason: "already_deleted" };
    // Legenda editada de uma mídia mantém o tipo da mídia.
    const keepsMediaType = message.type !== CommunicationMessageType.TEXT && parsed.content.type === CommunicationMessageType.TEXT;
    const type = keepsMediaType ? message.type : parsed.content.type;
    const textContent = keepsMediaType
      ? `${(message.textContent ?? "").match(/^\[[^\]]+\]/)?.[0] ?? "[mídia]"} ${parsed.content.text}`
      : parsed.content.text;
    // Reentrega (ou o mesmo aviso por messages.edited e por messages.upsert): nada muda.
    if (textContent === message.textContent && type === message.type) return { status: "duplicate", event: "edit", userId };
    await this.store.updateMessage(message.id, {
      type,
      textContent,
      metadata: { ...message.metadata, previousText: message.textContent ?? null, editedAt: now.toISOString() }
    });
    return { status: "updated", event: "edit", userId };
  }

  private async editWithoutText(parsed: Extract<ParsedEvolutionEvent, { kind: "edit_without_text" }>, account: string, userId: string, now: Date): Promise<IngestionResult> {
    const message = await this.store.findMessage(account, parsed.targetMessageId);
    if (!message) return { status: "not_found", event: "edit", userId, reason: "text_unavailable" };
    if (message.metadata.deletedInWhatsAppAt) return { status: "ignored", event: "edit", userId, reason: "already_deleted" };
    // Reentrega (ou outra edição cifrada da mesma mensagem): a marca já existe.
    if (message.metadata.editedInWhatsAppAt) return { status: "duplicate", event: "edit", userId, reason: "text_unavailable" };
    await this.store.updateMessage(message.id, { metadata: { ...message.metadata, editedInWhatsAppAt: now.toISOString() } });
    return { status: "updated", event: "edit", userId, reason: "text_unavailable" };
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
    // Do contato: o texto sai (também o anterior à edição), fica só o aviso.
    const { editedAt: _editedAt, previousText: _previousText, editedInWhatsAppAt: _editedInWhatsAppAt, ...withoutEdit } = metadata;
    await this.store.updateMessage(message.id, { textContent: DELETED_BY_CONTACT_TEXT, mediaMetadata: null, metadata: withoutEdit });
    return { status: "updated", event: "delete", userId, direction: "inbound" };
  }
}

export const whatsappMessageIngestion = new WhatsAppMessageIngestion();
