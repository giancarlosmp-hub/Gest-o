import { OpportunityStage } from "@prisma/client";

export type OpportunityInsightRisk = "baixo" | "medio" | "alto";

export type OpportunityInsight = {
  risk: OpportunityInsightRisk;
  nextAction: string;
  message: string;
};

export type OpportunityInsightInput = {
  stage: OpportunityStage;
  followUpDate: Date;
  createdAt: Date;
  lastContactAt?: Date | null;
  timelineEvents?: Array<{ createdAt: Date }>;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

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

export const generateOpportunityInsight = (
  opportunity: OpportunityInsightInput,
  now: Date = new Date()
): OpportunityInsight => {
  if (opportunity.followUpDate.getTime() < now.getTime()) {
    return {
      risk: "alto",
      nextAction: "realizar contato imediato",
      message: "O follow-up está vencido. Faça contato com o cliente ainda hoje para reduzir risco de perda."
    };
  }

  const daysWithoutInteraction = getDaysSinceLastInteraction(opportunity, now);
  if (daysWithoutInteraction > 7) {
    return {
      risk: "medio",
      nextAction: "retomar contato",
      message: `A oportunidade está há ${daysWithoutInteraction} dias sem interação. Retome o contato para manter o avanço.`
    };
  }

  if (opportunity.stage === "proposta") {
    return {
      risk: "baixo",
      nextAction: "negociar fechamento",
      message: "A oportunidade está em proposta. Priorize alinhamento de condições e fechamento."
    };
  }

  if (opportunity.stage === "prospeccao") {
    return {
      risk: "baixo",
      nextAction: "avançar para qualificação",
      message: "A oportunidade está em prospecção. Busque qualificar dor, potencial e prazo de compra."
    };
  }

  return {
    risk: "baixo",
    nextAction: "manter acompanhamento",
    message: "A oportunidade está dentro do esperado. Mantenha o acompanhamento do plano comercial."
  };
};
