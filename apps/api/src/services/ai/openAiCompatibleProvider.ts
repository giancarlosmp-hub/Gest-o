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

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: request.temperature ?? this.defaultTemperature,
          max_tokens: request.maxTokens ?? this.defaultMaxTokens
        })
      });
      const elapsedMs = Date.now() - startedAt;
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        throw new AiProviderError(`AI request failed with status ${response.status}`, {
          status: response.status,
          elapsedMs,
          code: `http_${response.status}`
        });
      }

      const choices = Array.isArray(body.choices) ? body.choices : [];
      const firstChoice = choices[0] as Record<string, unknown> | undefined;
      const message = firstChoice?.message as Record<string, unknown> | undefined;
      const content = typeof message?.content === "string" ? message.content : "";
      const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;

      return {
        content,
        model: this.model,
        elapsedMs,
        usage: usage
          ? {
              promptTokens: readNumber(usage.prompt_tokens),
              completionTokens: readNumber(usage.completion_tokens),
              totalTokens: readNumber(usage.total_tokens)
            }
          : undefined
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      const elapsedMs = Date.now() - startedAt;
      const isTimeout = error instanceof DOMException
        ? error.name === "TimeoutError" || error.name === "AbortError"
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AiProviderError(isTimeout ? "AI request timeout" : "AI request failed", {
        elapsedMs,
        isTimeout,
        code: isTimeout ? "timeout" : "network_error"
      });
    }
  }
}
