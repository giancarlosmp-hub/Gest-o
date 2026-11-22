import type { OpportunityStage, Prisma } from "@prisma/client";
import { CLOSED_STAGES, isPendingOrder } from "../scripts/archivePortfolioCleanup.js";

// Arquivamento manual (POST /clients/:id/archive, gerente ou diretor). O motivo grava a data, no mesmo formato da
// limpeza da carteira: "MANUAL:<data ISO>". Não apaga nada. Desarquivar volta pelo POST /clients/:id/reactivate, só
// com o evento na linha do tempo (não protege da limpeza da carteira). A sincronização de parceiros trata o motivo
// como o da limpeza: só reativa se o ERP disser que é cliente de um vendedor ativo do CRM.

export const MANUAL_ARCHIVE_REASON_PREFIX = "MANUAL:";

export const isManualArchiveReason = (reason: string | null | undefined): reason is string =>
  typeof reason === "string" && reason.startsWith(MANUAL_ARCHIVE_REASON_PREFIX);

export const buildManualArchiveReason = (archivedAt: Date) => `${MANUAL_ARCHIVE_REASON_PREFIX}${archivedAt.toISOString()}`;

export const manualArchiveDescription = (userName: string) => `Cliente arquivado por ${userName}`;
export const manualUnarchiveDescription = (userName: string) => `Cliente desarquivado por ${userName}`;

// Mesma proteção da limpeza da carteira (archivePortfolioCleanup): oportunidade aberta ou pedido pendente.
export type ManualArchiveProtection = "oportunidadeAberta" | "pedidoPendente";

const PROTECTION_LABELS: Record<ManualArchiveProtection, string> = {
  oportunidadeAberta: "oportunidade aberta",
  pedidoPendente: "pedido pendente",
};

type ProtectionDb = {
  opportunity: { count(args: { where: Prisma.OpportunityWhereInput }): Promise<number> };
  erpOrderSync: {
    findMany(args: {
      where: Prisma.ErpOrderSyncWhereInput;
      select: { status: true; operationalStatusRaw: true; orderStatus: true };
    }): Promise<Array<{ status: string; operationalStatusRaw: string | null; orderStatus: string | null }>>;
  };
};

export async function findManualArchiveProtections(db: ProtectionDb, clientId: string): Promise<ManualArchiveProtection[]> {
  const [openOpportunities, orders] = await Promise.all([
    db.opportunity.count({ where: { clientId, stage: { notIn: CLOSED_STAGES as OpportunityStage[] } } }),
    db.erpOrderSync.findMany({
      where: { opportunity: { clientId }, status: { in: ["pending", "sent"] } },
      select: { status: true, operationalStatusRaw: true, orderStatus: true },
    }),
  ]);
  const reasons: ManualArchiveProtection[] = [];
  if (openOpportunities > 0) reasons.push("oportunidadeAberta");
  if (orders.some(isPendingOrder)) reasons.push("pedidoPendente");
  return reasons;
}

export const buildManualArchiveBlockedMessage = (reasons: ManualArchiveProtection[]) =>
  `Não é possível arquivar este cliente porque há ${reasons.map((reason) => PROTECTION_LABELS[reason]).join(" e ")}. ` +
  "Encerre a oportunidade ou aguarde o pedido antes de arquivar.";
