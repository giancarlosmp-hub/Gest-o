import { WhatsAppConnectionStatus, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { evolutionWebhookEvents, isWhatsAppEvolutionConfigured, isWhatsAppEvolutionEnabled } from "../whatsappConnection/config.js";
import { createEvolutionClient, EvolutionUnavailableError, type EvolutionClient } from "../whatsappConnection/evolutionClient.js";

// WhatsApp Fase B: as instâncias conectadas na Fase A assinam só CONNECTION_UPDATE. Aqui cada instância
// CONNECTED recebe a lista de eventos das flags atuais (com mensagens quando a Fase B está ligada; só
// conexão quando não está), pelo POST /webhook/set do Evolution, sem novo QR. A lista é sempre explícita.
// Roda na subida da API, uma vez por dia e na consulta do próprio status (uma vez por processo e lista).

const applied = new Map<string, string>();

type SubscriptionDeps = {
  db?: Pick<PrismaClient, "whatsAppConnection">;
  clientFactory?: () => EvolutionClient;
  isReady?: () => boolean;
};

const ready = () => isWhatsAppEvolutionEnabled() && isWhatsAppEvolutionConfigured();

/** Ajusta uma instância; repete só quando a lista mudou desde a última vez neste processo. */
export async function ensureInstanceWebhookEvents(instanceName: string, deps: SubscriptionDeps = {}) {
  if (!(deps.isReady ?? ready)()) return "skipped" as const;
  const events = evolutionWebhookEvents();
  const signature = events.join(",");
  if (applied.get(instanceName) === signature) return "unchanged" as const;
  const result = await (deps.clientFactory ?? createEvolutionClient)().setWebhook(instanceName, events);
  if (result === "ok") applied.set(instanceName, signature);
  return result;
}

/** Todas as instâncias CONNECTED. Devolve só contagens; falha de uma instância não para as outras. */
export async function reconcileWebhookSubscriptions(deps: SubscriptionDeps = {}) {
  const counts = { instances: 0, updated: 0, unchanged: 0, notFound: 0, failed: 0, skipped: 0 };
  if (!(deps.isReady ?? ready)()) return { ...counts, skipped: 1 };
  const rows = await (deps.db ?? defaultPrisma).whatsAppConnection.findMany({
    where: { status: WhatsAppConnectionStatus.CONNECTED },
    select: { instanceName: true }
  });
  counts.instances = rows.length;
  for (const row of rows) {
    try {
      const result = await ensureInstanceWebhookEvents(row.instanceName, deps);
      if (result === "ok") counts.updated++;
      else if (result === "unchanged") counts.unchanged++;
      else if (result === "not_found") counts.notFound++;
    } catch (error) {
      if (!(error instanceof EvolutionUnavailableError)) throw error;
      counts.failed++;
    }
  }
  logApiEvent("INFO", "[whatsapp] webhook events reconciled", { events: evolutionWebhookEvents().length, ...counts });
  return counts;
}

/** Só para testes. */
export const resetAppliedWebhookEventsForTests = () => applied.clear();
