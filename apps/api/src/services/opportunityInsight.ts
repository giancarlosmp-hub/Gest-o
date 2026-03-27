import { OpportunityStage } from "@prisma/client";
import type { ParsedActivityObservation } from "./activityObservationParser.js";

export type OpportunityInsightRisk = "baixo" | "medio" | "alto";

export type OpportunityInsight = {
  risk: OpportunityInsightRisk;
  nextAction: string;
  message: string;
  observationInsight: ParsedActivityObservation;
};

export type OpportunityInsightInput = {
  stage: OpportunityStage;
  followUpDate?: Date | null;
  createdAt: Date;
  value?: number | null;
  lastContactAt?: Date | null;
  timelineEvents?: Array<{ createdAt: Date; type?: string }>;
  observationInsight?: ParsedActivityObservation;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HIGH_VALUE_THRESHOLD = 100000;
const STAGE_STALE_DAYS = 7;

const getDaysSinceLastInteraction = (opportunity: OpportunityInsightInput, now: Date) => {
  const eventDates = (opportunity.timelineEvents || []).map((event) => event.createdAt.getTime());
  const lastTimelineInteraction = eventDates.length ? Math.max(...eventDates) : null;
  const lastKnownInteraction = Math.max(
    opportunity.lastContactAt?.getTime() || 0,
    lastTimelineInteraction || 0,
    opportunity.createdAt.getTime()
  );

  return Math.floor((now.getTime() - lastKnownInteraction) / DAY_IN_MS);
};

const getDaysWithoutStageProgress = (opportunity: OpportunityInsightInput, now: Date) => {
  const stageChangeEvents = (opportunity.timelineEvents || [])
    .filter((event) => event.type === "mudanca_etapa")
    .map((event) => event.createdAt.getTime());

  const lastStageProgressAt = stageChangeEvents.length
    ? Math.max(...stageChangeEvents)
    : opportunity.createdAt.getTime();

  return Math.floor((now.getTime() - lastStageProgressAt) / DAY_IN_MS);
};

export const calculateOpportunityRisk = (
  opportunity: OpportunityInsightInput,
  now: Date = new Date()
): OpportunityInsightRisk => {
  if (opportunity.observationInsight?.detectedIntent === "sem_interesse") return "alto";

  const daysWithoutInteraction = getDaysSinceLastInteraction(opportunity, now);
  const hasNoRecentInteraction = daysWithoutInteraction > 10;
  const followUpOverdue = Boolean(opportunity.followUpDate && opportunity.followUpDate.getTime() < now.getTime());
  const highValueNoInteraction = Number(opportunity.value || 0) >= HIGH_VALUE_THRESHOLD && hasNoRecentInteraction;

  if (followUpOverdue || hasNoRecentInteraction || highValueNoInteraction) return "alto";
  if (getDaysWithoutStageProgress(opportunity, now) >= STAGE_STALE_DAYS) return "medio";

  return "baixo";
};

export const generateOpportunityInsight = (
  opportunity: OpportunityInsightInput,
  now: Date = new Date()
): OpportunityInsight => {
  const risk = calculateOpportunityRisk(opportunity, now);
  const observationInsight: ParsedActivityObservation = opportunity.observationInsight || {
    sentiment: "neutro",
    interestLevel: "medio",
    detectedIntent: "indefinido",
    suggestedNextAction: "Manter acompanhamento padrão da oportunidade.",
    suggestedFollowUpDays: null,
    keywords: []
  };

  if (observationInsight.detectedIntent === "sem_interesse") {
    return {
      risk: "alto",
      nextAction: "confirmar encerramento e registrar motivo",
      message: "A observação mais recente indica desinteresse. Trate a oportunidade como alto risco e valide encerramento.",
      observationInsight
    };
  }

  if (observationInsight.detectedIntent === "pediu_proposta") {
    return {
      risk,
      nextAction: "enviar proposta comercial",
      message: "A observação mais recente indica pedido de proposta. Priorize o envio com condições comerciais objetivas.",
      observationInsight
    };
  }

  if (observationInsight.detectedIntent === "negociacao_preco") {
    return {
      risk,
      nextAction: "negociar condições e ajustar proposta",
      message: "O cliente trouxe pontos de preço. Prepare alternativas de negociação para avançar o fechamento.",
      observationInsight
    };
  }

  if (observationInsight.detectedIntent === "aguardando_decisao") {
    return {
      risk,
      nextAction: "retomar em prazo curto",
      message: "O cliente está em análise interna. Programe retorno de curto prazo para não perder tração.",
      observationInsight
    };
  }

  if (observationInsight.detectedIntent === "quer_retorno") {
    const followUpWindow = observationInsight.suggestedFollowUpDays
      ? ` em ${observationInsight.suggestedFollowUpDays} dia(s)`
      : "";
    return {
      risk,
      nextAction: "agendar follow-up na janela solicitada",
      message: `A observação indica pedido de retorno${followUpWindow}. Respeite o timing combinado com o cliente.`,
      observationInsight
    };
  }

  if (risk === "alto" && opportunity.followUpDate && opportunity.followUpDate.getTime() < now.getTime()) {
    return {
      risk,
      nextAction: "realizar contato imediato",
      message: "O follow-up está vencido. Faça contato com o cliente ainda hoje para reduzir risco de perda.",
      observationInsight
    };
  }

  const daysWithoutInteraction = getDaysSinceLastInteraction(opportunity, now);
  if (risk === "alto" && daysWithoutInteraction > 10) {
    return {
      risk,
      nextAction: "reativar com prioridade",
      message: `A oportunidade está há ${daysWithoutInteraction} dias sem interação. Priorize contato imediato para evitar perda.`,
      observationInsight
    };
  }

  if (risk === "medio") {
    return {
      risk,
      nextAction: "destravar etapa atual",
      message: "A oportunidade está com etapa parada. Defina um próximo passo para voltar a avançar.",
      observationInsight
    };
  }

  if (opportunity.stage === "proposta") {
    return {
      risk,
      nextAction: "negociar fechamento",
      message: "A oportunidade está em proposta. Priorize alinhamento de condições e fechamento.",
      observationInsight
    };
  }

  if (opportunity.stage === "prospeccao") {
    return {
      risk,
      nextAction: "avançar para qualificação",
      message: "A oportunidade está em prospecção. Busque qualificar dor, potencial e prazo de compra.",
      observationInsight
    };
  }

  return {
    risk,
    nextAction: "manter acompanhamento",
    message: "A oportunidade está dentro do esperado. Mantenha o acompanhamento do plano comercial.",
    observationInsight
  };
};
