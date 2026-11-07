import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { env } from "../../config/env.js";
import { EVOLUTION_PROVIDER } from "./whatsappMessageStore.js";

// WhatsApp Fase B: limpeza das conversas gravadas (só do provedor Evolution; a Meta não é tocada).
// - Não vinculadas (fila do dono do número): 7 dias depois da primeira mensagem, a conversa e as mensagens
//   são apagadas.
// - Vinculadas: mensagens mais antigas que WHATSAPP_MESSAGES_RETENTION_MONTHS (padrão 24) são apagadas; a
//   conversa vinculada que ficou sem mensagem e está parada há mais que isso também.
// Devolve só contagens.

type MaintenanceDb = Pick<PrismaClient, "communicationConversation" | "communicationMessage">;

export const retentionCutoff = (now: Date, months: number) => {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
};

export async function runWhatsAppMessagesMaintenance(now = new Date(), db: MaintenanceDb = defaultPrisma, months = env.whatsappMessagesRetentionMonths) {
  if (!Number.isSafeInteger(months) || months < 1) throw new Error("whatsapp_retention_months_invalid");
  const expired = await db.communicationConversation.deleteMany({
    where: {
      provider: EVOLUTION_PROVIDER,
      clientId: null,
      linkStatus: { in: ["unlinked", "ambiguous"] },
      unlinkedExpiresAt: { lte: now }
    }
  });
  const cutoff = retentionCutoff(now, months);
  const oldMessages = await db.communicationMessage.deleteMany({
    where: { provider: EVOLUTION_PROVIDER, providerTimestamp: { lt: cutoff } }
  });
  const emptyConversations = await db.communicationConversation.deleteMany({
    where: {
      provider: EVOLUTION_PROVIDER,
      linkStatus: "linked",
      messages: { none: {} },
      OR: [{ lastMessageAt: { lt: cutoff } }, { lastMessageAt: null, createdAt: { lt: cutoff } }]
    }
  });
  return {
    expiredUnlinkedConversations: expired.count,
    retentionMessages: oldMessages.count,
    retentionConversations: emptyConversations.count,
    retentionMonths: months
  };
}
