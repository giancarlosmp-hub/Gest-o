import { CommunicationDirection, CommunicationMessageStatus, CommunicationMessageType, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { createEvolutionClient, EvolutionUnavailableError, type EvolutionClient, type EvolutionClientSendResult } from "../whatsappConnection/evolutionClient.js";
import { maskContactPhone } from "../whatsappMessages/whatsappMessageIngestion.js";
import { toMessageView, type MessageView } from "../whatsappMessages/whatsappConversationReads.js";
import { PrismaWhatsAppMessageStore, type ConversationRow, type WhatsAppMessageStore } from "../whatsappMessages/whatsappMessageStore.js";
import { resolveClientRecipient, type ClientRecipient, type ClientRecipientRefusal, type ClientSendTarget } from "./clientRecipient.js";
import { isCrmSendAvailable, loadCrmSendConfig } from "./crmSendConfig.js";
import { CRM_SEND_LIMITS, crmSendLimiter, type CrmSendLimitCode, type CrmSendLimiter } from "./crmSendLimits.js";

// WhatsApp Fase C: o único ponto do sistema que chama EvolutionClient.sendTextToClient (uma trava estática
// garante). Um texto, para UM destino, por ação humana (uma requisição): nunca em lote, nunca repetido.
// 1. chave ligada (AppConfig) e gravação das conversas ligada; texto válido;
// 2. um envio de cada vez por usuário;
// 3. destino conferido no servidor (resolveClientRecipient: número do próprio usuário, cliente permitido);
// 4. limites (intervalo, minuto, dia, primeiros contatos);
// 5. instância "open" no Evolution na hora;
// 6. envio; com o id devolvido, a mensagem é gravada "via CRM". Se o eco do webhook chegou antes (gravado como
//    "via app" com o mesmo id), só a origem é corrigida: nunca duplica. Incerto: nada é gravado nem repetido.
// Log só com o resultado e o código: nunca texto, número, nome ou ids.

export const CRM_SEND_MAX_TEXT_LENGTH = 4_000;

export type CrmSendCode =
  | ClientRecipientRefusal
  | CrmSendLimitCode
  | "send_disabled"
  | "send_unavailable"
  | "text_invalid"
  | "evolution_unavailable"
  | "number_not_on_whatsapp"
  | "uncertain";

export const CRM_SEND_MESSAGES: Record<CrmSendCode, string> = {
  send_disabled: "Envio pelo CRM desligado.",
  send_unavailable: "Envio pelo CRM indisponível no momento.",
  text_invalid: `Mensagem vazia ou longa demais (até ${CRM_SEND_MAX_TEXT_LENGTH} caracteres).`,
  send_in_progress: "Aguarde: outra mensagem sua ainda está sendo enviada.",
  not_connected: "Seu WhatsApp não está conectado. Conecte em /whatsapp ou use o link do WhatsApp.",
  conversation_not_found: "Conversa não encontrada no seu número.",
  conversation_unlinked: "Esta conversa ainda não está vinculada a um cliente. Vincule pela fila.",
  recipient_not_allowed: "Cliente fora da sua carteira ou telefone não cadastrado.",
  phone_ambiguous: "Este telefone está em mais de um cliente. Vincule pela fila.",
  phone_internal: "Este número é de um usuário do CRM.",
  rate_interval: "Aguarde alguns segundos entre um envio e outro.",
  rate_minute: "Muitos envios seguidos. Aguarde um minuto.",
  rate_day: `Limite diário de envios atingido (${CRM_SEND_LIMITS.perDay}).`,
  rate_first_contact: `Limite diário de primeiros contatos atingido (${CRM_SEND_LIMITS.firstContactsPerDay}).`,
  evolution_unavailable: "Serviço de WhatsApp indisponível no momento. Nada foi enviado.",
  number_not_on_whatsapp: "Este número não tem WhatsApp.",
  uncertain: "Pode ter sido enviada. Confira no celular antes de reenviar."
};

export const CRM_SEND_HTTP_STATUS: Record<CrmSendCode, number> = {
  send_disabled: 403,
  send_unavailable: 503,
  text_invalid: 400,
  send_in_progress: 429,
  not_connected: 409,
  conversation_not_found: 404,
  conversation_unlinked: 409,
  recipient_not_allowed: 404,
  phone_ambiguous: 409,
  phone_internal: 409,
  rate_interval: 429,
  rate_minute: 429,
  rate_day: 429,
  rate_first_contact: 429,
  evolution_unavailable: 503,
  number_not_on_whatsapp: 422,
  uncertain: 202
};

export type CrmSendResult = { ok: true; conversationId: string; message: MessageView } | { ok: false; code: CrmSendCode };

export type CrmSendInput = {
  user: { id: string; role: string };
  tenantId: string;
  target: ClientSendTarget;
  text: unknown;
};

type SendClient = Pick<EvolutionClient, "connectionState" | "sendTextToClient">;

export type CrmSendDeps = {
  db: PrismaClient;
  client: SendClient;
  store: WhatsAppMessageStore;
  limiter: CrmSendLimiter;
  now: () => Date;
  internalPhones?: () => Promise<Set<string>>;
};

const defaultDeps = (): CrmSendDeps => ({
  db: defaultPrisma,
  client: createEvolutionClient(),
  store: new PrismaWhatsAppMessageStore(),
  limiter: crmSendLimiter,
  now: () => new Date()
});

const later = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);

