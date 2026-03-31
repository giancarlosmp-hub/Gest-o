type OpenAiResponsesClient = {
  createResponse: (input: { model: string; prompt: string; timeoutMs: number }) => Promise<string>;
};

const OPENAI_API_BASE_URL = "https://api.openai.com/v1/responses";

const isOpenAiEnabled = () => process.env.OPENAI_ENABLED === "true";

const getOpenAiApiKey = () => process.env.OPENAI_API_KEY?.trim() || "";

export const getOpenAiClient = (): OpenAiResponsesClient | null => {
  if (!isOpenAiEnabled()) return null;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  return {
    createResponse: async ({ model, prompt, timeoutMs }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(OPENAI_API_BASE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            input: prompt
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`OpenAI request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as { output_text?: unknown };
        if (typeof payload.output_text !== "string") {
          throw new Error("OpenAI payload inválido");
        }

        return payload.output_text;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
};
