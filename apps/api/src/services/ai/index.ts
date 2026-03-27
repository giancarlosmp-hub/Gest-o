export type {
  ObservationInsight,
  OpportunityInsight,
  ClientSummaryInsight,
  TodayPriorityItem,
  TodayPriorityRisk
} from "./types.js";

export {
  createCommercialIntelligenceService,
  parseActivityObservation,
  generateOpportunityInsight,
  generateClientSummary,
  calculateTodayPriorities
} from "./commercialIntelligenceService.js";
