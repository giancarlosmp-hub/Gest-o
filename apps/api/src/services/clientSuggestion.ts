import type { ClientAiContextPayload } from "./clientAiContext.js";
import { getOpenAiClient } from "./ai/openaiClient.js";

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

const ALLOWED_STATUS: ClientSuggestionStatus[] = ["negociacao", "ativo", "parado", "acompanhamento"];
const ALLOWED_RISK_LEVEL: ClientSuggestionRiskLevel[] = ["baixo", "medio", "alto"];

const isClientSuggestionPayload = (value: unknown): value is ClientSuggestionPayload => {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<ClientSuggestionPayload>;
  return (
    candidate.source === "deterministic" &&
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
    "Gere uma sugestão comercial em JSON válido.",
    "Retorne APENAS JSON sem markdown, sem explicações.",
    "Use exatamente a estrutura abaixo:",
    '{"source":"deterministic","status":"negociacao|ativo|parado|acompanhamento","summary":"...","recommendation":"...","nextAction":"...","riskLevel":"baixo|medio|alto"}',
    "Contexto do cliente:",
    JSON.stringify(clientContext),
    "Base determinística esperada (pode refinar texto, mas mantenha estrutura e valores válidos):",
    JSON.stringify(deterministicSuggestion)
  ].join("\n");
};

export const generateClientSuggestion = async (clientContext: ClientAiContextPayload): Promise<ClientSuggestionPayload> => {
  const fallbackSuggestion = buildClientSuggestion(clientContext);
  const openai = getOpenAiClient();

  if (!openai) return fallbackSuggestion;

  const prompt = buildSuggestionPrompt(clientContext);

  try {
    const response = await openai.responses.create(
      { input: prompt },
      4000
    );

    const text =
      (response as any)?.output?.[0]?.content?.[0]?.text ||
      (response as any)?.output_text ||
      "";

    if (!text?.trim()) return fallbackSuggestion;

    const parsed = JSON.parse(text);

    if (!isClientSuggestionPayload(parsed)) return fallbackSuggestion;

    return parsed;
  } catch {
    return fallbackSuggestion;
  }
};
