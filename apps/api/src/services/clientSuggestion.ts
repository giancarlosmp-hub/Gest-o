import type { ClientAiContext } from "./clientAiContext.js";

export type ClientSuggestionStatus = "negociacao" | "ativo" | "parado" | "acompanhamento";
export type ClientSuggestionRisk = "baixo" | "medio" | "alto";

export type ClientSuggestion = {
  source: "deterministic";
  status: ClientSuggestionStatus;
  summary: string;
  recommendation: string;
  nextAction: string;
  riskLevel: ClientSuggestionRisk;
};

const MS_IN_DAY = 1000 * 60 * 60 * 24;

const daysSince = (value: Date | null, now: Date) => {
  if (!value) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - value.getTime()) / MS_IN_DAY);
};

const buildSummary = (context: ClientAiContext, status: ClientSuggestionStatus, now: Date) => {
  const parts = [
    `Cliente ${context.clientName} em status ${status}.`,
    `${context.openOpportunitiesCount} oportunidade(s) aberta(s).`
  ];

  const daysFromActivity = daysSince(context.lastActivityAt, now);
  if (Number.isFinite(daysFromActivity)) {
    parts.push(`Última atividade há ${daysFromActivity} dia(s).`);
  }

  if (context.latestObservation) {
    parts.push(`Observação recente: ${context.latestObservation}.`);
  }

  return parts.join(" ");
};

export const buildClientSuggestion = (clientContext: ClientAiContext, now = new Date()): ClientSuggestion => {
  const lastActivityDays = daysSince(clientContext.lastActivityAt, now);
  const lastPurchaseDays = daysSince(clientContext.lastPurchaseDate, now);

  if (clientContext.openOpportunitiesCount > 0) {
    return {
      source: "deterministic",
      status: "negociacao",
      summary: buildSummary(clientContext, "negociacao", now),
      recommendation: "Focar no fechamento das negociações abertas",
      nextAction: "Priorizar follow-up das oportunidades em aberto",
      riskLevel: lastActivityDays > 30 ? "alto" : "medio"
    };
  }

  if (lastPurchaseDays < 60) {
    return {
      source: "deterministic",
      status: "ativo",
      summary: buildSummary(clientContext, "ativo", now),
      recommendation: "Manter acompanhamento próximo",
      nextAction: "Reforçar presença e identificar nova demanda",
      riskLevel: "baixo"
    };
  }

  if (clientContext.openOpportunitiesCount === 0 && lastActivityDays > 30) {
    return {
      source: "deterministic",
      status: "parado",
      summary: buildSummary(clientContext, "parado", now),
      recommendation: "Retomar contato comercial",
      nextAction: "Agendar contato ou visita",
      riskLevel: "alto"
    };
  }

  return {
    source: "deterministic",
    status: "acompanhamento",
    summary: buildSummary(clientContext, "acompanhamento", now),
    recommendation: "Manter acompanhamento comercial",
    nextAction: "Registrar próximo passo do cliente",
    riskLevel: "medio"
  };
};
