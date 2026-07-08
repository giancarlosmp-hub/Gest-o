import { OpportunityStage } from "@prisma/client";
import { aiService, type AiService } from "./ai/index.js";
import { DEMETRA_MASTER_PROMPT } from "./ai/demetraMasterPrompt.js";
import { logApiEvent } from "../utils/logger.js";
import { resolveKnowledgeContextForAi } from "./knowledgeBaseService.js";

type OpportunityHistoryItem = {
  description: string;
  createdAt: Date;
};

export type SalesMessageOpportunityInput = {
  clientName: string | null;
  title?: string | null;
  crop: string | null;
  productOffered: string | null;
  stage: OpportunityStage;
  city?: string | null;
  state?: string | null;
  sellerName?: string | null;
  value?: number | null;
  probability?: number | null;
  notes?: string | null;
  followUpDate?: Date | null;
  lastContactAt?: Date | null;
  createdAt?: Date;
  timelineEvents?: OpportunityHistoryItem[];
  activities?: { createdAt: Date; date?: Date | null; notes?: string | null; description?: string | null; result?: string | null; product?: string | null }[];
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const normalizeHistoryText = (value: string) => value.replace(/\s+/g, " ").trim();

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const getDaysWithoutInteraction = (opportunity: SalesMessageOpportunityInput, now: Date) => {
  const lastTimelineAt = (opportunity.timelineEvents || [])
    .map((item) => item.createdAt?.getTime?.() || 0)
    .filter(Boolean);

  const lastInteractionAt = Math.max(
    opportunity.lastContactAt?.getTime() || 0,
    lastTimelineAt.length ? Math.max(...lastTimelineAt) : 0,
    opportunity.createdAt?.getTime() || 0
  );

  if (!lastInteractionAt) return null;

  const diff = Math.floor((now.getTime() - lastInteractionAt) / DAY_IN_MS);
  return diff >= 0 ? diff : 0;
};

const buildSubject = (opportunity: SalesMessageOpportunityInput) => {
  const title = opportunity.title?.trim();
  const product = opportunity.productOffered?.trim();
  const crop = opportunity.crop?.trim();

  if (title) return title;
  if (product && crop) return `${product} para ${crop}`;
  if (product) return product;
  if (crop) return `o planejamento de ${crop}`;
  return "essa oportunidade";
};

const buildHistorySnippet = (events: OpportunityHistoryItem[] = []) => {
  const cleaned = events
    .map((event) => normalizeHistoryText(event.description || ""))
    .filter(Boolean)
    .slice(0, 1);

  return cleaned[0] || null;
};

const buildInteractionContext = (daysWithoutInteraction: number | null) => {
  if (daysWithoutInteraction === null) return null;
  if (daysWithoutInteraction <= 1) return "Vi que a gente se falou recentemente";
  if (daysWithoutInteraction <= 4) return `Já faz ${daysWithoutInteraction} dias que não nos falamos`;
  return `Percebi que já tem ${daysWithoutInteraction} dias sem retorno por aqui`;
};

const buildTimingContext = (followUpDate?: Date | null, now: Date = new Date()) => {
  if (!followUpDate) return null;

  const diffDays = Math.ceil((followUpDate.getTime() - now.getTime()) / DAY_IN_MS);

  if (diffDays < 0) return "nosso retorno combinado ficou para trás";
  if (diffDays === 0) return "hoje é o dia que tínhamos combinado de retomar";
  if (diffDays <= 3) return `a janela para decidir está bem em cima (faltam ${diffDays} dia${diffDays > 1 ? "s" : ""})`;

  return null;
};

const withClientName = (name: string) => {
  const normalized = name.trim();
  return normalized ? `${capitalize(normalized)},` : "";
};

const buildProspectingMessage = (params: {
  clientName: string;
  subject: string;
  historySnippet: string | null;
  timingContext: string | null;
}) => {
  const open = `Oi ${withClientName(params.clientName)} tudo certo?`;
  const context = params.historySnippet
    ? `Fiquei lembrando do que conversamos sobre ${params.subject} (${params.historySnippet}).`
    : `Queria retomar contigo ${params.subject}.`;
  const value = params.timingContext
    ? `Te chamei porque ${params.timingContext} e vale olhar isso agora para não perder timing. 🌱`
    : "Acredito que pode fazer sentido para sua operação, principalmente pensando em custo e desempenho.";

  return `${open}\n${context}\n${value}\nVocê já conseguiu avaliar isso por aí?`;
};

const buildProposalMessage = (params: {
  clientName: string;
  subject: string;
  interactionContext: string | null;
  timingContext: string | null;
}) => {
  const context = params.interactionContext
    ? `${params.interactionContext}, e deixei sua proposta de ${params.subject} separada para alinharmos.`
    : `Separei sua proposta de ${params.subject} para fecharmos os próximos passos.`;

  const value = params.timingContext
    ? `Como ${params.timingContext}, conseguimos garantir melhor condição se alinharmos agora.`
    : "Esse é um bom momento para fechar e já deixar tudo organizado sem correria.";

  return `Fala ${params.clientName}, tudo bem?\n${context}\n${value}\nSe estiver ok para você, te envio agora o resumo final e já avançamos 👍`;
};

const buildNegotiationMessage = (params: {
  clientName: string;
  subject: string;
  interactionContext: string | null;
  timingContext: string | null;
}) => {
  const context = params.interactionContext
    ? `${params.interactionContext} e queria destravar ${params.subject} contigo.`
    : `Queria destravar ${params.subject} contigo sem enrolação.`;

  const value = params.timingContext
    ? `Como ${params.timingContext}, vale ajustarmos isso hoje para não perder a janela comercial.`
    : "Se tiver algum ponto travando (prazo, volume ou condição), me fala que ajusto contigo.";

  return `Oi ${params.clientName}!\n${context}\n${value}\nPrefere que eu te ligue rapidinho 5 min para fechar esse alinhamento? 📞`;
};

const buildFallbackMessage = (params: { clientName: string; subject: string }) =>
  `Oi ${params.clientName}, tudo bem?\nQueria retomar ${params.subject} contigo.\nSe fizer sentido, me chama que ajustamos os próximos passos por aqui 👍`;

export const generateDeterministicSalesMessage = (opportunity: SalesMessageOpportunityInput) => {
  const now = new Date();
  const clientName = opportunity.clientName?.trim() || "tudo bem";
  const subject = buildSubject(opportunity);
  const historySnippet = buildHistorySnippet(opportunity.timelineEvents || []);
  const interactionDays = getDaysWithoutInteraction(opportunity, now);
  const interactionContext = buildInteractionContext(interactionDays);
  const timingContext = buildTimingContext(opportunity.followUpDate, now);

  if (opportunity.stage === "prospeccao") {
    return buildProspectingMessage({
      clientName,
      subject,
      historySnippet,
      timingContext
    });
  }

  if (opportunity.stage === "proposta") {
    return buildProposalMessage({
      clientName,
      subject,
      interactionContext,
      timingContext
    });
  }

  if (opportunity.stage === "negociacao") {
    return buildNegotiationMessage({
      clientName,
      subject,
      interactionContext,
      timingContext
    });
  }

  return buildFallbackMessage({ clientName, subject });
};


const compactText = (value?: string | null, maxLength = 220) => {
  const normalized = normalizeHistoryText(value || "");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
};

const daysBetween = (from: Date | null | undefined, to: Date) => {
  if (!from) return null;
  const diff = Math.ceil((from.getTime() - to.getTime()) / DAY_IN_MS);
  return Number.isFinite(diff) ? diff : null;
};

const uniqueCompact = (items: (string | null | undefined)[]) => Array.from(new Set(items.map((item) => compactText(item, 80)).filter(Boolean)));

const buildKnowledgeQuery = (opportunity: SalesMessageOpportunityInput) =>
  [opportunity.clientName, opportunity.title, opportunity.crop, opportunity.productOffered, opportunity.city, opportunity.state, opportunity.notes]
    .concat((opportunity.timelineEvents || []).map((event) => event.description))
    .concat((opportunity.activities || []).flatMap((activity) => [activity.product, activity.description, activity.notes, activity.result]))
    .filter(Boolean)
    .join(" ");

const buildAiSalesMessageContext = (opportunity: SalesMessageOpportunityInput, now: Date) => {
  const latestActivity = (opportunity.activities || [])
    .slice()
    .sort((a, b) => (b.date || b.createdAt).getTime() - (a.date || a.createdAt).getTime())[0];
  const history = (opportunity.timelineEvents || [])
    .map((event) => compactText(event.description, 180))
    .filter(Boolean)
    .slice(0, 2);
  const activityTexts = latestActivity
    ? [latestActivity.notes, latestActivity.description, latestActivity.result].map((text) => compactText(text, 180)).filter(Boolean)
    : [];

  return {
    cliente: compactText(opportunity.clientName, 80) || null,
    cidade: compactText(opportunity.city, 80) || null,
    estado: compactText(opportunity.state, 20) || null,
    vendedor: compactText(opportunity.sellerName, 80) || null,
    etapaDaOportunidade: opportunity.stage,
    valor: typeof opportunity.value === "number" && Number.isFinite(opportunity.value) ? opportunity.value : null,
    probabilidade: typeof opportunity.probability === "number" && Number.isFinite(opportunity.probability) ? opportunity.probability : null,
    diasSemContato: getDaysWithoutInteraction(opportunity, now),
    diasParaRetorno: daysBetween(opportunity.followUpDate, now),
    ultimaAtividade: activityTexts[0] || null,
    ultimaObservacao: compactText(opportunity.notes, 220) || history[0] || activityTexts[1] || null,
    produtosEnvolvidos: uniqueCompact([opportunity.productOffered, opportunity.crop, latestActivity?.product]),
    resumoComercial: compactText(buildSubject(opportunity), 160),
    historicoResumido: history
  };
};

const SALES_MESSAGE_USER_INSTRUCTION = `Gere apenas uma mensagem comercial pronta para envio ao cliente.

Objetivos:
ser natural;
não parecer IA;
máximo 120 palavras;
sem markdown;
sem listas;
sem assinatura;
sem inventar informações;
utilizar apenas o contexto recebido;
estimular continuidade da negociação;
preservar relacionamento.

Evite as expressões: "Espero que esteja bem", "Passando para saber", "Gostaria de".

Retorne somente JSON válido no formato {"message":"..."}.`;

const parseAiSalesMessage = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      const message = (parsed as { message: string }).message.trim();
      return message || null;
    }
  } catch {
    return trimmed.startsWith("{") || trimmed.startsWith("[") ? null : trimmed;
  }
  return null;
};

