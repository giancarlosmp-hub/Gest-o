import { Role, WhatsAppConnectionStatus, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { normalizeWhatsAppContactPhone } from "../whatsappConnection/phoneMatch.js";
import { findClientsByPhone } from "../whatsappMessages/clientPhoneIndex.js";
import { EVOLUTION_PROVIDER, PrismaWhatsAppMessageStore } from "../whatsappMessages/whatsappMessageStore.js";

// WhatsApp Fase C: único destino aceito por EvolutionClient.sendTextToClient. Emitido só por
// resolveClientRecipient, que confere tudo no servidor, na hora do envio:
// - remetente: o número CONNECTED do PRÓPRIO usuário (a instância vai junto no destino);
// - destino: uma conversa vinculada desse número (nunca a de outro número, nem para gerente e diretor) ou um
//   telefone do índice ClientPhoneIndex daquele cliente (referência pela linha do índice, nunca número solto);
// - cliente não arquivado do tenant; vendedor só da própria carteira; gerente e diretor qualquer cliente;
// - telefone em mais de um cliente sem conversa já vinculada, conversa na fila ou número de usuário do CRM:
//   recusado.
// O destino é um objeto congelado registrado num WeakMap deste módulo, válido por pouco tempo: um objeto
// montado à mão, mesmo com cast de tipo, é recusado. Nunca grava log.

export type ClientSendTarget = { conversationId: string } | { clientId: string; phoneRef: string };

export type ClientRecipient = {
  readonly senderUserId: string;
  readonly instanceName: string;
  /** Número comercial do remetente (55 + DDD + número). */
  readonly account: string;
  readonly clientId: string;
  readonly tenantId: string | null;
  /** Telefone do contato (55 + DDD + número). */
  readonly phone: string;
  /** Conversa já existente deste número com o contato, ou null (o envio cria). */
  readonly conversationId: string | null;
  /** O contato nunca escreveu para este número (conta no limite de primeiros contatos). */
  readonly firstContact: boolean;
};

export const CLIENT_RECIPIENT_REFUSALS = [
  "not_connected",
  "conversation_not_found",
  "conversation_unlinked",
  "recipient_not_allowed",
  "phone_ambiguous",
  "phone_internal"
] as const;
export type ClientRecipientRefusal = (typeof CLIENT_RECIPIENT_REFUSALS)[number];

export type ClientRecipientResolution = { ok: true; recipient: ClientRecipient } | { ok: false; reason: ClientRecipientRefusal };

/** Validade do destino emitido: a checagem é sempre recente. */
export const CLIENT_RECIPIENT_TTL_MS = 2 * 60_000;

const issuedAt = new WeakMap<object, number>();

type RecipientDb = Pick<PrismaClient, "whatsAppConnection" | "communicationConversation" | "clientPhoneIndex" | "client" | "user">;

export type ResolveClientRecipientInput = {
  user: { id: string; role: Role | string };
  tenantId: string;
  target: ClientSendTarget;
};

const conversationSelect = { id: true, clientId: true, linkStatus: true, externalConversationKey: true, lastInboundAt: true } as const;

export async function resolveClientRecipient(
  input: ResolveClientRecipientInput,
  db: RecipientDb = defaultPrisma,
  options: { internalPhones?: () => Promise<Set<string>>; now?: () => number } = {}
): Promise<ClientRecipientResolution> {
  const refuse = (reason: ClientRecipientRefusal): ClientRecipientResolution => ({ ok: false, reason });
  const connection = await db.whatsAppConnection.findUnique({
    where: { userId: input.user.id },
    select: { instanceName: true, status: true, connectedPhone: true }
  });
  if (!connection || connection.status !== WhatsAppConnectionStatus.CONNECTED || !connection.connectedPhone) return refuse("not_connected");
  const account = connection.connectedPhone;

  let conversation: { id: string; clientId: string | null; linkStatus: string | null; externalConversationKey: string; lastInboundAt: Date | null } | null;
  let clientId: string;
  let phone: string;
  if ("conversationId" in input.target) {
    // Só conversa do próprio número: a de outro número nunca é usada para enviar.
    conversation = await db.communicationConversation.findFirst({
      where: { id: input.target.conversationId, provider: EVOLUTION_PROVIDER, numberOwnerUserId: input.user.id, externalAccountId: account },
      select: conversationSelect
    });
    if (!conversation) return refuse("conversation_not_found");
    if (!conversation.clientId || conversation.linkStatus !== "linked") return refuse("conversation_unlinked");
    clientId = conversation.clientId;
    phone = conversation.externalConversationKey;
  } else {
    const entry = await db.clientPhoneIndex.findFirst({
      where: { id: input.target.phoneRef, clientId: input.target.clientId },
      select: { phone: true, clientId: true }
    });
    if (!entry) return refuse("recipient_not_allowed");
    clientId = entry.clientId;
    phone = entry.phone;
    conversation = await db.communicationConversation.findUnique({
      where: { provider_externalAccountId_externalConversationKey: { provider: EVOLUTION_PROVIDER, externalAccountId: account, externalConversationKey: phone } },
      select: conversationSelect
    });
    if (conversation) {
      if (!conversation.clientId) return refuse("conversation_unlinked");
      if (conversation.clientId !== clientId) return refuse("phone_ambiguous");
    } else {
      const match = await findClientsByPhone(phone, db);
      if (match.status === "ambiguous") return refuse("phone_ambiguous");
      if (match.status !== "linked" || match.clientId !== clientId) return refuse("recipient_not_allowed");
    }
  }
  if (normalizeWhatsAppContactPhone(phone) !== phone) return refuse("recipient_not_allowed");

  const isManager = input.user.role === Role.diretor || input.user.role === Role.gerente;
  const client = await db.client.findFirst({
    where: { id: clientId, tenantId: input.tenantId, isArchived: false, ...(isManager ? {} : { ownerSellerId: input.user.id }) },
    select: { id: true, tenantId: true }
  });
  if (!client) return refuse("recipient_not_allowed");

  const internalPhones = options.internalPhones ?? (() => new PrismaWhatsAppMessageStore(db as PrismaClient).internalPhones());
  if (phone === account || (await internalPhones()).has(phone)) return refuse("phone_internal");

  const recipient: ClientRecipient = Object.freeze({
    senderUserId: input.user.id,
    instanceName: connection.instanceName,
    account,
    clientId: client.id,
    tenantId: client.tenantId ?? null,
    phone,
    conversationId: conversation?.id ?? null,
    firstContact: !conversation?.lastInboundAt
  });
  issuedAt.set(recipient, (options.now ?? Date.now)());
  return { ok: true, recipient };
}

/** Destino emitido por resolveClientRecipient há menos de CLIENT_RECIPIENT_TTL_MS. */
export function isClientRecipient(value: unknown, now = Date.now()): value is ClientRecipient {
  if (typeof value !== "object" || value === null) return false;
  const at = issuedAt.get(value);
  return at !== undefined && now - at <= CLIENT_RECIPIENT_TTL_MS;
}
