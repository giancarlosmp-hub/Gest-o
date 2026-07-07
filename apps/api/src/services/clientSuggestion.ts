import type { ClientAiContextPayload } from "./clientAiContext.js";
import { aiService } from "./ai/aiService.js";
import { logApiEvent } from "../utils/logger.js";

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

const buildSuggestionPrompt = (clientContext: ClientAiContextPayload) => {
  const deterministicSuggestion = buildClientSuggestion(clientContext);

  return [
    "Você é um assistente comercial B2B e deve gerar uma sugestão de próxima abordagem para o cliente.",
    "Escreva em português do Brasil (PT-BR), com tom comercial, direto, profissional e natural (não robótico).",
    "A resposta deve ser específica ao contexto: mencione comportamento do cliente e oportunidades reais, sem frases genéricas.",
    "Foque em ação prática de venda.",
    "Regras obrigatórias por campo:",
    "- summary: deve soar como diagnóstico comercial, mencionar comportamento do cliente e evitar frases genéricas como \"cliente em acompanhamento\".",
    "- recommendation: deve indicar estratégia comercial clara, sem repetir o summary.",
    "- nextAction: deve ser objetiva, executável e começar com verbo de ação (ex.: \"Entrar em contato...\", \"Agendar visita...\", \"Enviar proposta...\").",
    "- riskLevel: deve ser coerente com o cenário, sem exagerar risco sem motivo.",
    "Restrições obrigatórias:",
    "- NÃO inventar dados.",
    "- NÃO usar termos vagos.",
    "- NÃO repetir frases entre os campos.",
    "- NÃO escrever nada fora do JSON.",
    "Retorne APENAS JSON válido, sem markdown, sem explicações, sem texto extra.",
    "Use exatamente a estrutura abaixo (sem adicionar ou remover campos):",
    '{"status":"negociacao|ativo|parado|acompanhamento","summary":"...","recommendation":"...","nextAction":"...","riskLevel":"baixo|medio|alto"}',
    "Contexto do cliente:",
    JSON.stringify(clientContext),
    "Base determinística esperada (pode refinar texto, mas mantenha estrutura e valores válidos):",
    JSON.stringify(deterministicSuggestion)
  ].join("\n");
};

type ParseMode = "direct_json" | "fenced_json" | "embedded_object";

const sanitizeJsonText = (value: string): { text: string; parseModeHint: ParseMode | null } => {
  const trimmed = value.trim();
  if (trimmed.startsWith("```")) {
    return {
      text: trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim(),
      parseModeHint: "fenced_json"
    };
  }
  return { text: trimmed, parseModeHint: null };
};

const parseSuggestionPayload = (rawText: string): { parsed: unknown; parseMode: ParseMode } => {
  const { text: sanitizedText, parseModeHint } = sanitizeJsonText(rawText);

  try {
    return {
      parsed: JSON.parse(sanitizedText) as unknown,
      parseMode: parseModeHint ?? "direct_json"
    };
  } catch {
    const objectMatch = sanitizedText.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      throw new Error("ai_invalid_json");
    }
    return {
      parsed: JSON.parse(objectMatch[0]) as unknown,
      parseMode: "embedded_object"
    };
  }
};

export const generateClientSuggestion = async (clientContext: ClientAiContextPayload): Promise<ClientSuggestionPayload> => {
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

  const prompt = buildSuggestionPrompt(clientContext);
  const result = await aiService.chat({
    system: "Você gera sugestões comerciais em JSON estrito para o CRM Demetra Agro Performance.",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });
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

    return finalizeSuggestion(suggestionFromAi);
  } catch (error) {
    fallbackReason = error instanceof SyntaxError || (error instanceof Error && error.message === "ai_invalid_json")
      ? "ai_invalid_json"
      : "ai_parse_failed";
    return finalizeSuggestion(fallbackSuggestion);
  }
};
