import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizeBrazilPhone } from "@salesforce-pro/shared";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { displayPhone } from "../whatsappConnection/phoneMatch.js";
import { toMessageView, type MessageView } from "../whatsappMessages/whatsappConversationReads.js";
import { EVOLUTION_PROVIDER } from "../whatsappMessages/whatsappMessageStore.js";

// WhatsApp Fase C: leituras da caixa de conversas (/whatsapp).
// - Caixa: conversas VINCULADAS de um número (dono), da mais recente para a mais antiga, com não lidas e um
//   trecho da última mensagem. "Meu número" para todos; "Equipe" (outros números do tenant) só para gestão,
//   somente leitura.
// - Conversa: últimas mensagens (paginadas para trás) ou só as criadas/alteradas desde um instante (polling).
// - Telefones do cliente para abrir uma conversa: linhas do ClientPhoneIndex (a referência é o id da linha;
//   o envio nunca aceita número digitado).
// Nada daqui grava log.

export const INBOX_PAGE_DEFAULT = 20;
export const INBOX_PAGE_MAX = 50;
export const THREAD_PAGE = 50;
export const CHANGES_PAGE = 200;
export const INBOX_PREVIEW_MAX = 120;

type InboxDb = Pick<PrismaClient, "communicationConversation" | "communicationMessage">;

export const inboxConversationWhere = (input: { tenantId: string; ownerUserId?: string | null; excludeOwnerUserId?: string | null }): Prisma.CommunicationConversationWhereInput => ({
  provider: EVOLUTION_PROVIDER,
  linkStatus: "linked",
  clientId: { not: null },
  client: { tenantId: input.tenantId },
  ...(input.ownerUserId ? { numberOwnerUserId: input.ownerUserId } : { numberOwnerUserId: { not: null } }),
  ...(input.excludeOwnerUserId && !input.ownerUserId ? { NOT: { numberOwnerUserId: input.excludeOwnerUserId } } : {})
});

const preview = (text: string | null) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > INBOX_PREVIEW_MAX ? `${value.slice(0, INBOX_PREVIEW_MAX - 1)}…` : value;
};

export const inboxConversationSelect = {
  id: true,
  contactDisplay: true,
  lastMessageAt: true,
  unreadCount: true,
  numberOwnerUserId: true,
  numberOwner: { select: { id: true, name: true } },
  client: { select: { id: true, name: true, ownerSellerId: true, isArchived: true } }
} as const;

export type InboxConversationRow = {
  id: string;
  contactDisplay: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  numberOwnerUserId: string | null;
  numberOwner: { id: string; name: string } | null;
  client: { id: string; name: string; ownerSellerId: string | null; isArchived: boolean } | null;
};

/** Quem vê: o dono do número; gerente e diretor (somente leitura nos números dos outros). */
export type InboxViewer = { id: string; manager: boolean };

/** Responder: só no próprio número, cliente ativo e (vendedor) da carteira dele. O servidor confere de novo no envio. */
export const canReplyIn = (row: InboxConversationRow, viewer: InboxViewer) =>
  row.numberOwnerUserId === viewer.id && Boolean(row.client) && !row.client!.isArchived && (viewer.manager || row.client!.ownerSellerId === viewer.id);

export const toInboxConversationView = (row: InboxConversationRow, viewer: InboxViewer) => ({
  id: row.id,
  client: row.client ? { id: row.client.id, name: row.client.name } : null,
  contactDisplay: row.contactDisplay,
  lastMessageAt: row.lastMessageAt,
  unreadCount: row.unreadCount ?? 0,
  numberOwner: row.numberOwner,
  own: row.numberOwnerUserId === viewer.id,
  canReply: canReplyIn(row, viewer)
});

export async function listInbox(
  input: { tenantId: string; viewer: InboxViewer; ownerUserId?: string | null; excludeOwnerUserId?: string | null; cursor?: string | null; take?: number },
  db: InboxDb = defaultPrisma
) {
  const take = Math.min(Math.max(Math.trunc(Number.isFinite(input.take) ? input.take! : INBOX_PAGE_DEFAULT), 1), INBOX_PAGE_MAX);
  const rows = (await db.communicationConversation.findMany({
    where: inboxConversationWhere(input),
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: inboxConversationSelect
  })) as unknown as InboxConversationRow[];
  const page = rows.slice(0, take);
  const last = await Promise.all(
    page.map((row) =>
      db.communicationMessage.findFirst({
        where: { conversationId: row.id, provider: EVOLUTION_PROVIDER },
        orderBy: [{ providerTimestamp: "desc" }, { id: "desc" }],
        select: { direction: true, type: true, textContent: true, metadata: true }
      })
    )
  );
  return {
    items: page.map((row, index) => {
      const message = last[index];
      const metadata = message?.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? (message.metadata as Record<string, unknown>) : {};
      return {
        ...toInboxConversationView(row, input.viewer),
        lastMessage: message
          ? { direction: message.direction === "OUTBOUND" ? ("outbound" as const) : ("inbound" as const), type: message.type, text: preview(message.textContent), viaCrm: metadata.origin === "crm" }
          : null
      };
    }),
    nextCursor: rows.length > take ? page[page.length - 1].id : null
  };
}

