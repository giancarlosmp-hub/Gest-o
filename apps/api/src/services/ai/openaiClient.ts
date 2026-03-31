import { env } from "../../config/env.js";

type OpenAiResponseCreatePayload = Record<string, unknown>;

export type OpenAiClient = {
  responses: {
    create: (payload: OpenAiResponseCreatePayload) => Promise<unknown>;
  };
};

let openAiClientInstance: OpenAiClient | null | undefined;

const canInitializeOpenAiClient = () => env.openAiEnabled && Boolean(env.openAiApiKey);

const createOpenAiClient = () => {
  if (!canInitializeOpenAiClient()) return null;

  return {
    responses: {
      create: async (payload: OpenAiResponseCreatePayload) => {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.openAiApiKey}`
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
  if (openAiClientInstance !== undefined) return openAiClientInstance;

  openAiClientInstance = createOpenAiClient();
  return openAiClientInstance;
};

export const getOpenAiDefaultModel = () => env.openAiModel;
