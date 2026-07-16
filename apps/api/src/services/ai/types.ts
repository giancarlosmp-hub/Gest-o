import type { ParsedActivityObservation } from "../activityObservationParser.js";
import type { OpportunityInsight as DeterministicOpportunityInsight } from "../opportunityInsight.js";
import type { ClientSummaryOutput } from "../clientSummary.js";
import type { CommercialPriorityColor, CommercialPriorityLevel } from "../commercialPriorityService.js";

export type ObservationInsight = ParsedActivityObservation;
export type OpportunityInsight = DeterministicOpportunityInsight;
export type ClientSummaryInsight = ClientSummaryOutput;

export type TodayPriorityRisk = "alto" | "medio" | "baixo";
export type CommercialTemperature = "quente" | "morna" | "fria";

export type TodayPriorityItem = {
  opportunityId: string;
  clientId?: string | null;
  clientName: string;
  title?: string;
  value: number;
  priorityScore: number;
  risk: TodayPriorityRisk;
  reason: string;
  suggestedAction: string;
  intention?: string;
  commercialTemperature?: CommercialTemperature;
  priorityLevel: CommercialPriorityLevel;
  priorityColor: CommercialPriorityColor;
  priorityReasons: string[];
};
