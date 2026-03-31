import type { ClientAiContextPayload } from "./clientAiContext.js";

type ClientSuggestionStatus = "negociacao" | "ativo" | "parado" | "acompanhamento";
type ClientSuggestionRiskLevel = "baixo" | "medio" | "alto";

export type ClientSuggestionPayload = {
  source: "deterministic";
  status: ClientSuggestionStatus;
  summary: string;
  recommendation: string;
  nextAction: string;
  riskLevel: ClientSuggestionRiskLevel;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const getDaysSince = (value: Date | null) => {
  if (!value) return null;
  return Math.floor((Date.now() - value.getTime()) / DAY_IN_MS);
};

const formatDatePtBr = (value: Date | null) => {
  if (!value) return "não registrada";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(value);
};

const buildSummary = (clientContext: ClientAiContextPayload) => {
  const { client, commercialSummary, latestObservation } = clientContext;
  const parts = [
    `Cliente: ${client.name}.`,
    `Oportunidades abertas: ${commercialSummary.openOpportunitiesCount}.`,
    `Última atividade: ${formatDatePtBr(commercialSummary.lastActivityAt)}.`,
    `Última compra: ${formatDatePtBr(commercialSummary.lastPurchaseDate)}.`
  ];

  if (latestObservation?.trim()) {
    parts.push(`Observação recente: ${latestObservation.trim()}.`);
  }

  return parts.join(" ");
};

export const buildClientSuggestion = (clientContext: ClientAiContextPayload): ClientSuggestionPayload => {
  const { commercialSummary } = clientContext;
  const daysSinceLastActivity = getDaysSince(commercialSummary.lastActivityAt);
  const daysSinceLastPurchase = getDaysSince(commercialSummary.lastPurchaseDate);

  if (commercialSummary.openOpportunitiesCount > 0) {
    return {
      source: "deterministic",
      status: "negociacao",
      summary: buildSummary(clientContext),
      recommendation: "Focar no fechamento das negociações abertas",
      nextAction: "Priorizar follow-up das oportunidades em aberto",
      riskLevel: daysSinceLastActivity != null && daysSinceLastActivity > 7 ? "alto" : "medio"
    };
  }

  if (daysSinceLastPurchase != null && daysSinceLastPurchase < 60) {
    return {
      source: "deterministic",
      status: "ativo",
      summary: buildSummary(clientContext),
      recommendation: "Manter acompanhamento próximo",
      nextAction: "Reforçar presença e identificar nova demanda",
      riskLevel: "baixo"
    };
  }

  if (commercialSummary.openOpportunitiesCount === 0 && daysSinceLastActivity != null && daysSinceLastActivity > 30) {
    return {
      source: "deterministic",
      status: "parado",
      summary: buildSummary(clientContext),
      recommendation: "Retomar contato comercial",
      nextAction: "Agendar contato ou visita",
      riskLevel: "alto"
    };
  }

  return {
    source: "deterministic",
    status: "acompanhamento",
    summary: buildSummary(clientContext),
    recommendation: "Manter acompanhamento comercial",
    nextAction: "Registrar próximo passo do cliente",
    riskLevel: "medio"
  };
};
