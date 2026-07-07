import { OpenAICompatibleProvider } from "./openAiCompatibleProvider.js";

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(options: { baseUrl: string; model: string; timeoutMs: number; defaultTemperature: number; defaultMaxTokens: number }) {
    super({
      providerName: "ollama",
      baseUrl: `${options.baseUrl.replace(/\/+$/, "")}/v1`,
      apiKey: "ollama",
      model: options.model,
      timeoutMs: options.timeoutMs,
      defaultTemperature: options.defaultTemperature,
      defaultMaxTokens: options.defaultMaxTokens
    });
  }
}
