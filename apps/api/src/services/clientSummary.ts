import { OpportunityStage } from "@prisma/client";
import { CLIENT_IN_COLLECTION_LABEL, CLIENT_IN_COLLECTION_RECOMMENDATION } from "@salesforce-pro/shared";
import { portfolioSituationLabel, type ClientAiPortfolio } from "./clientAiContext.js";
import { SUGGESTION_BY_APPROACH } from "./clientSuggestion.js";

export type ClientSummaryContext = {
  client: {
    name: string;
    city: string;
    state: string;
  };
  recentActivities: Array<{
    type: string;
    notes: string | null;
    done: boolean;
    dueDate: Date;
    createdAt: Date;
  }>;
  recentObservations: Array<{
    text: string;
    createdAt: Date;
  }>;
  openOpportunities: Array<{
    title: string;
    stage: OpportunityStage;
    followUpDate: Date;
    value: number;
    notes?: string | null;
    createdAt: Date;
  }>;
  lastWonOpportunity: {
    title: string;
    value: number;
    closedAt: Date | null;
    updatedAt: Date;
  } | null;
  lastContact: Date | null;
  // Situação oficial da carteira: define o momento e a abordagem sem negociação aberta, como na Sugestão inteligente.
  portfolio: ClientAiPortfolio;
  // Cliente em cobrança (clientCollection.ts): o resumo não recomenda venda nem reativação.
  inCollection?: boolean;
};

