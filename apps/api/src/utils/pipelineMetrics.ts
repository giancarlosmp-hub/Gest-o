import type { OpportunityStage } from "@prisma/client";

const CLOSED_STAGES = new Set<OpportunityStage>(["ganho", "perdido"]);

export const isClosedStage = (stage: OpportunityStage | string) => CLOSED_STAGES.has(stage as OpportunityStage);

export const getWeightedValue = (value: number, probability?: number | null) => value * ((probability ?? 0) / 100);

export const isOpportunityOverdue = (
  opportunity: { stage: OpportunityStage | string; followUpDate: Date },
  todayStart: Date
) => !isClosedStage(opportunity.stage) && opportunity.followUpDate < todayStart;

export const calculatePipelineMetrics = (
  opportunities: Array<{ value: number; probability?: number | null; stage: OpportunityStage | string; followUpDate: Date }>,
  todayStart: Date
) => opportunities.reduce((acc, opportunity) => {
  const weighted = getWeightedValue(opportunity.value, opportunity.probability);
  const overdue = isOpportunityOverdue(opportunity, todayStart);
  return {
    pipelineTotal: acc.pipelineTotal + opportunity.value,
    weightedTotal: acc.weightedTotal + weighted,
    overdueCount: acc.overdueCount + (overdue ? 1 : 0),
    overdueValue: acc.overdueValue + (overdue ? opportunity.value : 0)
  };
}, { pipelineTotal: 0, weightedTotal: 0, overdueCount: 0, overdueValue: 0 });
