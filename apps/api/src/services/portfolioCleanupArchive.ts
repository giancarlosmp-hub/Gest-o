// Clientes arquivados pela limpeza da carteira (script archivePortfolioCleanup). O motivo grava a data do
// arquivamento: "PORTFOLIO_CLEANUP:<data ISO>" (o Client não tem coluna própria para a data).
// Reativação automática só quando o ERP diz que é cliente da carteira: linha do /partners com IDN_CLIENTE = S
// e vendedor do ERP de um usuário ativo do CRM. A sincronização cadastral reativa quando o parceiro vem assim;
// a financeira reativa quando, além disso, a última compra (DATA_ULTFATURA) é de dia posterior ao do
// arquivamento (calendário de Brasília). Fora isso, a financeira só atualiza lastPurchaseDate.
// Funções puras: o serviço de sync busca os clientes e grava.

export const PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX = "PORTFOLIO_CLEANUP:";
export const PORTFOLIO_CLEANUP_REACTIVATION_DESCRIPTION = "Cliente reativado automaticamente por nova compra no ERP";
export const PORTFOLIO_CLEANUP_PARTNER_REACTIVATION_DESCRIPTION = "Cliente reativado automaticamente: o ERP voltou a indicar cliente da carteira";
export const PORTFOLIO_CLEANUP_REACTIVATION_AUDIT_ORIGIN = "UltraFV3 Portfolio Reactivation";
export const PORTFOLIO_CLEANUP_ARCHIVE_TIMELINE_PREFIX = "Cliente arquivado pela limpeza da carteira (regra ";
export const portfolioCleanupArchiveTimelineDescription = (rule: "a" | "b") => `${PORTFOLIO_CLEANUP_ARCHIVE_TIMELINE_PREFIX}${rule})`;
export const PORTFOLIO_CLEANUP_ARCHIVED_OPPORTUNITY_MESSAGE = "Cliente arquivado na limpeza da carteira. Peça ao gerente para reativar o cadastro.";

const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, sem horário de verão desde 2019.
const brasiliaDayKey = (date: Date) => new Date(date.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);

export const isPortfolioCleanupArchiveReason = (reason: string | null | undefined): reason is string =>
  typeof reason === "string" && reason.startsWith(PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX);

export const buildPortfolioCleanupArchiveReason = (archivedAt: Date) =>
  `${PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX}${archivedAt.toISOString()}`;

/** Data do arquivamento gravada no motivo; null se o motivo for outro ou a data não for legível. */
export function parsePortfolioCleanupArchivedAt(reason: string | null | undefined): Date | null {
  if (!isPortfolioCleanupArchiveReason(reason)) return null;
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/.exec(reason.slice(PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX.length));
  if (!match) return null;
  const date = new Date(match[0]);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Mesma leitura da sincronização financeira (new Date do texto), recusando data inválida. */
export function parseErpPurchaseDate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date;
}

export type PortfolioCleanupPurchasePlan =
  | { action: "none"; reason: "semDataDeCompra" }
  | { action: "updatePurchaseDate"; lastPurchaseDate: Date; reason: "compraNaoPosterior" | "dataDoArquivamentoIlegivel" | "naoEClienteDaCarteiraNoErp" }
  | { action: "reactivate"; lastPurchaseDate: Date; archivedAt: Date };

/**
 * O que a sincronização financeira faz com um cliente arquivado pela limpeza: grava a última compra e
 * reativa só se ela cair em dia posterior ao do arquivamento e o ERP disser que é cliente da carteira
 * (`erpPortfolioCustomer`; fornecedor que faturar não volta). Sem data legível no motivo, não reativa.
 */
export function planPortfolioCleanupPurchase(archiveReason: string, rawPurchaseDate: unknown, erpPortfolioCustomer: boolean): PortfolioCleanupPurchasePlan {
  const lastPurchaseDate = parseErpPurchaseDate(rawPurchaseDate);
  if (!lastPurchaseDate) return { action: "none", reason: "semDataDeCompra" };
  const archivedAt = parsePortfolioCleanupArchivedAt(archiveReason);
  if (!archivedAt) return { action: "updatePurchaseDate", lastPurchaseDate, reason: "dataDoArquivamentoIlegivel" };
  if (brasiliaDayKey(lastPurchaseDate) <= brasiliaDayKey(archivedAt)) return { action: "updatePurchaseDate", lastPurchaseDate, reason: "compraNaoPosterior" };
  if (!erpPortfolioCustomer) return { action: "updatePurchaseDate", lastPurchaseDate, reason: "naoEClienteDaCarteiraNoErp" };
  return { action: "reactivate", lastPurchaseDate, archivedAt };
}
