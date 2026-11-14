import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../config/prisma.js";

// WhatsApp como contato com o cliente, na leitura (decisões de 14/11/2026): a última mensagem ENVIADA (pelo CRM
// ou pelo app do celular) de qualquer conversa vinculada ao cliente, de qualquer número da empresa, conta como
// último contato. Mensagem só recebida não conta. Lê CommunicationConversation.lastOutboundAt (índice em
// clientId): só a data, nunca texto, telefone ou número. Vale também para as conversas já gravadas.
// As oportunidades recebem a data na gravação (whatsappMessages/whatsappLastContact.ts).

type ConversationDb = { communicationConversation: Pick<PrismaClient["communicationConversation"], "aggregate"> };

export async function loadClientLastWhatsAppSentAt(clientId: string, db: ConversationDb = defaultPrisma): Promise<Date | null> {
  const result = await db.communicationConversation.aggregate({ where: { clientId }, _max: { lastOutboundAt: true } });
  return result._max.lastOutboundAt ?? null;
}

/** A data mais recente (ou null). */
export const latestDateOf = (...dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((latest, date) => (date && (!latest || date.getTime() > latest.getTime()) ? date : latest), null);
