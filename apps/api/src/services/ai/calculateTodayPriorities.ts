import type { OpportunityInsightInput } from "../opportunityInsight.js";
import type { TodayPriorityItem, TodayPriorityRisk } from "./types.js";
import { generateOpportunityInsight } from "../opportunityInsight.js";

type TodayPriorityInput = OpportunityInsightInput & {
  id: string;
  client?: {
    name?: string | null;
  } | null;
};

const TODAY_PRIORITY_RISK_WEIGHT: Record<TodayPriorityRisk, number> = {
  alto: 3,
  medio: 2,
  baixo: 1
};

export const calculateTodayPriorities = (
  openOpportunities: TodayPriorityInput[],
  todayStart: Date
): TodayPriorityItem[] => {
  return openOpportunities
    .map((opportunity) => {
      const insight = generateOpportunityInsight(opportunity);
      const risk = insight.risk as TodayPriorityRisk;
      const isFollowUpOverdue = opportunity.followUpDate ? opportunity.followUpDate < todayStart : false;
      const overdueReason = isFollowUpOverdue ? "Follow-up vencido." : "Follow-up em dia.";

      return {
        opportunityId: opportunity.id,
        clientName: opportunity.client?.name || "Cliente não informado",
        value: Number(opportunity.value || 0),
        risk,
        reason: `${overdueReason} ${insight.message}`.trim(),
        _sort: {
          riskWeight: TODAY_PRIORITY_RISK_WEIGHT[risk] || 0,
          overdueWeight: isFollowUpOverdue ? 1 : 0,
          followUpDate: opportunity.followUpDate?.getTime() || 0
        }
      };
    })
    .sort((a, b) => {
      const byRisk = b._sort.riskWeight - a._sort.riskWeight;
      if (byRisk !== 0) return byRisk;

      const byOverdue = b._sort.overdueWeight - a._sort.overdueWeight;
      if (byOverdue !== 0) return byOverdue;

      const byValue = b.value - a.value;
      if (byValue !== 0) return byValue;

      return a._sort.followUpDate - b._sort.followUpDate;
    })
    .map(({ _sort, ...item }) => item);
};
