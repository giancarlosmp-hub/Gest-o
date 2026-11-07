import { Role, type PrismaClient } from "@prisma/client";
import { splitPhoneField } from "@salesforce-pro/shared";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { displayPhone, normalizeWhatsAppContactPhone } from "../whatsappConnection/phoneMatch.js";
import { scheduleClientPhoneIndexRefresh } from "./clientPhoneIndex.js";
import { EVOLUTION_PROVIDER } from "./whatsappMessageStore.js";

// WhatsApp Fase B2: fila "Conversas não vinculadas" do dono do número (cada um vê só a própria, inclusive
// gerente e diretor), vincular a um cliente e descartar.
// - Vincular: vendedor só a cliente da carteira dele; gerente e diretor a qualquer cliente ativo do tenant.
//   O telefone vira contato do cliente (para as próximas conversas casarem sozinhas), salvo quando já está
//   no cliente ou quando a conversa é ambígua (o telefone está em outro cliente).
// - Descartar: apaga a conversa e as mensagens (cascata). Se o contato escrever de novo, volta para a fila.
// Duas ações ao mesmo tempo: só a primeira muda a conversa; a outra recebe 409.

const DAY_MS = 24 * 60 * 60 * 1000;
export const QUEUE_PAGE_DEFAULT = 20;
export const QUEUE_PAGE_MAX = 50;
export const LAST_MESSAGE_PREVIEW_MAX = 120;
export const WHATSAPP_CONTACT_FALLBACK_NAME = "Contato WhatsApp";

export class WhatsAppQueueError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

type QueueUser = { id: string; role: Role | string };
type QueueDb = Pick<PrismaClient, "communicationConversation" | "communicationMessage" | "client" | "contact" | "clientPhoneIndex" | "$transaction">;

/** Conversas da fila de um dono de número: sem cliente, não vinculadas ou ambíguas. */
export const unlinkedQueueWhere = (ownerUserId: string) => ({
  provider: EVOLUTION_PROVIDER,
  numberOwnerUserId: ownerUserId,
  clientId: null,
  linkStatus: { in: ["unlinked", "ambiguous"] }
});

const preview = (text: string | null) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > LAST_MESSAGE_PREVIEW_MAX ? `${value.slice(0, LAST_MESSAGE_PREVIEW_MAX - 1)}…` : value;
};

export const daysToExpire = (expiresAt: Date | null, now: Date) =>
  expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)) : null;

export async function countUnlinkedConversations(ownerUserId: string, db: Pick<PrismaClient, "communicationConversation"> = defaultPrisma) {
  return db.communicationConversation.count({ where: unlinkedQueueWhere(ownerUserId) });
}

/** A fila do próprio usuário. O número completo do contato aparece só aqui, para o dono do número. */
export async function listUnlinkedConversations(
  input: { ownerUserId: string; cursor?: string | null; take?: number; now?: Date },
  db: Pick<PrismaClient, "communicationConversation"> = defaultPrisma
) {
  const take = Math.min(Math.max(Math.trunc(Number.isFinite(input.take) ? input.take! : QUEUE_PAGE_DEFAULT), 1), QUEUE_PAGE_MAX);
  const now = input.now ?? new Date();
  const where = unlinkedQueueWhere(input.ownerUserId);
  const [rows, total] = await Promise.all([
    db.communicationConversation.findMany({
      where,
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: take + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        contactNormalized: true,
        contactName: true,
        linkStatus: true,
        lastMessageAt: true,
        unlinkedExpiresAt: true,
        messages: {
          orderBy: [{ providerTimestamp: "desc" }, { id: "desc" }],
          take: 1,
          select: { direction: true, textContent: true, providerTimestamp: true }
        }
      }
    }),
    db.communicationConversation.count({ where })
  ]);
  const page = rows.slice(0, take);
  return {
    items: page.map((row) => {
      const last = row.messages[0];
      return {
        id: row.id,
        phone: displayPhone(row.contactNormalized),
        pushName: row.contactName,
        status: row.linkStatus === "ambiguous" ? ("ambiguous" as const) : ("unlinked" as const),
        lastMessage: last ? { text: preview(last.textContent), direction: last.direction === "OUTBOUND" ? "outbound" : "inbound", at: last.providerTimestamp } : null,
        lastMessageAt: row.lastMessageAt,
        expiresAt: row.unlinkedExpiresAt,
        daysToExpire: daysToExpire(row.unlinkedExpiresAt, now)
      };
    }),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
    total
  };
}

export type LinkContactResult = "created" | "exists" | "skipped_ambiguous" | "skipped_invalid";