/** Soma das não lidas do próprio número (conversas vinculadas). */
export async function countOwnUnread(input: { tenantId: string; ownerUserId: string }, db: Pick<PrismaClient, "communicationConversation"> = defaultPrisma) {
  const rows = await db.communicationConversation.findMany({
    where: { ...inboxConversationWhere(input), unreadCount: { gt: 0 } },
    select: { unreadCount: true }
  });
  return rows.reduce((total, row) => total + row.unreadCount, 0);
}

const phoneKind = (phone: string) => {
  const parsed = normalizeBrazilPhone(phone);
  return parsed.valid ? parsed.kind : null;
};

const messageSelect = { id: true, direction: true, type: true, textContent: true, providerTimestamp: true, metadata: true, mediaMetadata: true } as const;

/**
 * Mensagens de uma conversa, em ordem de envio:
 * - sem `changedSince`: as últimas THREAD_PAGE (antes da mensagem `before`, se vier), com `nextBefore` para as anteriores;
 * - com `changedSince`: as criadas ou alteradas (edição, apagada, transcrição) desde o instante, para o polling.
 */
export async function readInboxMessages(
  input: { conversationId: string; before?: string | null; changedSince?: Date | null },
  db: Pick<PrismaClient, "communicationMessage"> = defaultPrisma
): Promise<{ items: MessageView[]; nextBefore: string | null }> {
  if (input.changedSince) {
    const rows = await db.communicationMessage.findMany({
      where: { conversationId: input.conversationId, provider: EVOLUTION_PROVIDER, updatedAt: { gte: input.changedSince } },
      orderBy: [{ providerTimestamp: "asc" }, { id: "asc" }],
      take: CHANGES_PAGE,
      select: messageSelect
    });
    return { items: rows.map(toMessageView), nextBefore: null };
  }
  const rows = await db.communicationMessage.findMany({
    where: { conversationId: input.conversationId, provider: EVOLUTION_PROVIDER },
    orderBy: [{ providerTimestamp: "desc" }, { id: "desc" }],
    take: THREAD_PAGE + 1,
    ...(input.before ? { cursor: { id: input.before }, skip: 1 } : {}),
    select: messageSelect
  });
  const page = rows.slice(0, THREAD_PAGE);
  return { items: page.reverse().map(toMessageView), nextBefore: rows.length > THREAD_PAGE ? page[0].id : null };
}

/**
 * Telefones de um cliente para abrir uma conversa pelo próprio número: um por telefone (a primeira linha do
 * índice vira a referência), com a conversa já existente deste número, se houver.
 */
export async function readClientPhoneTargets(
  input: { clientId: string; account: string | null; ownerUserId: string },
  db: Pick<PrismaClient, "clientPhoneIndex" | "communicationConversation"> = defaultPrisma
) {
  const rows = await db.clientPhoneIndex.findMany({
    where: { clientId: input.clientId },
    // ERP antes dos contatos do CRM ("erp" > "crm"), como na tela do cliente.
    orderBy: [{ source: "desc" }, { id: "asc" }],
    select: { id: true, phone: true, source: true }
  });
  const byPhone = new Map<string, { id: string; phone: string; source: string }>();
  for (const row of rows) if (!byPhone.has(row.phone)) byPhone.set(row.phone, row);
  const phones = [...byPhone.keys()];
  const conversations =
    input.account && phones.length
      ? await db.communicationConversation.findMany({
          where: { provider: EVOLUTION_PROVIDER, externalAccountId: input.account, numberOwnerUserId: input.ownerUserId, externalConversationKey: { in: phones } },
          select: { id: true, externalConversationKey: true, clientId: true, linkStatus: true, unreadCount: true }
        })
      : [];
  const conversationByPhone = new Map(conversations.map((row) => [row.externalConversationKey, row]));
  return [...byPhone.values()].map((row) => {
    const conversation = conversationByPhone.get(row.phone);
    const linkedHere = conversation && conversation.clientId === input.clientId && conversation.linkStatus === "linked";
    return {
      ref: row.id,
      display: displayPhone(row.phone),
      kind: phoneKind(row.phone),
      source: row.source,
      conversationId: linkedHere ? conversation!.id : null,
      unreadCount: linkedHere ? conversation!.unreadCount ?? 0 : 0
    };
  });
}
