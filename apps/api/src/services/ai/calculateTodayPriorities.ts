import { parseActivityObservation } from "../activityObservationParser.js";
import type { OpportunityInsightInput } from "../opportunityInsight.js";
import type { CommercialTemperature, TodayPriorityItem, TodayPriorityRisk } from "./types.js";
import { generateOpportunityInsight } from "../opportunityInsight.js";
import { calculateCommercialPriority, type CommercialPriorityInput, type CommercialPriorityLevel } from "../commercialPriorityService.js";
import { WORKFLOW_INACTIVE_CLIENT_ORIGIN } from "../commercialAutomationsService.js";

export type TodayPriorityInput = OpportunityInsightInput & {
  id: string;
  clientId?: string | null;
  ownerSellerId?: string | null;
  title?: string | null;
  notes?: string | null;
  client?: {
    id?: string | null;
    name?: string | null;
    lastPurchaseDate?: Date | null;
    lastPurchaseValue?: number | null;
    ownerSellerId?: string | null;
    financialProfile?: Record<string, unknown> | string | null;
    openTitlesTotal?: number | null;
    overdueTitlesTotal?: number | null;
  } | null;
  timelineEvents: Array<{
    createdAt: Date;
    description?: string | null;
  }>;
  activities: Array<{
    createdAt: Date;
    date?: Date | null;
    dueDate?: Date | null;
    notes?: string | null;
    description?: string | null;
    result?: string | null;
    done?: boolean | null;
    status?: string | null;
    completedAt?: Date | null;
  }>;
};

const mapPriorityLevelToLegacyRisk = (level: CommercialPriorityLevel): TodayPriorityRisk => {
  // priorityLevel is the official calculated priority (baixa/normal/alta/urgente).
  // risk is a legacy visual compatibility field still consumed by HomePage badges.
  // commercialTemperature remains a separate behavioral indicator from observations.
  if (level === "urgente" || level === "alta") return "alto";
  if (level === "normal") return "medio";
  return "baixo";
};

const getTime = (date?: Date | null) => date?.getTime() ?? Number.POSITIVE_INFINITY;

const getLatestObservation = (opportunity: TodayPriorityInput) => {
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

  return recentActivityDate >= recentTimelineDate
    ? recentActivityObservation
    : (recentTimelineObservation || recentActivityObservation);
};

export const buildCommercialPriorityInput = (opportunity: TodayPriorityInput, now: Date): CommercialPriorityInput => ({
  now,
  client: opportunity.client ? {
    lastPurchaseDate: opportunity.client.lastPurchaseDate,
    lastPurchaseValue: opportunity.client.lastPurchaseValue,
    ownerSellerId: opportunity.client.ownerSellerId,
    financialProfile: opportunity.client.financialProfile,
    openTitlesTotal: opportunity.client.openTitlesTotal,
    overdueTitlesTotal: opportunity.client.overdueTitlesTotal
  } : undefined,
  opportunity: {
    stage: opportunity.stage,
    value: opportunity.value,
    followUpDate: opportunity.followUpDate,
    lastContactAt: opportunity.lastContactAt,
    createdAt: opportunity.createdAt,
    notes: opportunity.notes,
    source: opportunity.notes?.includes(WORKFLOW_INACTIVE_CLIENT_ORIGIN) ? "automatic" : undefined
  },
  activities: opportunity.activities.map((activity) => ({
    date: activity.date,
    dueDate: activity.dueDate || activity.date,
    createdAt: activity.createdAt,
    completedAt: activity.completedAt,
    status: activity.status,
    done: activity.done
  })),
  timelineEvents: opportunity.timelineEvents.map((event) => ({
    createdAt: event.createdAt,
    description: event.description
  })),
  workflow: {
    clientWithoutPurchase: !opportunity.client?.lastPurchaseDate,
    automaticallyCreatedOpportunity: Boolean(opportunity.notes?.includes(WORKFLOW_INACTIVE_CLIENT_ORIGIN))
  },
  ai: {
    hasContext: Boolean(getLatestObservation(opportunity))
  }
});

export const calculateTodayPriorities = (
  openOpportunities: TodayPriorityInput[],
  todayStart: Date
): TodayPriorityItem[] => {
  const now = todayStart;

  return openOpportunities
    .map((opportunity) => {
      const latestObservation = getLatestObservation(opportunity);
      const observationInsight = parseActivityObservation(latestObservation);

      if (observationInsight.detectedIntent === "sem_interesse") {
        return null;
      }

      const priority = calculateCommercialPriority(buildCommercialPriorityInput(opportunity, now));
      const risk = mapPriorityLevelToLegacyRisk(priority.level);
      const intentLabel = observationInsight.detectedIntent.replace(/_/g, " ");
      const commercialTemperature: CommercialTemperature = observationInsight.interestLevel === "alto"
        ? "quente"
        : observationInsight.interestLevel === "baixo"
          ? "fria"
          : "morna";
      const insight = generateOpportunityInsight({
        ...opportunity,
        observationInsight
      });
      const priorityReason = priority.reasons.join("; ");
      const contextualReason = `Intenção detectada: ${intentLabel}. Temperatura comercial ${commercialTemperature}.`;

      return {
        opportunityId: opportunity.id,
        clientId: opportunity.client?.id || opportunity.clientId || null,
        clientName: opportunity.client?.name || "Cliente não informado",
        title: opportunity.title || undefined,
        value: Number(opportunity.value || 0),
        priorityScore: priority.score,
        risk,
        priorityLevel: priority.level,
        priorityColor: priority.color,
        priorityReasons: priority.reasons,
        reason: priorityReason ? `${priorityReason}. ${contextualReason}` : (insight.message || contextualReason),
        suggestedAction: priority.nextAction,
        intention: observationInsight.detectedIntent,
        commercialTemperature,
        followUpDate: opportunity.followUpDate ?? null,
        createdAt: opportunity.createdAt,
        _sort: {
          priorityScore: priority.score,
          followUpTime: getTime(opportunity.followUpDate),
          value: Number(opportunity.value || 0),
          createdAtTime: getTime(opportunity.createdAt)
        }
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      const byScore = b._sort.priorityScore - a._sort.priorityScore;
      if (byScore !== 0) return byScore;

      const byFollowUp = a._sort.followUpTime - b._sort.followUpTime;
      if (byFollowUp !== 0) return byFollowUp;

      const byValue = b._sort.value - a._sort.value;
      if (byValue !== 0) return byValue;

      return a._sort.createdAtTime - b._sort.createdAtTime;
    })
    .map(({ _sort, followUpDate, createdAt, ...item }) => item);
};

export const __todayPrioritiesTestUtils = { mapPriorityLevelToLegacyRisk };