const contactName = (pushName: string | null) => {
  const name = (pushName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return name.length >= 2 ? name : WHATSAPP_CONTACT_FALLBACK_NAME;
};

/**
 * Telefone da conversa como contato do cliente, sem duplicar: já no índice deste cliente (ERP ou CRM) ou
 * num contato dele (comparado normalizado, como o índice faz) = "exists"; no índice de outro cliente ativo =
 * ambíguo, não cria.
 */
async function ensureLinkedPhoneContact(
  tx: Pick<PrismaClient, "contact" | "clientPhoneIndex">,
  input: { phone: string | null; pushName: string | null; ambiguous: boolean; client: { id: string; ownerSellerId: string } }
): Promise<LinkContactResult> {
  if (input.ambiguous) return "skipped_ambiguous";
  const phone = normalizeWhatsAppContactPhone(input.phone);
  const display = displayPhone(phone);
  if (!phone || !display) return "skipped_invalid";
  const indexed = await tx.clientPhoneIndex.findMany({ where: { phone, client: { isArchived: false } }, select: { clientId: true }, take: 50 });
  if (indexed.some((row) => row.clientId === input.client.id)) return "exists";
  if (indexed.length) return "skipped_ambiguous";
  const contacts = await tx.contact.findMany({ where: { clientId: input.client.id }, select: { phone: true } });
  if (contacts.some((contact) => splitPhoneField(contact.phone ?? "").some((raw) => normalizeWhatsAppContactPhone(raw) === phone))) return "exists";
  await tx.contact.create({
    data: {
      name: contactName(input.pushName),
      phone: display,
      // Sem e-mail: o campo é opcional no formulário e na API (gravado vazio).
      email: "",
      clientId: input.client.id,
      // Do dono atual da carteira: é ele quem edita o contato.
      ownerSellerId: input.client.ownerSellerId
    }
  });
  return "created";
}

export async function linkUnlinkedConversation(
  input: { conversationId: string; clientId: string; user: QueueUser; tenantId: string; now?: Date },
  db: QueueDb = defaultPrisma
) {
  const now = input.now ?? new Date();
  const where = { id: input.conversationId, ...unlinkedQueueWhere(input.user.id) };
  const conversation = await db.communicationConversation.findFirst({
    where,
    select: { id: true, contactNormalized: true, contactName: true, linkStatus: true }
  });
  if (!conversation) throw new WhatsAppQueueError(404, "conversation_not_found", "Conversa não encontrada na sua fila.");
  const manager = input.user.role === Role.diretor || input.user.role === Role.gerente;
  const client = await db.client.findFirst({
    where: { id: input.clientId, tenantId: input.tenantId, isArchived: false, ...(manager ? {} : { ownerSellerId: input.user.id }) },
    select: { id: true, tenantId: true, ownerSellerId: true }
  });
  if (!client) throw new WhatsAppQueueError(404, "client_not_found", manager ? "Cliente não encontrado." : "Cliente não encontrado na sua carteira.");

  const contact = await db.$transaction(async (tx) => {
    const updated = await tx.communicationConversation.updateMany({
      where,
      data: {
        clientId: client.id,
        tenantId: client.tenantId,
        linkStatus: "linked",
        linkSource: "manual",
        linkedById: input.user.id,
        linkedAt: now,
        unlinkedExpiresAt: null,
        // O nome do WhatsApp só servia para vincular (igual ao vínculo automático).
        contactName: null
      }
    });
    if (updated.count !== 1) throw new WhatsAppQueueError(409, "already_handled", "Esta conversa já foi vinculada ou descartada.");
    await tx.communicationMessage.updateMany({ where: { conversationId: conversation.id }, data: { tenantId: client.tenantId } });
    return ensureLinkedPhoneContact(tx, {
      phone: conversation.contactNormalized,
      pushName: conversation.contactName,
      ambiguous: conversation.linkStatus === "ambiguous",
      client
    });
  });
  if (contact === "created") scheduleClientPhoneIndexRefresh([client.id], "whatsapp_manual_link");
  return { conversationId: conversation.id, clientId: client.id, contact };
}

export async function discardUnlinkedConversation(
  input: { conversationId: string; ownerUserId: string },
  db: Pick<PrismaClient, "communicationConversation"> = defaultPrisma
) {
  const removed = await db.communicationConversation.deleteMany({ where: { id: input.conversationId, ...unlinkedQueueWhere(input.ownerUserId) } });
  if (!removed.count) throw new WhatsAppQueueError(404, "conversation_not_found", "Conversa não encontrada na sua fila.");
  return { conversationId: input.conversationId, discarded: true };
}
