import { AiProviderError, type AiChatRequest, type AiChatResponse, type AiProvider } from "./aiProvider.js";

type OpenAICompatibleProviderOptions = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  defaultTemperature: number;
  defaultMaxTokens: number;
};

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

const readNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const readObject = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : null);

// Parâmetros só do OpenRouter (https://openrouter.ai/docs/use-cases/reasoning-tokens): raciocínio com esforço
// baixo e fora da resposta, para não gastar o max_tokens. Provedores que não suportam um parâmetro o ignoram
// (https://openrouter.ai/docs/guides/routing/provider-selection). "none" não vai porque modelos com raciocínio
// obrigatório o recusam.
export const OPENROUTER_REASONING = { effort: "low", exclude: true } as const;

const isAbortError = (error: unknown) => error instanceof DOMException
  ? error.name === "TimeoutError" || error.name === "AbortError"
  : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const isOpenRouter = (providerName: string) => providerName.trim().toLowerCase() === "openrouter";

export class OpenAICompatibleProvider implements AiProvider {
  readonly name: string;
  readonly mode: string = "openai-compatible-chat-completions";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.providerName;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.timeoutMs = options.timeoutMs;
    this.defaultTemperature = options.defaultTemperature;
    this.defaultMaxTokens = options.defaultMaxTokens;
  }

  getStatus() {
    return {
      provider: this.name,
      model: this.model,
      configured: Boolean(this.baseUrl && this.apiKey && this.model),
      mode: this.mode
    };
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    const startedAt = Date.now();
    const messages = [
      ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
      ...request.messages
    ];

    // O orçamento de tempo do fluxo pode encurtar a chamada; nunca alongar além do AI_TIMEOUT_MS.
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, request.timeoutMs ?? this.timeoutMs));

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        signal: AbortSignal.timeout(timeoutMs),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: request.temperature ?? this.defaultTemperature,
          max_tokens: request.maxTokens ?? this.defaultMaxTokens,
          ...(isOpenRouter(this.name)
            ? {
                reasoning: OPENROUTER_REASONING,
                ...(request.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {})
              }
            : {})
        })
      });
      // Os cabeçalhos podem chegar bem antes do corpo (o OpenRouter responde cedo e completa depois). O tempo da
      // chamada só fecha depois de ler o corpo; headersMs fica para o diagnóstico.
      const headersMs = Date.now() - startedAt;
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        // Timeout no meio do corpo sobe como timeout; antes virava resposta vazia sem finish_reason.
        if (isAbortError(error)) throw error;
        if (response.ok) {
          throw new AiProviderError("AI response body is not valid JSON", { elapsedMs: Date.now() - startedAt, code: "invalid_body" });
        }
      }
      const elapsedMs = Date.now() - startedAt;

      if (!response.ok) {
        throw new AiProviderError(`AI request failed with status ${response.status}`, {
          status: response.status,
          elapsedMs,
          code: `http_${response.status}`,
          headersMs
        });
      }

      // Erro do provedor depois de começar a responder vem com status 200 e "error" no corpo, sem choices.
      if (readObject(body.error)) {
        throw new AiProviderError("AI provider returned an error in the body", { elapsedMs, code: "provider_body_error", headersMs });
      }

      const choices = Array.isArray(body.choices) ? body.choices : [];
      const firstChoice = choices[0] as Record<string, unknown> | undefined;
      const message = firstChoice?.message as Record<string, unknown> | undefined;
      // Só o content: o raciocínio (message.reasoning, reasoning_details) nunca é lido.
      const content = typeof message?.content === "string" ? message.content : "";
      const finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined;
      const usage = readObject(body.usage);
      const completionDetails = readObject(usage?.completion_tokens_details);

      return {
        content,
        model: this.model,
        elapsedMs,
        headersMs,
        finishReason,
        usage: usage
          ? {
              promptTokens: readNumber(usage.prompt_tokens),
              completionTokens: readNumber(usage.completion_tokens),
              totalTokens: readNumber(usage.total_tokens),
              reasoningTokens: readNumber(completionDetails?.reasoning_tokens)
            }
          : undefined
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      const elapsedMs = Date.now() - startedAt;
      const isTimeout = isAbortError(error);
      throw new AiProviderError(isTimeout ? "AI request timeout" : "AI request failed", {
        elapsedMs,
        isTimeout,
        code: isTimeout ? "timeout" : "network_error"
      });
    }
  }
}