const log = (result: "sent" | "refused" | "not_sent" | "uncertain", code?: string) =>
  logApiEvent(result === "sent" ? "INFO" : "WARN", "[whatsapp] crm send", { result, ...(code ? { code } : {}) });

const refused = (code: CrmSendCode): CrmSendResult => {
  log(code === "uncertain" ? "uncertain" : "refused", code);
  return { ok: false, code };
};

/** Recusa certa do Evolution: nada saiu. */
const notSentCode = (code: string): CrmSendCode => {
  if (code === "number_not_on_whatsapp") return "number_not_on_whatsapp";
  if (code === "instance_not_found") return "not_connected";
  return "evolution_unavailable";
};

export async function sendCrmText(input: CrmSendInput, deps: CrmSendDeps = defaultDeps()): Promise<CrmSendResult> {
  if (!isCrmSendAvailable()) return refused("send_unavailable");
  if (!(await loadCrmSendConfig(deps.db)).enabled) return refused("send_disabled");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > CRM_SEND_MAX_TEXT_LENGTH) return refused("text_invalid");

  const release = deps.limiter.acquire(input.user.id);
  if (!release) return refused("send_in_progress");
  try {
    const resolution = await resolveClientRecipient({ user: input.user, tenantId: input.tenantId, target: input.target }, deps.db, {
      ...(deps.internalPhones ? { internalPhones: deps.internalPhones } : {})
    });
    if (!resolution.ok) return refused(resolution.reason);
    const recipient = resolution.recipient;
    const usage = { userId: input.user.id, account: recipient.account, contactKey: recipient.phone, firstContact: recipient.firstContact };
    const limit = await deps.limiter.check(usage);
    if (limit) return refused(limit);

    try {
      if ((await deps.client.connectionState(recipient.instanceName)) !== "open") return refused("not_connected");
    } catch (error) {
      if (error instanceof EvolutionUnavailableError) return refused("evolution_unavailable");
      throw error;
    }

    let result: EvolutionClientSendResult;
    try {
      result = await deps.client.sendTextToClient(recipient, text);
    } catch {
      // Erro inesperado depois de chamar o envio: pode ter saído. Nunca se repete.
      result = { kind: "uncertain", code: "unexpected_error" };
    }
    if (result.kind === "not_sent") {
      log("not_sent", result.code);
      return { ok: false, code: notSentCode(result.code) };
    }
    deps.limiter.record(usage);
    if (result.kind === "uncertain") {
      log("uncertain", result.code);
      return { ok: false, code: "uncertain" };
    }
    const recorded = await recordCrmSentMessage(deps.store, recipient, { messageId: result.messageId, text, userId: input.user.id, at: deps.now() });
    log("sent");
    return { ok: true, ...recorded };
  } finally {
    release();
  }
}

