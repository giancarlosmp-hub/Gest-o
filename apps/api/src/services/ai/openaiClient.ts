import { env } from "../../config/env.js";

type OpenAiResponseCreatePayload = Record<string, unknown>;
export type OpenAiResponseCreateResult = {
  body: unknown;
  status: number;
  elapsedMs: number;
};

export class OpenAiRequestError extends Error {
  status: number | null;
  elapsedMs: number;
  isTimeout: boolean;

  constructor(message: string, options: { status?: number | null; elapsedMs: number; isTimeout?: boolean }) {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = options.status ?? null;
    this.elapsedMs = options.elapsedMs;
    this.isTimeout = options.isTimeout ?? false;
  }
}

export type OpenAiClient = {
  responses: {
    create: (payload: OpenAiResponseCreatePayload, timeoutMs?: number) => Promise<OpenAiResponseCreateResult>;
  };
};

let openAiClientInstance: OpenAiClient | null = null;

const isOpenAiEnabled = () => process.env.OPENAI_ENABLED === "true";

const getOpenAiApiKey = () => process.env.OPENAI_API_KEY?.trim() || "";

const getOpenAiUnavailableReason = () => {
  if (!isOpenAiEnabled()) return "OPENAI_ENABLED is false";
  if (!getOpenAiApiKey()) return "OPENAI_API_KEY is empty";
  return null;
};

const createOpenAiClient = () => {
  const unavailableReason = getOpenAiUnavailableReason();

  if (unavailableReason) {
    console.info("[openai] client unavailable", {
      openAiEnabled: isOpenAiEnabled(),
      hasApiKey: Boolean(getOpenAiApiKey()),
      reason: unavailableReason
    });
    return null;
  }

  const apiKey = getOpenAiApiKey();

  return {
    responses: {
      create: async (payload: OpenAiResponseCreatePayload, timeoutMs = 10_000) => {
        const startedAt = Date.now();

        try {
          const response = await fetch("https://api.openai.com/v1/responses", {
            signal: AbortSignal.timeout(timeoutMs),
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: env.openAiModel,
              ...payload
            })
          });

          const elapsedMs = Date.now() - startedAt;
          const body = await response.json();

          if (!response.ok) {
            throw new OpenAiRequestError(`OpenAI request failed with status ${response.status}`, {
              status: response.status,
              elapsedMs
            });
          }

          return {
            body,
            status: response.status,
            elapsedMs
          };
        } catch (error) {
          if (error instanceof OpenAiRequestError) {
            throw error;
          }

          const elapsedMs = Date.now() - startedAt;
          const isTimeout =
            error instanceof DOMException
              ? error.name === "TimeoutError" || error.name === "AbortError"
              : error instanceof Error && error.name === "TimeoutError";

          throw new OpenAiRequestError("OpenAI request failed", {
            elapsedMs,
            isTimeout
          });
        }
      }
    }
  } satisfies OpenAiClient;
};

export const getOpenAiClient = () => {
  if (openAiClientInstance) return openAiClientInstance;

  console.info("[openai] getOpenAiClient", {
    openAiEnabled: isOpenAiEnabled(),
    hasApiKey: Boolean(getOpenAiApiKey())
  });

  const client = createOpenAiClient();

  if (!client) return null;

  openAiClientInstance = client;
  console.info("[openai] client created (singleton)");
  return openAiClientInstance;
};

export const getOpenAiDefaultModel = () => env.openAiModel;
