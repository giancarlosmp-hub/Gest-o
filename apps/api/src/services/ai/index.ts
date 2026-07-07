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


export { aiService, AiService, type AiServiceStatus } from "./aiService.js";
export { type AiProvider, type AiChatRequest, type AiChatResponse, AiProviderError } from "./aiProvider.js";
export { OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";
export { OllamaProvider } from "./ollamaProvider.js";