async function conversationFor(store: WhatsAppMessageStore, recipient: ClientRecipient, at: Date): Promise<ConversationRow> {
  const existing = await store.findConversation(recipient.account, recipient.phone);
  if (existing) return existing;
  const created = await store.createConversation({
    account: recipient.account,
    contactPhone: recipient.phone,
    numberOwnerUserId: recipient.senderUserId,
    clientId: recipient.clientId,
    tenantId: recipient.tenantId,
    linkStatus: "linked",
    linkSource: "crm",
    linkedAt: at,
    unlinkedExpiresAt: null,
    contactName: null,
    contactDisplay: maskContactPhone(recipient.phone)
  });
  if (created !== "conflict") return created;
  // O eco do webhook criou a conversa ao mesmo tempo.
  const again = await store.findConversation(recipient.account, recipient.phone);
  if (!again) throw new Error("whatsapp_conversation_conflict");
  return again;
}

/**
 * Grava a mensagem enviada "via CRM" com o id devolvido pelo Evolution. Se o eco chegou antes (mesmo id, gravado
 * "via app"), só corrige a origem. A conversa fica vinculada ao cliente conferido no destino e sem não lidas.
 */
export async function recordCrmSentMessage(
  store: WhatsAppMessageStore,
  recipient: ClientRecipient,
  sent: { messageId: string; text: string; userId: string; at: Date }
): Promise<{ conversationId: string; message: MessageView }> {
  const conversation = await conversationFor(store, recipient, sent.at);
  const metadata = { origin: "crm", sentByUserId: sent.userId, ...(recipient.firstContact ? { firstContact: true } : {}) };
  const created = await store.createMessage({
    conversationId: conversation.id,
    account: recipient.account,
    externalMessageId: sent.messageId,
    tenantId: recipient.tenantId,
    direction: CommunicationDirection.OUTBOUND,
    status: CommunicationMessageStatus.SENT,
    type: CommunicationMessageType.TEXT,
    textContent: sent.text,
    mediaMetadata: null,
    providerTimestamp: sent.at,
    metadata
  });
  const row = await store.findMessage(recipient.account, sent.messageId);
  if (!row) throw new Error("whatsapp_crm_message_missing");
  if (created === "duplicate") await store.updateMessage(row.id, { metadata: { ...row.metadata, ...metadata } });

  // O eco pode ter criado a conversa sem vínculo (telefone mudou no índice nesse meio-tempo): vale o destino conferido.
  const relink =
    conversation.clientId !== recipient.clientId || conversation.linkStatus !== "linked"
      ? { clientId: recipient.clientId, tenantId: recipient.tenantId, linkStatus: "linked" as const, linkSource: "crm" as const, linkedAt: sent.at, unlinkedExpiresAt: null, contactName: null }
      : {};
  await store.updateConversation(conversation.id, {
    numberOwnerUserId: recipient.senderUserId,
    lastMessageAt: later(conversation.lastMessageAt, sent.at),
    lastOutboundAt: later(conversation.lastOutboundAt, sent.at),
    previewSanitized: "Mensagem enviada",
    unreadCount: 0,
    ...relink
  });
  const view = toMessageView({
    id: row.id,
    direction: CommunicationDirection.OUTBOUND,
    type: row.type,
    textContent: row.textContent,
    providerTimestamp: sent.at,
    metadata: { ...row.metadata, ...metadata },
    mediaMetadata: null
  });
  return { conversationId: conversation.id, message: view };
}
