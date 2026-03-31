import type { ClientAiContextPayload } from "./clientAiContext.js";
import { getOpenAiClient } from "./ai/openaiClient.js";

type ClientSuggestionStatus = "negociacao" | "ativo" | "parado" | "acompanhamento";
type ClientSuggestionRiskLevel = "baixo" | "medio" | "alto";

export type ClientSuggestionPayload = {
  source: "deterministic" | "ai";
  status: ClientSuggestionStatus;
  summary: string;
  recommendation: string;
  nextAction: string;
  riskLevel: ClientSuggestionRiskLevel;
};

type AiSuggestionPayload = {
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

const OPENAI_TIMEOUT_MS = 4_000;
const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";

const summarizeRecentActivities = (clientContext: ClientAiContextPayload) =>
  clientContext.recentActivities
    .slice(0, 5)
    .map((activity, index) => {
      const eventDate = activity.date ?? activity.dueDate ?? activity.createdAt;
      const mainText = [activity.notes, activity.description, activity.result].find((value) => value?.trim())?.trim() || "sem detalhes";
      return `${index + 1}. [${activity.type}] ${eventDate.toISOString().slice(0, 10)} - ${mainText}`;
    })
    .join("\n");

const summarizeRecentOpportunities = (clientContext: ClientAiContextPayload) =>
  clientContext.recentOpportunities
    .slice(0, 5)
    .map(
      (opportunity, index) =>
        `${index + 1}. ${opportunity.title} | etapa=${opportunity.stage} | valor=${opportunity.value} | followUp=${opportunity.followUpDate.toISOString().slice(0, 10)}`
    )
    .join("\n");

const buildHybridPrompt = (clientContext: ClientAiContextPayload) => {
  const activitiesSummary = summarizeRecentActivities(clientContext) || "Nenhuma atividade recente.";
  const opportunitiesSummary = summarizeRecentOpportunities(clientContext) || "Nenhuma oportunidade recente.";
  const latestObservation = clientContext.latestObservation?.trim() || "Sem observação registrada.";

  return [
    "Você é um assistente comercial B2B para análise de cliente.",
    "Responda em português (pt-BR), em linguagem natural comercial objetiva.",
    "Use apenas os dados fornecidos, sem inventar informações.",
    "Responda SOMENTE JSON válido, sem markdown, sem comentários e sem texto fora do JSON.",
    'O JSON precisa seguir exatamente este formato: {"status":"negociacao|ativo|parado|acompanhamento","summary":"string","recommendation":"string","nextAction":"string","riskLevel":"baixo|medio|alto"}',
    "",
    `client.name: ${clientContext.client.name}`,
    `client.fantasyName: ${clientContext.client.fantasyName || "não informado"}`,
    `commercialSummary: ${JSON.stringify(clientContext.commercialSummary)}`,
    `recentActivities (resumido):\n${activitiesSummary}`,
    `recentOpportunities (resumido):\n${opportunitiesSummary}`,
    `latestObservation: ${latestObservation}`
  ].join("\n");
};

const isClientSuggestionStatus = (value: unknown): value is ClientSuggestionStatus =>
  value === "negociacao" || value === "ativo" || value === "parado" || value === "acompanhamento";

const isClientSuggestionRiskLevel = (value: unknown): value is ClientSuggestionRiskLevel =>
  value === "baixo" || value === "medio" || value === "alto";

const extractJsonObjectText = (value: string): string | null => {
  const text = value.trim();
  if (!text) return null;

  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (startIndex === -1) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (startIndex === -1) continue;
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
};

const parseAiSuggestion = (value: string): AiSuggestionPayload | null => {
  if (!value?.trim()) return null;

  const jsonText = extractJsonObjectText(value);
  if (!jsonText) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Record<string, unknown>;

  if (!isClientSuggestionStatus(payload.status)) return null;
  if (typeof payload.summary !== "string" || !payload.summary.trim()) return null;
  if (typeof payload.recommendation !== "string" || !payload.recommendation.trim()) return null;
  if (typeof payload.nextAction !== "string" || !payload.nextAction.trim()) return null;
  if (!isClientSuggestionRiskLevel(payload.riskLevel)) return null;

  return {
    status: payload.status,
    summary: payload.summary.trim(),
    recommendation: payload.recommendation.trim(),
    nextAction: payload.nextAction.trim(),
    riskLevel: payload.riskLevel
  };
};

export const buildClientSuggestionHybrid = async (
  clientContext: ClientAiContextPayload
): Promise<ClientSuggestionPayload> => {
  const openai = getOpenAiClient();

  if (!openai) {
    return buildClientSuggestion(clientContext);
  }

  try {
    const model = process.env.OPENAI_MODEL?.trim() || OPENAI_DEFAULT_MODEL;
    const prompt = buildHybridPrompt(clientContext);
    const aiRawResponse = await openai.createResponse({
      model,
      prompt,
      timeoutMs: OPENAI_TIMEOUT_MS
    });

    const aiSuggestion = parseAiSuggestion(aiRawResponse);
    if (!aiSuggestion) {
      return buildClientSuggestion(clientContext);
    }

    return {
      ...aiSuggestion,
      source: "ai"
    };
  } catch {
    return buildClientSuggestion(clientContext);
  }
};
