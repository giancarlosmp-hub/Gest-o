import { parseActivityObservation } from "../activityObservationParser.js";
import type { OpportunityInsightInput } from "../opportunityInsight.js";
import type { TodayPriorityItem, TodayPriorityRisk } from "./types.js";
import { generateOpportunityInsight } from "../opportunityInsight.js";

type TodayPriorityInput = OpportunityInsightInput & {
  id: string;
  client?: {
    name?: string | null;
  } | null;
  timelineEvents: Array<{
    createdAt: Date;
    description?: string | null;
  }>;
  activities: Array<{
    createdAt: Date;
    date?: Date | null;
    notes?: string | null;
    description?: string | null;
    result?: string | null;
  }>;
};

const TODAY_PRIORITY_RISK_WEIGHT: Record<TodayPriorityRisk, number> = {
  alto: 3,
  medio: 2,
  baixo: 1
};

const OPPORTUNITY_VALUE_HIGH = 100000;
const OPPORTUNITY_VALUE_MEDIUM = 50000;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const getOpportunityValueScore = (value: number) => {
  if (value >= OPPORTUNITY_VALUE_HIGH) return 25;
  if (value >= OPPORTUNITY_VALUE_MEDIUM) return 15;
  if (value > 0) return 8;
  return 0;
};

const getDaysWithoutInteraction = (baseDate: Date, now: Date) =>
  Math.floor((now.getTime() - baseDate.getTime()) / DAY_IN_MS);

const getTodayPriorityRiskByScore = (score: number): TodayPriorityRisk => {
  if (score >= 85) return "alto";
  if (score >= 45) return "medio";
  return "baixo";
};

export const calculateTodayPriorities = (
  openOpportunities: TodayPriorityInput[],
  todayStart: Date
): TodayPriorityItem[] => {
  const now = new Date();

  return openOpportunities
    .map((opportunity) => {
      const value = Number(opportunity.value || 0);
      const stageWeight = opportunity.stage === "proposta" || opportunity.stage === "negociacao" ? 25 : 0;
      const followUpOverdueWeight = opportunity.followUpDate && opportunity.followUpDate < todayStart ? 40 : 0;
      const valueWeight = getOpportunityValueScore(value);

      const recentTimelineObservation = opportunity.timelineEvents
        .find((event) => event.description?.trim())
        ?.description
        ?.trim();

      const recentActivityWithObservation = opportunity.activities.find((activity) => {
        const texts = [activity.notes, activity.description, activity.result].map((text) => text?.trim() || "");
        return texts.some(Boolean);
      });

      const recentActivityObservation = recentActivityWithObservation
        ? [recentActivityWithObservation.notes, recentActivityWithObservation.description, recentActivityWithObservation.result]
          .map((text) => text?.trim() || "")
          .find(Boolean) || null
        : null;

      const recentActivityDate = recentActivityWithObservation
        ? (recentActivityWithObservation.date || recentActivityWithObservation.createdAt).getTime()
        : 0;
      const recentTimelineDate = opportunity.timelineEvents.find((event) => event.description?.trim())?.createdAt.getTime() || 0;
      const latestObservation = recentActivityDate >= recentTimelineDate
        ? recentActivityObservation
        : (recentTimelineObservation || recentActivityObservation);
      const observationInsight = parseActivityObservation(latestObservation);

      if (observationInsight.detectedIntent === "sem_interesse") {
        return null;
      }

      const requestedProposalWeight = observationInsight.detectedIntent === "pediu_proposta" ? 35 : 0;
      const awaitingDecisionWeight = observationInsight.detectedIntent === "aguardando_decisao" ? 15 : 0;

      const timelineLastInteraction = opportunity.timelineEvents.length
        ? opportunity.timelineEvents[0].createdAt
        : null;
      const activityLastInteraction = recentActivityWithObservation
        ? (recentActivityWithObservation.date || recentActivityWithObservation.createdAt)
        : null;
      const candidateDates = [
        opportunity.lastContactAt,
        timelineLastInteraction,
        activityLastInteraction,
        opportunity.createdAt
      ].filter((date): date is Date => Boolean(date));
      const lastInteraction = candidateDates.reduce((latest, date) => (
        !latest || date.getTime() > latest.getTime() ? date : latest
      ), null as Date | null) || opportunity.createdAt;

      const daysWithoutInteraction = getDaysWithoutInteraction(lastInteraction, now);
      const noInteractionWeight = daysWithoutInteraction > 7 ? 30 : 0;

      const priorityScore = Math.min(
        100,
        followUpOverdueWeight +
        valueWeight +
        stageWeight +
        requestedProposalWeight +
        awaitingDecisionWeight +
        noInteractionWeight
      );
      const risk = getTodayPriorityRiskByScore(priorityScore);
      const intentLabel = observationInsight.detectedIntent.replace(/_/g, " ");
      const interestTemperature = observationInsight.interestLevel === "alto"
        ? "quente"
        : observationInsight.interestLevel === "baixo"
          ? "fria"
          : "morna";

      const reasons: string[] = [];
      if (followUpOverdueWeight) reasons.push("follow-up vencido");
      if (valueWeight >= 15) reasons.push(`oportunidade de alto valor (R$ ${value.toLocaleString("pt-BR")})`);
      if (stageWeight) reasons.push(`etapa avançada (${opportunity.stage})`);
      if (requestedProposalWeight) reasons.push("cliente pediu proposta");
      if (awaitingDecisionWeight) reasons.push("cliente aguardando decisão");
      if (noInteractionWeight) reasons.push(`sem interação há ${daysWithoutInteraction} dia(s)`);

      const suggestedAction = requestedProposalWeight
        ? "Enviar proposta hoje e confirmar recebimento."
        : followUpOverdueWeight
          ? "Fazer contato imediato para destravar a negociação."
          : awaitingDecisionWeight
            ? "Definir com o cliente uma data de decisão e próximo passo."
            : daysWithoutInteraction > 7
              ? "Reativar conversa com abordagem objetiva de valor."
              : "Executar follow-up planejado e avançar a próxima etapa.";

      const insight = generateOpportunityInsight({
        ...opportunity,
        observationInsight
      });

      return {
        opportunityId: opportunity.id,
        clientName: opportunity.client?.name || "Cliente não informado",
        value,
        priorityScore,
        risk,
        reason: reasons.length
          ? `${reasons.join("; ")}. Intenção detectada: ${intentLabel}. Temperatura comercial ${interestTemperature}.`
          : insight.message,
        suggestedAction,
        _sort: {
          priorityScore,
          riskWeight: TODAY_PRIORITY_RISK_WEIGHT[risk] || 0
        }
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      const byScore = b._sort.priorityScore - a._sort.priorityScore;
      if (byScore !== 0) return byScore;

      const byRisk = b._sort.riskWeight - a._sort.riskWeight;
      if (byRisk !== 0) return byRisk;

      const byValue = b.value - a.value;
      return byValue;
    })
    .map(({ _sort, ...item }) => item);
};
