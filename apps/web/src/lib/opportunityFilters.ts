// Contador do botão "Filtros (N)" de Oportunidades no celular: quantos filtros estão diferentes do padrão de "Limpar
// filtros" (status "Abertas", demais vazios). A busca fica fora da conta porque continua visível fora do botão.
export type OpportunityFilterValues = {
  status: string;
  stage: string;
  ownerSellerId: string;
  clientId: string;
  crop: string;
  season: string;
  dateFrom: string;
  dateTo: string;
  overdue: boolean;
  noResponse: boolean;
};

export const DEFAULT_OPPORTUNITY_STATUS_FILTER = "open";

// O vendedor não escolhe o responsável (o campo fica travado no próprio nome), então ele não conta para o vendedor.
export function countActiveOpportunityFilters(filters: OpportunityFilterValues, options: { countOwner: boolean }) {
  const active = [
    filters.status !== DEFAULT_OPPORTUNITY_STATUS_FILTER,
    filters.stage !== "",
    options.countOwner && filters.ownerSellerId !== "",
    filters.clientId !== "",
    filters.crop !== "",
    filters.season !== "",
    filters.dateFrom !== "",
    filters.dateTo !== "",
    filters.overdue,
    filters.noResponse
  ];
  return active.filter(Boolean).length;
}

export const mobileFiltersLabel = (activeCount: number) => (activeCount > 0 ? `Filtros (${activeCount})` : "Filtros");
