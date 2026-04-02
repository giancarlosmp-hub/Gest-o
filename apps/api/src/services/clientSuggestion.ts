import type { ClientAiContextPayload } from "./clientAiContext.js";
import { OpenAiRequestError, getOpenAiClient } from "./ai/openaiClient.js";
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

const extractResponseText = (response: unknown): string => {
  if (!response || typeof response !== "object") return "";

  const responseRecord = response as Record<string, unknown>;
  const outputText = responseRecord.output_text;
  if (typeof outputText === "string") return outputText;

  const output = responseRecord.output;
  if (!Array.isArray(output) || output.length === 0) return "";

  const firstOutput = output[0];
  if (!firstOutput || typeof firstOutput !== "object") return "";

  const firstOutputRecord = firstOutput as Record<string, unknown>;
  const content = firstOutputRecord.content;
  if (!Array.isArray(content) || content.length === 0) return "";

  const firstContent = content[0];
  if (!firstContent || typeof firstContent !== "object") return "";

  const firstContentRecord = firstContent as Record<string, unknown>;
  const text = firstContentRecord.text;
  return typeof text === "string" ? text : "";
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
      throw new Error("openai_invalid_json");
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
  const runtimeOpenAiEnabled = process.env.OPENAI_ENABLED === "true";
  const runtimeHasApiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  let attemptedOpenAi = false;
  let openAiClientAvailable = false;
  let openAiCallElapsedMs: number | null = null;
  let openAiHttpStatus: number | null = null;
  let openAiTimedOut = false;
  let responseTextLength = 0;
  let parseMode: ParseMode | null = null;
  let validatorAccepted: boolean | null = null;

  const finalizeSuggestion = ({
    suggestion,
    fallbackReason
  }: {
    suggestion: ClientSuggestionPayload;
    fallbackReason: string | null;
  }): ClientSuggestionPayload => {
    logApiEvent("INFO", "[ai/client-suggestion] final-result", {
      runtimeOpenAiEnabled,
      runtimeHasApiKey,
      openAiClientAvailable,
      attemptedOpenAi,
      openAiHttpStatus,
      openAiCallElapsedMs,
      openAiTimedOut,
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

  const openai = getOpenAiClient();
  openAiClientAvailable = Boolean(openai);

  if (!openai) {
    return finalizeSuggestion({
      suggestion: fallbackSuggestion,
      fallbackReason: "openai_client_unavailable"
    });
  }

  const prompt = buildSuggestionPrompt(clientContext);

  try {
    attemptedOpenAi = true;
    logApiEvent("INFO", "[ai/client-suggestion] openai-attempt-start", {
      runtimeOpenAiEnabled,
      runtimeHasApiKey
    });
    const response = await openai.responses.create(
      { input: prompt },
      8000
    );
    openAiHttpStatus = response.status;
    openAiCallElapsedMs = response.elapsedMs;
    logApiEvent("INFO", "[ai/client-suggestion] openai-attempt-end", {
      openAiHttpStatus,
      openAiCallElapsedMs
    });

    const text = extractResponseText(response.body);
    responseTextLength = text.trim().length;

    if (!text?.trim()) {
      return finalizeSuggestion({
        suggestion: fallbackSuggestion,
        fallbackReason: "openai_empty_response"
      });
    }

    const parsedResult = parseSuggestionPayload(text);
    parseMode = parsedResult.parseMode;
    const parsed = parsedResult.parsed;

    if (!parsed || typeof parsed !== "object") {
      return finalizeSuggestion({
        suggestion: fallbackSuggestion,
        fallbackReason: "openai_invalid_json_shape"
      });
    }

    const suggestionFromAi = {
      ...(parsed as Omit<ClientSuggestionPayload, "source">),
      source: "ai" as const
    };

    validatorAccepted = isClientSuggestionPayload(suggestionFromAi);
    if (!validatorAccepted) {
      return finalizeSuggestion({
        suggestion: fallbackSuggestion,
        fallbackReason: "openai_payload_validation_failed"
      });
    }

    return finalizeSuggestion({
      suggestion: suggestionFromAi,
      fallbackReason: null
    });
  } catch (error) {
    if (error instanceof OpenAiRequestError) {
      openAiCallElapsedMs = error.elapsedMs;
      openAiHttpStatus = error.status;
      openAiTimedOut = error.isTimeout;
      logApiEvent("WARN", "[ai/client-suggestion] openai-attempt-end", {
        openAiHttpStatus,
        openAiCallElapsedMs,
        openAiTimedOut,
        reason: error.message
      });
      return finalizeSuggestion({
        suggestion: fallbackSuggestion,
        fallbackReason: error.isTimeout ? "openai_request_timeout" : "openai_request_failed"
      });
    }

    if (error instanceof SyntaxError || (error instanceof Error && error.message === "openai_invalid_json")) {
      return finalizeSuggestion({
        suggestion: fallbackSuggestion,
        fallbackReason: "openai_invalid_json"
      });
    }

    return finalizeSuggestion({
      suggestion: fallbackSuggestion,
      fallbackReason: "openai_request_failed"
    });
  }
};
