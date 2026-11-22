import type { UserRole } from "../context/AuthContext";

// Mesmo prefixo de PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX (apps/api/src/services/portfolioCleanupArchive.ts).
const PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX = "PORTFOLIO_CLEANUP:";
// Mesmo prefixo de MANUAL_ARCHIVE_REASON_PREFIX (apps/api/src/services/clientManualArchive.ts).
const MANUAL_ARCHIVE_REASON_PREFIX = "MANUAL:";

type ArchivableClient = { isArchived?: unknown; archiveReason?: unknown; [key: string]: unknown };

const archivedWithPrefix = (client: ArchivableClient, prefix: string) =>
  client.isArchived === true && typeof client.archiveReason === "string" && client.archiveReason.startsWith(prefix);

export const isPortfolioCleanupArchivedClient = (client: ArchivableClient) => archivedWithPrefix(client, PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX);

/** Arquivado pela ação "Arquivar" (gerente ou diretor). */
export const isManualArchivedClient = (client: ArchivableClient) => archivedWithPrefix(client, MANUAL_ARCHIVE_REASON_PREFIX);

/** Arquivado que pode voltar (limpeza da carteira ou manual); duplicado arquivado não volta. */
export const isReactivatableArchivedClient = (client: ArchivableClient) =>
  isPortfolioCleanupArchivedClient(client) || isManualArchivedClient(client);

/** Filtro "Mostrar arquivados", arquivar e reativar: só gerente e diretor. */
export const canManageArchivedClients = (role?: UserRole | string | null) => role === "gerente" || role === "diretor";

/** Selo do cliente arquivado: limpeza da carteira, manual ou duplicado (fusão, limpeza de duplicados). */
export function clientArchiveBadgeLabel(client: ArchivableClient) {
  if (client.isArchived !== true) return null;
  if (isPortfolioCleanupArchivedClient(client)) return "Arquivado (limpeza da carteira)";
  if (isManualArchivedClient(client)) return "Arquivado manualmente";
  return "Duplicado arquivado";
}

/** Texto do aviso na ficha do cliente arquivado. */
export function clientArchiveNotice(client: ArchivableClient) {
  if (isPortfolioCleanupArchivedClient(client)) return "Cliente fora da carteira ativa. Não recebe oportunidade nova enquanto estiver arquivado.";
  if (isManualArchivedClient(client)) return "Cliente arquivado manualmente. Fica fora da lista e da carteira ativa e não recebe oportunidade nova enquanto estiver arquivado.";
  return "Cadastro duplicado arquivado: use o cliente principal.";
}

/** "Arquivar": gerente ou diretor, só cadastro ativo. */
export const canArchiveClient = (role: UserRole | string | null | undefined, client: ArchivableClient) =>
  canManageArchivedClients(role) && client.isArchived !== true;

/** Reativar (limpeza da carteira) ou desarquivar (manual). Duplicado arquivado não volta. */
export const canReactivateClient = (role: UserRole | string | null | undefined, client: ArchivableClient) =>
  canManageArchivedClients(role) && isReactivatableArchivedClient(client);

export const clientReactivateActionLabel = (client: ArchivableClient) => (isManualArchivedClient(client) ? "Desarquivar" : "Reativar cliente");

export const CLIENT_ARCHIVE_CONFIRM_MESSAGE =
  "Arquivar este cliente? Ele sai da lista e da carteira ativa, sem apagar o histórico. Gerente ou diretor pode desarquivar depois.";
export const CLIENT_REACTIVATE_CONFIRM_MESSAGE = "Reativar este cliente? Ele volta para a carteira ativa do vendedor responsável.";
export const CLIENT_UNARCHIVE_CONFIRM_MESSAGE = "Desarquivar este cliente? Ele volta para a carteira ativa do vendedor responsável.";

export const clientReactivateConfirmMessage = (client: ArchivableClient) =>
  isManualArchivedClient(client) ? CLIENT_UNARCHIVE_CONFIRM_MESSAGE : CLIENT_REACTIVATE_CONFIRM_MESSAGE;
