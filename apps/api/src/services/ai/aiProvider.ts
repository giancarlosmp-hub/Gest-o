export type AiChatMessageRole = "system" | "user" | "assistant";

export interface AiChatRequest {
  system?: string;
  messages: {
    role: AiChatMessageRole;
    content: string;
  }[];
  temperature?: number;
  maxTokens?: number;
}

export interface AiChatResponse {
  content: string;
  model: string;
  elapsedMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export type AiProviderStatus = {
  provider: string;
  model: string;
  configured: boolean;
  mode: string;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly mode: string;
  chat(request: AiChatRequest): Promise<AiChatResponse>;
  getStatus(): AiProviderStatus;
}

export class AiProviderError extends Error {
  status: number | null;
  elapsedMs: number;
  isTimeout: boolean;
  code: string;

  constructor(message: string, options: { status?: number | null; elapsedMs: number; isTimeout?: boolean; code?: string }) {
    super(message);
    this.name = "AiProviderError";
    this.status = options.status ?? null;
    this.elapsedMs = options.elapsedMs;
    this.isTimeout = options.isTimeout ?? false;
    this.code = options.code ?? "ai_provider_error";
  }
}

export const estimateAiUsage = (value: string) => Math.ceil(value.length / 4);
