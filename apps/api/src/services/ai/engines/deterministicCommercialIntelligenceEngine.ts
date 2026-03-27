import { parseActivityObservation } from "../../activityObservationParser.js";
import { generateOpportunityInsight } from "../../opportunityInsight.js";
import { generateClientSummary } from "../../clientSummary.js";
import { calculateTodayPriorities } from "../calculateTodayPriorities.js";
import type { CommercialIntelligenceEngine } from "./commercialIntelligenceEngine.js";

export const deterministicCommercialIntelligenceEngine: CommercialIntelligenceEngine = {
  parseActivityObservation,
  generateOpportunityInsight,
  generateClientSummary,
  calculateTodayPriorities
};
