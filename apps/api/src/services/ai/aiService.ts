import { env } from "../../config/env.js";
import { logApiEvent } from "../../utils/logger.js";
import { AiProviderError, estimateAiUsage, type AiChatRequest, type AiChatResponse, type AiProvider } from "./aiProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";
import { getDemetraMasterPrompt } from "./demetraMasterPrompt.js";
import { sanitizeAiPayload } from "./aiPayloadSanitizer.js";
import { AiUsageLimiter } from "./aiUsageLimiter.js";
import { AI_MIN_CALL_MS, AI_TIMEOUT_BUDGET_REASON, currentAiFlow, recordAiCall, recordAiFallbackReason, remainingAiBudgetMs, timeAiStage } from "./aiTimeBudget.js";

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

// Quem pediu a chamada, para o teto diário por usuário. Não vai para o provedor.
export type AiChatOptions = { userId?: string | null };

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

  constructor(
    private readonly providerFactory?: AiProviderFactory,
    readonly usageLimiter: AiUsageLimiter = new AiUsageLimiter()
  ) {}

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

  async chat(request: AiChatRequest, options: AiChatOptions = {}): Promise<AiServiceChatResult | null> {
    const provider = this.getProvider();
    const status = provider.getStatus();
    // Todo pedido passa pelo filtro central antes de qualquer estimativa, log ou envio ao provedor.
    const chatRequest = sanitizeAiPayload({
      ...request,
      system: request.system ?? getDemetraMasterPrompt()
    });
    const requestUsageEstimate = estimateAiUsage(chatRequest.system ?? "") + chatRequest.messages.reduce((sum, message) => sum + estimateAiUsage(message.content), 0);

    const flow = currentAiFlow();
    // Sem resultado aproveitável: guarda o motivo para o status e para o log do fluxo.
    const giveUp = (reason: string) => {
      this.lastError = reason;
      this.fallback = true;
      recordAiFallbackReason(reason);
      return null;
    };

    if (!env.aiChatEnabled || !status.configured) {
      const reason = !env.aiChatEnabled ? "ai_chat_disabled" : "provider_not_configured";
      logApiEvent("INFO", "[AI] fallback", {
        provider: status.provider,
        model: status.model,
        flow,
        fallback: true,
        error: reason,
        requestUsageEstimate
      });
      return giveUp(reason);
    }

    // Orçamento do fluxo já gasto (ex.: segunda chamada do Assistente): nem chama o provedor nem conta no teto.
    const remainingAtStart = remainingAiBudgetMs();
    if (remainingAtStart !== null && remainingAtStart < AI_MIN_CALL_MS) {
      logApiEvent("INFO", "[AI] budget-exhausted", { provider: status.provider, model: status.model, flow, remainingMs: remainingAtStart, fallback: true, fallbackReason: AI_TIMEOUT_BUDGET_REASON });
      return giveUp(AI_TIMEOUT_BUDGET_REASON);
    }

    // Teto diário por usuário: acima dele, null sem erro (o fluxo usa o fallback determinístico). As duas
    // tentativas abaixo contam como uma chamada.
    const reservation = await timeAiStage("usage-limit", () => this.usageLimiter.reserve(options.userId));
    if (!reservation.allowed) {
      logApiEvent("INFO", "[AI] daily-limit-reached", {
        provider: status.provider,
        model: status.model,
        fallback: true,
        userId: options.userId ?? null,
        dayKey: reservation.dayKey,
        callsToday: reservation.callsToday,
        dailyLimit: reservation.limit
      });
      // O teto não é erro do provedor: não muda lastError, só o motivo do fallback no log do fluxo.
      recordAiFallbackReason("ai_daily_limit");
      return null;
    }

    let failure = "unknown_error";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remaining = remainingAiBudgetMs();
      if (remaining !== null && remaining < AI_MIN_CALL_MS) {
        failure = AI_TIMEOUT_BUDGET_REASON;
        logApiEvent("INFO", "[AI] budget-exhausted", { provider: provider.name, model: provider.model, flow, remainingMs: remaining, attempt, fallback: true, fallbackReason: AI_TIMEOUT_BUDGET_REASON });
        break;
      }
      // O orçamento só encurta a chamada quando é menor que o AI_TIMEOUT_MS.
      const budgetLimited = remaining !== null && remaining < env.aiTimeoutMs;
      try {
        const result = await provider.chat(remaining === null ? chatRequest : { ...chatRequest, timeoutMs: remaining });
        recordAiCall(result.elapsedMs);
        // Resposta cortada pelo max_tokens não é aproveitada: o fluxo usa o fallback. Não repete a chamada.
        const truncated = result.finishReason === "length";
        // Sem texto (com finish_reason nulo ou não): nada a aproveitar, fallback sem repetir.
        const empty = !truncated && !result.content.trim();
        const rejection = truncated ? "ai_truncated" : empty ? "ai_empty_response" : null;
        this.lastError = rejection;
        this.fallback = Boolean(rejection);
        const usage = result.usage?.totalTokens ?? requestUsageEstimate;
        const today = this.usageLimiter.recordUsage(options.userId, usage);
        // Só números: nunca o conteúdo enviado ou recebido.
        logApiEvent("INFO", "[AI] chat-success", {
          provider: provider.name,
          model: provider.model,
          flow,
          elapsedMs: result.elapsedMs,
          headersMs: result.headersMs ?? null,
          timeoutMs: remaining ?? env.aiTimeoutMs,
          usage,
          finishReason: result.finishReason ?? null,
          // Sem "token" no nome: o logger mascara essas chaves.
          completionUsage: result.usage?.completionTokens ?? null,
          reasoningUsage: result.usage?.reasoningTokens ?? null,
          maxOutput: chatRequest.maxTokens ?? null,
          fallback: Boolean(rejection),
          ...(rejection ? { error: rejection, fallbackReason: rejection } : {}),
          attempt,
          userId: options.userId ?? null,
          dayKey: reservation.dayKey,
          callsToday: today.callsToday,
          usageToday: today.usageToday,
          dailyLimit: reservation.limit
        });
        if (rejection) return giveUp(rejection);
        return { ...result, provider: provider.name };
      } catch (error) {
        const timedOut = error instanceof AiProviderError && error.isTimeout;
        const summarizedError = timedOut && budgetLimited ? AI_TIMEOUT_BUDGET_REASON : summarizeError(error);
        failure = summarizedError;
        this.lastError = summarizedError;
        this.fallback = true;
        if (error instanceof AiProviderError) recordAiCall(error.elapsedMs);
        logApiEvent(attempt === 1 ? "WARN" : "ERROR", "[AI] chat-failed", {
          provider: provider.name,
          model: provider.model,
          flow,
          elapsedMs: error instanceof AiProviderError ? error.elapsedMs : null,
          headersMs: error instanceof AiProviderError ? error.headersMs : null,
          timeoutMs: remaining ?? env.aiTimeoutMs,
          usage: requestUsageEstimate,
          fallback: true,
          error: summarizedError,
          fallbackReason: summarizedError,
          attempt,
          userId: options.userId ?? null,
          dayKey: reservation.dayKey,
          callsToday: reservation.callsToday,
          dailyLimit: reservation.limit
        });
        if (error instanceof AiProviderError && (error.isTimeout || [401, 404, 429].includes(error.status ?? 0))) break;
      }
    }

    return giveUp(failure);
  }
}

export const aiService = new AiService();
