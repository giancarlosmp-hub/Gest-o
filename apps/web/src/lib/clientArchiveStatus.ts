import type { UserRole } from "../context/AuthContext";

// Mesmo prefixo de PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX (apps/api/src/services/portfolioCleanupArchive.ts).
const PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX = "PORTFOLIO_CLEANUP:";

type ArchivableClient = { isArchived?: unknown; archiveReason?: unknown; [key: string]: unknown };

export const isPortfolioCleanupArchivedClient = (client: ArchivableClient) =>
  client.isArchived === true && typeof client.archiveReason === "string" && client.archiveReason.startsWith(PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX);

/** Filtro "Mostrar arquivados" e reativação: só gerente e diretor. */
export const canManageArchivedClients = (role?: UserRole | string | null) => role === "gerente" || role === "diretor";

/** Selo do cliente arquivado: limpeza da carteira ou duplicado (fusão, limpeza de duplicados). */
export function clientArchiveBadgeLabel(client: ArchivableClient) {
  if (client.isArchived !== true) return null;
  return isPortfolioCleanupArchivedClient(client) ? "Arquivado (limpeza da carteira)" : "Duplicado arquivado";
}

export const canReactivateClient = (role: UserRole | string | null | undefined, client: ArchivableClient) =>
  canManageArchivedClients(role) && isPortfolioCleanupArchivedClient(client);
