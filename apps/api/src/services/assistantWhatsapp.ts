import type { OpportunityStage } from "@prisma/client";
import { aiService, type AiService } from "./ai/aiService.js";
import { DEMETRA_MASTER_PROMPT } from "./ai/demetraMasterPrompt.js";
import type { ClientAiContextPayload } from "./clientAiContext.js";
import { logApiEvent } from "../utils/logger.js";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const compactText = (value?: string | null, maxLength = 220) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
};

const daysSince = (value: Date | null | undefined, now: Date) => {
  if (!value) return null;
  const diff = Math.floor((now.getTime() - value.getTime()) / DAY_IN_MS);
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
};

const formatDate = (value: Date | null | undefined) => value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(value) : null;

export type AssistantWhatsappContext = {
  nome: string;
  cidade: string | null;
  estado: string | null;
  vendedor: string | null;
  ultimaCompra: string | null;
  diasSemCompra: number | null;
  ultimaAtividade: string | null;
  ultimaOportunidade: string | null;
  etapa: OpportunityStage | null;
  resumoComercial: string;
  observacaoResumida: string | null;
  produtos: string[];
  historicoResumido: string[];
};

export const buildAssistantWhatsappContext = (
  clientContext: ClientAiContextPayload,
  sellerName: string | null = null,
  now: Date = new Date()
): AssistantWhatsappContext => {
  const latestOpportunity = clientContext.recentOpportunities[0] || null;
  const latestActivity = clientContext.recentActivities[0] || null;
  const products = Array.from(
    new Set(
      clientContext.recentActivities
        .map((activity) => compactText(activity.opportunityTitle, 80))
        .concat(clientContext.recentOpportunities.map((opportunity) => compactText(opportunity.title, 80)))
        .filter(Boolean)
    )
  ).slice(0, 5);

  return {
    nome: compactText(clientContext.client.name, 100),
    cidade: compactText(clientContext.client.city, 80) || null,
    estado: compactText(clientContext.client.state, 20) || null,
    vendedor: compactText(sellerName, 80) || null,
    ultimaCompra: formatDate(clientContext.commercialSummary.lastPurchaseDate),
    diasSemCompra: daysSince(clientContext.commercialSummary.lastPurchaseDate, now),
    ultimaAtividade: latestActivity
      ? compactText(latestActivity.description || latestActivity.notes || latestActivity.result, 180) || latestActivity.type
      : null,
    ultimaOportunidade: latestOpportunity ? compactText(latestOpportunity.title, 140) : null,
    etapa: latestOpportunity?.stage || null,
    resumoComercial: compactText(
      `${clientContext.commercialSummary.openOpportunitiesCount} oportunidade(s) aberta(s); ${clientContext.commercialSummary.totalCompletedActivities} atividade(s) concluída(s).`,
      180
    ),
    observacaoResumida: compactText(clientContext.latestObservation, 220) || null,
    produtos: products,
    historicoResumido: clientContext.recentActivities
      .map((activity) => compactText(activity.description || activity.notes || activity.result, 160))
      .filter(Boolean)
      .slice(0, 3)
  };
};

export const generateDeterministicAssistantWhatsappMessage = (context: AssistantWhatsappContext) => {
  const firstName = context.nome.split(/\s+/)[0] || context.nome;
  const topic = context.ultimaOportunidade || context.produtos[0] || "seu planejamento";
  const inactivity = context.diasSemCompra != null && context.diasSemCompra > 90 ? "Faz um tempo que não movimentamos pedidos" : "Queria retomar nosso contato";
  return `Oi ${firstName}, tudo bem? ${inactivity} e lembrei de você por aqui na Demetra. Podemos conversar rapidinho sobre ${topic} e ver se faz sentido para o momento da sua operação?`;
};

const WHATSAPP_MESSAGE_INSTRUCTION = `Gere uma mensagem curta para WhatsApp.

Objetivo:
reativar relacionamento;
estimular conversa;
não parecer IA;
máximo 100 palavras;
sem markdown;
sem emojis exagerados;
sem assinatura;
sem inventar informações;
utilizar apenas os dados recebidos.

Retorne somente JSON válido no formato {"message":"..."}.`;

const parseMessage = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
  } catch {
    return trimmed.startsWith("{") || trimmed.startsWith("[") ? null : trimmed;
  }
};

export const generateAssistantWhatsappMessage = async (context: AssistantWhatsappContext, service: AiService = aiService) => {
  const startedAt = Date.now();
  const fallbackMessage = generateDeterministicAssistantWhatsappMessage(context);
  const result = await service.chat({
    system: DEMETRA_MASTER_PROMPT,
    messages: [{ role: "user", content: `${WHATSAPP_MESSAGE_INSTRUCTION}\n\nContexto comercial sanitizado:\n${JSON.stringify(context)}` }],
    temperature: 0.35,
    maxTokens: 180
  });

  if (!result) {
    const status = service.getStatus();
    logApiEvent("INFO", "[ai/assistant-whatsapp] fallback", { provider: status.provider, model: status.model, elapsedMs: Date.now() - startedAt, fallback: true, error: status.lastError || "ai_unavailable" });
    return { message: fallbackMessage, source: "deterministic" as const, fallback: true };
  }

  const message = parseMessage(result.content);
  if (!message) {
    logApiEvent("WARN", "[ai/assistant-whatsapp] fallback", { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, fallback: true, error: "ai_invalid_or_empty_response" });
    return { message: fallbackMessage, source: "deterministic" as const, fallback: true };
  }

  logApiEvent("INFO", "[ai/assistant-whatsapp] success", { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, fallback: false, error: null });
  return { message, source: "ai" as const, fallback: false };
};