export const generateSalesMessage = async (opportunity: SalesMessageOpportunityInput, service: AiService = aiService) => {
  const startedAt = Date.now();
  const fallbackMessage = generateDeterministicSalesMessage(opportunity);
  const now = new Date();

  const knowledgeContext = await resolveKnowledgeContextForAi(buildKnowledgeQuery(opportunity));

  const result = await service.chat({
    system: DEMETRA_MASTER_PROMPT,
    messages: [
      {
        role: "user",
        content: [SALES_MESSAGE_USER_INSTRUCTION, knowledgeContext.context, `Contexto comercial sanitizado:\n${JSON.stringify(buildAiSalesMessageContext(opportunity, now))}`].filter(Boolean).join("\n\n")
      }
    ],
    temperature: 0.35,
    maxTokens: 220
  });

  if (!result) {
    const status = service.getStatus();
    logApiEvent("INFO", "[ai/opportunity-message] fallback", {
      provider: status.provider,
      model: status.model,
      elapsedMs: Date.now() - startedAt,
      fallback: true,
      error: status.lastError || "ai_unavailable"
    });
    return fallbackMessage;
  }

  const message = parseAiSalesMessage(result.content);
  if (!message) {
    logApiEvent("WARN", "[ai/opportunity-message] fallback", {
      provider: result.provider,
      model: result.model,
      elapsedMs: result.elapsedMs,
      fallback: true,
      error: "ai_invalid_or_empty_response"
    });
    return fallbackMessage;
  }

  logApiEvent("INFO", "[ai/opportunity-message] success", {
    provider: result.provider,
    model: result.model,
    elapsedMs: result.elapsedMs,
    fallback: false,
    error: null
  });
  return message;
};
