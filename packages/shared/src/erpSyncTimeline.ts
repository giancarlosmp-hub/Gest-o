/**
 * Eventos da linha do tempo gravados pela sincronização ou pelo saneamento do ERP (UltraFV3), não por um
 * usuário. O TimelineEvent guarda o dono do cliente em ownerSellerId (campo obrigatório), então a tela
 * reconhece esses eventos pelo texto e mostra "Sistema (sincronização ERP)" como autor.
 *
 * Os textos são conferidos contra o código que os grava (teste de contrato na API). O script
 * simulateClientPortfolioCleanup.ts tem a própria cópia (autocontido) e o teste confere que ela contém
 * todos estes padrões.
 */
export const ERP_SYNC_TIMELINE_PATTERNS: readonly RegExp[] = [
  /^Cliente atualizado via UltraFV3\. Vendedor alterado de /,
  /^Cadastro duplicado .* fundido ao cliente principal via sincronização UltraFV3\./,
  /^Duplicado arquivado automaticamente via UltraFV3: /,
  /^Tenant comprovado e adotado por sincronização UltraFV3 autenticada\./,
  /^Cliente reativado automaticamente pela sincronização UltraFV3 /,
  /^Cliente reativado automaticamente por nova compra no ERP/,
  /^Cliente reativado automaticamente: o ERP voltou a indicar cliente da carteira/,
  /^Duplicado legado arquivado automaticamente pelo saneamento UltraFV3/,
  /^Cadastro legado duplicado .* fundido ao cliente principal pelo saneamento UltraFV3\./,
];

export const ERP_SYNC_TIMELINE_AUTHOR_LABEL = "Sistema (sincronização ERP)";

export const isErpSyncTimelineEvent = (description: string | null | undefined) =>
  typeof description === "string" && ERP_SYNC_TIMELINE_PATTERNS.some((pattern) => pattern.test(description));

/** Autor exibido de um evento: sincronização do ERP, senão o usuário do evento, senão `fallback`. */
export const timelineEventAuthorLabel = (
  event: { description?: string | null; ownerSeller?: { name?: string | null } | null },
  fallback: string,
) => (isErpSyncTimelineEvent(event.description) ? ERP_SYNC_TIMELINE_AUTHOR_LABEL : event.ownerSeller?.name || fallback);
