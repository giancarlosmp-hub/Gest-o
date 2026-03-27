import type { ParsedActivityObservation } from "../activityObservationParser.js";
import type { OpportunityInsight as DeterministicOpportunityInsight } from "../opportunityInsight.js";
import type { ClientSummaryOutput } from "../clientSummary.js";

export type ObservationInsight = ParsedActivityObservation;
export type OpportunityInsight = DeterministicOpportunityInsight;
export type ClientSummaryInsight = ClientSummaryOutput;

export type TodayPriorityRisk = "alto" | "medio" | "baixo";

export type TodayPriorityItem = {
  opportunityId: string;
  clientName: string;
  value: number;
  risk: TodayPriorityRisk;
  reason: string;
};