export type ClientSummaryOutput = {
  summary: string;
  profileTags: string[];
  currentMoment: string;
  recommendedApproach: string;
  lastRelevantSignals: string[];
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const toPtBrDate = (value: Date | null | undefined) => {
  if (!value) return null;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(value);
};

const toSentenceCase = (value: string) => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const withCollection = (summary: ClientSummaryOutput, inCollection?: boolean): ClientSummaryOutput =>
  inCollection
    ? {
        ...summary,
        profileTags: ["em cobrança", ...summary.profileTags.filter((tag) => tag !== "em cobrança")],
        currentMoment: "Cliente em cobrança",
        recommendedApproach: CLIENT_IN_COLLECTION_RECOMMENDATION
      }
    : summary;

export const generateClientSummary = (clientContext: ClientSummaryContext, now = new Date()): ClientSummaryOutput =>
  withCollection(buildClientSummaryOutput(clientContext, now), clientContext.inCollection);

const buildClientSummaryOutput = (clientContext: ClientSummaryContext, now: Date): ClientSummaryOutput => {
  const { client, recentActivities, recentObservations, openOpportunities, lastWonOpportunity, lastContact, portfolio } = clientContext;
  const tags = new Set<string>();
  const situation = clientContext.inCollection ? CLIENT_IN_COLLECTION_LABEL : portfolioSituationLabel(portfolio);
  const portfolioApproach = clientContext.inCollection
    ? CLIENT_IN_COLLECTION_RECOMMENDATION
    : SUGGESTION_BY_APPROACH[portfolio.approach].recommendation;
  const lastPurchaseLabel = toPtBrDate(portfolio.lastPurchase?.date);
  const portfolioSignal = `Situação da carteira: ${situation}.${lastPurchaseLabel && !clientContext.inCollection ? ` Última compra em ${lastPurchaseLabel}.` : ""}`;

  const observationTexts = recentObservations.map((item) => normalizeText(item.text));
  const observationsJoined = observationTexts.join(" ");

  const proposalMentions = observationTexts.filter((text) => text.includes("proposta") || text.includes("orcamento")).length;
  if (proposalMentions >= 2) tags.add("interesse em proposta");

  if (
    observationsJoined.includes("preco") ||
    observationsJoined.includes("caro") ||
    observationsJoined.includes("desconto")
  ) {
    tags.add("sensível a preço");
  }

  const hasOverdueFollowUp = openOpportunities.some((opportunity) => opportunity.followUpDate.getTime() < now.getTime());
  if (hasOverdueFollowUp) tags.add("retorno pendente");

  const hasHotOpportunity = openOpportunities.some((opportunity) =>
    opportunity.stage === OpportunityStage.proposta || opportunity.stage === OpportunityStage.negociacao
  );
  if (hasHotOpportunity) tags.add("cliente aquecido");

  const hasAnyHistory =
    recentActivities.length > 0 || recentObservations.length > 0 || openOpportunities.length > 0 || Boolean(lastWonOpportunity);

  if (!hasAnyHistory) {
    return {
      summary: `${client.name} (${client.city}/${client.state}): ${situation}. Sem atividades, observações ou oportunidades recentes no CRM.
Abordagem: ${portfolioApproach}.`,
      profileTags: [],
      currentMoment: situation,
      recommendedApproach: portfolioApproach,
      lastRelevantSignals: [portfolioSignal, "Sem atividades, observações ou oportunidades recentes para este cliente."]
    };
  }

  const signals: string[] = [portfolioSignal];

  if (lastContact) {
    const daysSinceLastContact = Math.floor((now.getTime() - lastContact.getTime()) / DAY_IN_MS);
    if (daysSinceLastContact <= 1) {
      signals.push(`Último contato recente em ${toPtBrDate(lastContact)}.`);
    } else {
      signals.push(`Último contato há ${daysSinceLastContact} dias (${toPtBrDate(lastContact)}).`);
    }
  } else {
    signals.push("Sem data explícita de último contato registrada.");
  }

  if (openOpportunities.length > 0) {
    const openStages = openOpportunities.map((item) => item.stage);
    const stagesSummary = Array.from(new Set(openStages)).join(", ");
    signals.push(`${openOpportunities.length} oportunidade(s) aberta(s), com etapas em ${stagesSummary}.`);

    if (hasOverdueFollowUp) {
      const overdueCount = openOpportunities.filter((item) => item.followUpDate.getTime() < now.getTime()).length;
      signals.push(`${overdueCount} follow-up(s) vencido(s) em oportunidades abertas.`);
    }
  } else {
    signals.push("Sem oportunidades abertas no momento.");
  }

  if (lastWonOpportunity) {
    const closedDateLabel = toPtBrDate(lastWonOpportunity.closedAt || lastWonOpportunity.updatedAt);
    signals.push(`Última oportunidade ganha: ${lastWonOpportunity.title} (${closedDateLabel}).`);
  }

  const newestObservation = recentObservations[0];
  if (newestObservation) {
    const clipped = newestObservation.text.length > 120
      ? `${newestObservation.text.slice(0, 117)}...`
      : newestObservation.text;
    signals.push(`Observação recente: "${clipped}".`);
  }

  // Sem negociação aberta, momento e abordagem vêm da situação oficial da carteira.
  let currentMoment = situation;
  let recommendedApproach = portfolioApproach;

  if (hasHotOpportunity) {
    currentMoment = "cliente em fase de avaliação";
    recommendedApproach = "retomar contato com proposta objetiva";
  } else if (hasOverdueFollowUp) {
    currentMoment = "cliente com retorno pendente";
    recommendedApproach = "fazer follow-up imediato e alinhar prazo de decisão";
  } else if (openOpportunities.length > 0) {
    currentMoment = "cliente em acompanhamento";
    recommendedApproach = "manter cadência de acompanhamento com próximo passo claro";
  }

  const summaryLines = [
    `${client.name}, ${client.city}/${client.state}, possui ${openOpportunities.length} oportunidade(s) aberta(s).`,
    hasHotOpportunity
      ? "Há sinais de avanço comercial em proposta/negociação e janela para fechamento no curto prazo."
      : openOpportunities.length > 0
        ? "O momento pede manutenção de relacionamento e evolução estruturada do próximo passo."
        : `Situação da carteira: ${situation}. Abordagem: ${portfolioApproach}.`,
    hasOverdueFollowUp
      ? "Existem retornos vencidos que devem ser tratados com prioridade para evitar perda de timing."
      : "Não há follow-up vencido identificado nas oportunidades abertas.",
    lastWonOpportunity
      ? `Último ganho registrado: ${lastWonOpportunity.title}.`
      : "Ainda não há oportunidade ganha registrada para este cliente."
  ];

  return {
    summary: summaryLines.join("\n"),
    profileTags: Array.from(tags),
    currentMoment: toSentenceCase(currentMoment),
    recommendedApproach,
    lastRelevantSignals: signals.slice(0, 5)
  };
};
