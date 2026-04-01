import { env } from "../../config/env.js";

type OpenAiResponseCreatePayload = Record<string, unknown>;

export type OpenAiClient = {
  responses: {
    create: (payload: OpenAiResponseCreatePayload, timeoutMs?: number) => Promise<unknown>;
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

        if (!response.ok) {
          throw new Error(`OpenAI request failed with status ${response.status}`);
        }

        return response.json();
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
