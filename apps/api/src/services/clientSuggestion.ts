import { CLIENT_IN_COLLECTION_LABEL, CLIENT_IN_COLLECTION_RECOMMENDATION } from "@salesforce-pro/shared";
import { buildClientAiPromptContext, portfolioSituationLabel, type ClientAiContextPayload, type PortfolioApproach } from "./clientAiContext.js";
import { aiService } from "./ai/aiService.js";
import { getDemetraMasterPrompt } from "./ai/demetraMasterPrompt.js";
import { logApiEvent } from "../utils/logger.js";
import { resolveKnowledgeContextForAi } from "./knowledgeBaseService.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";

type ClientSuggestionStatus = "negociacao" | "ativo" | "parado" | "acompanhamento";
type ClientSuggestionRiskLevel = "baixo" | "medio" | "alto";

export type ClientSuggestionPayload = {
  source: "ai" | "deterministic";
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

const formatDatePtBr = (value: Date | null | undefined) => {
  if (!value) return "não registrada";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(value);
};

const buildSummary = (clientContext: ClientAiContextPayload) => {
  const { client, commercialSummary, latestObservation, portfolio } = clientContext;
  const parts = [
    `Cliente: ${client.name}.`,
    `Situação da carteira: ${clientContext.inCollection ? CLIENT_IN_COLLECTION_LABEL : portfolioSituationLabel(portfolio)}.`,
    `Oportunidades abertas: ${commercialSummary.openOpportunitiesCount}.`,
    `Última atividade: ${formatDatePtBr(commercialSummary.lastActivityAt)}.`,
    `Última compra: ${formatDatePtBr(portfolio.lastPurchase?.date)}.`
  ];

  if (latestObservation?.trim()) {
    parts.push(`Observação recente: ${latestObservation.trim()}.`);
  }

  return parts.join(" ");
};

// Sem negociação aberta, a sugestão segue a situação oficial da carteira (não mais limites de 60/90 dias).
const SUGGESTION_BY_APPROACH: Record<PortfolioApproach, Omit<ClientSuggestionPayload, "source" | "summary">> = {
  reativacao: {
    status: "parado",
    recommendation: "Reativar o cliente: ele parou de comprar",
    nextAction: "Ligar ou visitar para entender por que parou de comprar e apresentar uma condição de retorno",
    riskLevel: "alto"
  },
  primeiraVenda: {
    status: "acompanhamento",
    recommendation: "Buscar a primeira venda: o cliente ainda não comprou",
    nextAction: "Agendar uma visita de apresentação e levantar a necessidade da próxima safra",
    riskLevel: "medio"
  },
  recompra: {
    status: "ativo",
    recommendation: "Manutenção e recompra: o cliente está esfriando, sem comprar há mais de 9 meses",
    nextAction: "Contatar para planejar a reposição antes que o cliente fique inativo",
    riskLevel: "medio"
  },
  manutencao: {
    status: "ativo",
    recommendation: "Manter acompanhamento próximo",
    nextAction: "Reforçar presença e identificar nova demanda",
    riskLevel: "baixo"
  }
};

// Cliente em cobrança: recomendação fixa, acima da negociação aberta e da situação da carteira (nunca reativação).
const COLLECTION_SUGGESTION: Omit<ClientSuggestionPayload, "source" | "summary"> = {
  status: "acompanhamento",
  recommendation: CLIENT_IN_COLLECTION_RECOMMENDATION,
  nextAction: "Alinhar com o financeiro a regularização dos títulos vencidos antes de qualquer oferta",
  riskLevel: "alto"
};

export const buildClientSuggestion = (clientContext: ClientAiContextPayload): ClientSuggestionPayload => {
  const { commercialSummary, portfolio } = clientContext;
  const daysSinceLastActivity = getDaysSince(commercialSummary.lastActivityAt);

  if (clientContext.inCollection) {
    return { source: "deterministic", summary: buildSummary(clientContext), ...COLLECTION_SUGGESTION };
  }

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

  return { source: "deterministic", summary: buildSummary(clientContext), ...SUGGESTION_BY_APPROACH[portfolio.approach] };
};

const ALLOWED_STATUS: ClientSuggestionStatus[] = ["negociacao", "ativo", "parado", "acompanhamento"];
const ALLOWED_RISK_LEVEL: ClientSuggestionRiskLevel[] = ["baixo", "medio", "alto"];

const isClientSuggestionPayload = (value: unknown): value is ClientSuggestionPayload => {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<ClientSuggestionPayload>;
  return (
    (candidate.source === "deterministic" || candidate.source === "ai") &&
    typeof candidate.summary === "string" &&
    typeof candidate.recommendation === "string" &&
    typeof candidate.nextAction === "string" &&
    ALLOWED_STATUS.includes(candidate.status as ClientSuggestionStatus) &&
    ALLOWED_RISK_LEVEL.includes(candidate.riskLevel as ClientSuggestionRiskLevel)
  );
};

const buildKnowledgeQuery = (clientContext: ClientAiContextPayload) =>
  [
    clientContext.client.name,
    clientContext.client.city,
    clientContext.client.state,
    clientContext.latestObservation,
    ...clientContext.recentOpportunities.map((opportunity) => opportunity.title),
    ...clientContext.recentActivities.map((activity) => activity.opportunityTitle || activity.description || activity.notes)
  ]
    .filter(Boolean)
    .join(" ");

const buildSuggestionPrompt = (clientContext: ClientAiContextPayload, knowledgeContext = "") => {
  const deterministicSuggestion = buildClientSuggestion(clientContext);

  return [
    "Gere uma sugestão inteligente de próxima abordagem para o cliente, em português do Brasil (PT-BR).",
    "A resposta deve ser específica ao contexto enviado e focada em ação prática de venda.",
    "Regras por campo:",
    "- summary: diagnóstico comercial do cliente, mencionando comportamento observado no contexto.",
    "- recommendation: estratégia comercial clara, sem repetir o summary.",
    "- nextAction: ação objetiva, executável e iniciada com verbo de ação.",
    "- riskLevel: coerente com os dados disponíveis.",
    clientContext.inCollection
      ? "- Cliente em cobrança: não sugira venda, oferta nem reativação; recommendation e nextAction ficam com a base determinística."
      : "- A abordagem segue carteira.abordagem: reativação para inativo recente e ex-cliente, primeira venda para prospect, manutenção/recompra para ativo esfriando.",
    "Retorne APENAS JSON válido, sem markdown, sem explicações, sem texto extra.",
    "Use exatamente a estrutura abaixo (sem adicionar ou remover campos):",
    '{"status":"negociacao|ativo|parado|acompanhamento","summary":"...","recommendation":"...","nextAction":"...","riskLevel":"baixo|medio|alto"}',
    knowledgeContext ? knowledgeContext : null,
    "Contexto do cliente:",
    JSON.stringify(buildClientAiPromptContext(clientContext)),
    "Base determinística esperada (pode refinar texto, mas mantenha estrutura e valores válidos):",
    JSON.stringify(deterministicSuggestion)
  ].join("\n");
};

type ParseMode = "direct_json" | "fenced_json" | "embedded_json";

const parseSuggestionPayload = (rawText: string): { parsed: unknown; parseMode: ParseMode } => {
  const result = parseAiJsonObject(rawText);
  if (!result) throw new Error("ai_invalid_json");
  return { parsed: result.parsed, parseMode: result.mode };
};

export const generateClientSuggestion = async (clientContext: ClientAiContextPayload, options: { userId?: string | null } = {}): Promise<ClientSuggestionPayload> => {
  const serviceStartedAt = Date.now();
  const fallbackSuggestion = {
    ...buildClientSuggestion(clientContext),
    source: "deterministic" as const
  };
  let attemptedAi = false;
  let aiCallElapsedMs: number | null = null;
  let responseTextLength = 0;
  let parseMode: ParseMode | null = null;
  let validatorAccepted: boolean | null = null;
  let fallbackReason: string | null = null;

  const finalizeSuggestion = (suggestion: ClientSuggestionPayload): ClientSuggestionPayload => {
    const status = aiService.getStatus();
    logApiEvent("INFO", "[ai/client-suggestion] final-result", {
      provider: status.provider,
      model: status.model,
      enabled: status.enabled,
      configured: status.configured,
      fallback: status.fallback,
      attemptedAi,
      aiCallElapsedMs,
      responseTextLength,
      parseMode,
      validatorAccepted,
      source: suggestion.source,
      status: suggestion.status,
      usedFallback: fallbackReason != null,
      fallbackReason,
      elapsedMs: Date.now() - serviceStartedAt
    });

    return suggestion;
  };

  const knowledgeContext = await resolveKnowledgeContextForAi(buildKnowledgeQuery(clientContext));
  const prompt = buildSuggestionPrompt(clientContext, knowledgeContext.context);
  const result = await aiService.chat({
    system: getDemetraMasterPrompt(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 1200,
    responseFormat: "json_object"
  }, { userId: options.userId });
  attemptedAi = result != null;

  if (!result) {
    fallbackReason = aiService.getStatus().lastError ?? "ai_unavailable";
    return finalizeSuggestion(fallbackSuggestion);
  }

  aiCallElapsedMs = result.elapsedMs;
  const text = result.content;
  responseTextLength = text.trim().length;

  if (!text?.trim()) {
    fallbackReason = "ai_empty_response";
    return finalizeSuggestion(fallbackSuggestion);
  }

  try {
    const parsedResult = parseSuggestionPayload(text);
    parseMode = parsedResult.parseMode;
    const parsed = parsedResult.parsed;

    if (!parsed || typeof parsed !== "object") {
      fallbackReason = "ai_invalid_json_shape";
      return finalizeSuggestion(fallbackSuggestion);
    }

    const suggestionFromAi = {
      ...(parsed as Omit<ClientSuggestionPayload, "source">),
      source: "ai" as const
    };

    validatorAccepted = isClientSuggestionPayload(suggestionFromAi);
    if (!validatorAccepted) {
      fallbackReason = "ai_payload_validation_failed";
      return finalizeSuggestion(fallbackSuggestion);
    }

    // Em cobrança, a IA só reescreve o resumo: status, recomendação, próxima ação e risco são os fixos.
    return finalizeSuggestion(clientContext.inCollection ? { ...suggestionFromAi, ...COLLECTION_SUGGESTION } : suggestionFromAi);
  } catch (error) {
    fallbackReason = error instanceof SyntaxError || (error instanceof Error && error.message === "ai_invalid_json")
      ? "ai_invalid_json"
      : "ai_parse_failed";
    return finalizeSuggestion(fallbackSuggestion);
  }
};
