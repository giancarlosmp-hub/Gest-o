// Transcrição dos áudios do WhatsApp: provedor no formato da OpenAI (POST {baseUrl}/audio/transcriptions,
// multipart), por padrão a Groq (whisper-large-v3, plano gratuito). Só fetch, sem SDK.
// O áudio fica só em memória. Nada aqui grava log; o erro nunca traz o corpo da resposta nem o texto.

/** Vocabulário do agro para orientar o reconhecimento. Só termos genéricos, nunca dados de clientes. */
export const AGRO_VOCABULARY_PROMPT =
  "Conversa comercial do agronegócio em português do Brasil: soja, milho, trigo, feijão, sorgo, algodão, café, " +
  "sementes, cultivar, defensivo, herbicida, fungicida, inseticida, adubo, fertilizante, calcário, safra, safrinha, " +
  "plantio, colheita, hectare, alqueire, saca, tonelada, cotação, pedido, orçamento, boleto, prazo, frete.";

export const TRANSCRIPTION_LANGUAGE = "pt";
/** Texto guardado no máximo com este tamanho. */
export const MAX_TRANSCRIPT_CHARS = 8_000;

export class TranscriptionProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null
  ) {
    super(`Transcrição indisponível (${code})`);
    this.name = "TranscriptionProviderError";
  }
}

export interface TranscriptionProvider {
  readonly model: string;
  transcribe(audio: Buffer, mimetype: string | null): Promise<string>;
}

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac"
};

/** "audio/ogg; codecs=opus" → { type: "audio/ogg", extension: "ogg" }. Desconhecido: ogg (nota de voz). */
export const audioFileType = (mimetype: string | null) => {
  const type = (mimetype ?? "").split(";")[0].trim().toLowerCase();
  const extension = EXTENSIONS[type];
  return extension ? { type, extension } : { type: "audio/ogg", extension: "ogg" };
};

/** retry-after em segundos ou data HTTP; ausente ou inválido: null. */
export const parseRetryAfterMs = (value: string | null, now = Date.now()): number | null => {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

type ProviderOptions = { baseUrl: string; apiKey: string; model: string; timeoutMs?: number };

export class OpenAICompatibleTranscriptionProvider implements TranscriptionProvider {
  readonly model: string;
  private readonly url: string;

  constructor(private readonly options: ProviderOptions) {
    this.model = options.model;
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  }

  async transcribe(audio: Buffer, mimetype: string | null): Promise<string> {
    const file = audioFileType(mimetype);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: file.type }), `audio.${file.extension}`);
    form.append("model", this.model);
    form.append("language", TRANSCRIPTION_LANGUAGE);
    form.append("prompt", AGRO_VOCABULARY_PROMPT);
    form.append("response_format", "json");
    form.append("temperature", "0");

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new TranscriptionProviderError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", true);
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new TranscriptionProviderError("rate_limited", true, 429, parseRetryAfterMs(response.headers.get("retry-after")));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryable = response.status >= 500 || response.status === 408;
      throw new TranscriptionProviderError(`http_${response.status}`, retryable, response.status);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new TranscriptionProviderError("invalid_response", true, response.status);
    }
    const text = (json as { text?: unknown } | null)?.text;
    if (typeof text !== "string") throw new TranscriptionProviderError("invalid_response", true, response.status);
    return text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  }
}
