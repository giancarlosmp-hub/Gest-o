import { env } from "../../config/env.js";
import { logApiEvent } from "../../utils/logger.js";
import { AiProviderError, estimateAiUsage, type AiChatRequest, type AiChatResponse, type AiProvider } from "./aiProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";

export type AiServiceStatus = {
  enabled: boolean;
  provider: string;
  configured: boolean;
  model: string;
  fallback: boolean;
  lastError: string | null;
  timeoutMs: number;
  mode: string;
};

export type AiServiceChatResult = AiChatResponse & { provider: string };

type AiProviderFactory = () => AiProvider;

const summarizeError = (error: unknown) => {
  if (error instanceof AiProviderError) {
    if (error.isTimeout) return "timeout";
    if (error.status) return `http_${error.status}`;
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown_error";
};

export class AiService {
  private provider: AiProvider | null = null;
  private lastError: string | null = null;
  private fallback = false;

  constructor(private readonly providerFactory?: AiProviderFactory) {}

  private createProvider() {
    if (this.providerFactory) return this.providerFactory();

    if (env.aiProvider === "ollama") {
      return new OllamaProvider({
        baseUrl: env.ollamaBaseUrl,
        model: env.ollamaModel,
        timeoutMs: env.aiTimeoutMs,
        defaultTemperature: env.aiTemperature,
        defaultMaxTokens: env.aiMaxOutputTokens
      });
    }

    return new OpenAICompatibleProvider({
      providerName: env.aiProvider || "openai-compatible",
      baseUrl: env.aiBaseUrl,
      apiKey: env.aiApiKey,
      model: env.aiModel,
      timeoutMs: env.aiTimeoutMs,
      defaultTemperature: env.aiTemperature,
      defaultMaxTokens: env.aiMaxOutputTokens
    });
  }

  private getProvider() {
    if (!this.provider) this.provider = this.createProvider();
    return this.provider;
  }

  getStatus(): AiServiceStatus {
    const provider = this.getProvider();
    const status = provider.getStatus();
    return {
      enabled: env.aiChatEnabled,
      provider: status.provider,
      configured: status.configured,
      model: status.model,
      fallback: this.fallback || !env.aiChatEnabled || !status.configured,
      lastError: this.lastError,
      timeoutMs: env.aiTimeoutMs,
      mode: status.mode
    };
  }

  async chat(request: AiChatRequest): Promise<AiServiceChatResult | null> {
    const provider = this.getProvider();
    const status = provider.getStatus();
    const requestUsageEstimate = estimateAiUsage(request.system ?? "") + request.messages.reduce((sum, message) => sum + estimateAiUsage(message.content), 0);

    if (!env.aiChatEnabled || !status.configured) {
      this.lastError = !env.aiChatEnabled ? "ai_chat_disabled" : "provider_not_configured";
      this.fallback = true;
      logApiEvent("INFO", "[AI] fallback", {
        provider: status.provider,
        model: status.model,
        fallback: true,
        error: this.lastError,
        requestUsageEstimate
      });
      return null;
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await provider.chat(request);
        this.lastError = null;
        this.fallback = false;
        logApiEvent("INFO", "[AI] chat-success", {
          provider: provider.name,
          model: provider.model,
          elapsedMs: result.elapsedMs,
          usage: result.usage?.totalTokens ?? requestUsageEstimate,
          fallback: false,
          attempt
        });
        return { ...result, provider: provider.name };
      } catch (error) {
        const summarizedError = summarizeError(error);
        this.lastError = summarizedError;
        this.fallback = true;
        logApiEvent(attempt === 1 ? "WARN" : "ERROR", "[AI] chat-failed", {
          provider: provider.name,
          model: provider.model,
          elapsedMs: error instanceof AiProviderError ? error.elapsedMs : null,
          usage: requestUsageEstimate,
          fallback: true,
          error: summarizedError,
          attempt
        });
        if (error instanceof AiProviderError && (error.isTimeout || [401, 404, 429].includes(error.status ?? 0))) break;
      }
    }

    return null;
  }
}

export const aiService = new AiService();
