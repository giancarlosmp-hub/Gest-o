import type { ClientSummaryContext } from "../../clientSummary.js";
import type { OpportunityInsightInput } from "../../opportunityInsight.js";
import type { ObservationInsight, OpportunityInsight, ClientSummaryInsight, TodayPriorityItem } from "../types.js";

export type TodayPrioritiesInput = (OpportunityInsightInput & {
  id: string;
  client?: {
    name?: string | null;
  } | null;
})[];

export interface CommercialIntelligenceEngine {
  parseActivityObservation(observation?: string | null): ObservationInsight;
  generateOpportunityInsight(opportunity: OpportunityInsightInput, now?: Date): OpportunityInsight;
  generateClientSummary(clientContext: ClientSummaryContext, now?: Date): ClientSummaryInsight;
  calculateTodayPriorities(openOpportunities: TodayPrioritiesInput, todayStart: Date): TodayPriorityItem[];
}
