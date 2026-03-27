import type { ClientSummaryContext } from "../clientSummary.js";
import type { OpportunityInsightInput } from "../opportunityInsight.js";
import { deterministicCommercialIntelligenceEngine } from "./engines/deterministicCommercialIntelligenceEngine.js";
import type { CommercialIntelligenceEngine, TodayPrioritiesInput } from "./engines/commercialIntelligenceEngine.js";

export type CommercialIntelligenceMode = "deterministic" | "hybrid";

const resolveEngine = (mode: CommercialIntelligenceMode): CommercialIntelligenceEngine => {
  switch (mode) {
    case "hybrid":
      return deterministicCommercialIntelligenceEngine;
    case "deterministic":
    default:
      return deterministicCommercialIntelligenceEngine;
  }
};

export const createCommercialIntelligenceService = (
  mode: CommercialIntelligenceMode = "deterministic"
): CommercialIntelligenceEngine => {
  return resolveEngine(mode);
};

const defaultCommercialIntelligenceService = createCommercialIntelligenceService();

export const parseActivityObservation = (observation?: string | null) =>
  defaultCommercialIntelligenceService.parseActivityObservation(observation);

export const generateOpportunityInsight = (opportunity: OpportunityInsightInput, now?: Date) =>
  defaultCommercialIntelligenceService.generateOpportunityInsight(opportunity, now);

export const generateClientSummary = (clientContext: ClientSummaryContext, now?: Date) =>
  defaultCommercialIntelligenceService.generateClientSummary(clientContext, now);

export const calculateTodayPriorities = (openOpportunities: TodayPrioritiesInput, todayStart: Date) =>
  defaultCommercialIntelligenceService.calculateTodayPriorities(openOpportunities, todayStart);
