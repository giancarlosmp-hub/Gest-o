import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import {
  AGRO_VOCABULARY_PROMPT,
  MAX_TRANSCRIPT_CHARS,
  OpenAICompatibleTranscriptionProvider,
  TranscriptionProviderError,
  audioFileType,
  parseRetryAfterMs
} from "./whatsappTranscriptionProvider.js";

// Provedor de transcrição (formato OpenAI, padrão Groq) contra um servidor falso em localhost. Chave, áudio e
// textos fictícios.

type Recorded = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
const recorded: Recorded[] = [];
let next: { status: number; body: string; headers?: Record<string, string>; delayMs?: number } = { status: 200, body: "{}" };

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  recorded.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
  if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
  res.writeHead(next.status, { "Content-Type": "application/json", ...(next.headers ?? {}) }).end(next.body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const provider = new OpenAICompatibleTranscriptionProvider({
  baseUrl: `http://127.0.0.1:${address.port}/openai/v1/`,
  apiKey: "chave-ficticia",
  model: "whisper-large-v3",
  timeoutMs: 300
});
const AUDIO = Buffer.from("OggS-audio-ficticio");
const respond = (status: number, body: unknown, headers?: Record<string, string>, delayMs?: number) => {
  next = { status, body: typeof body === "string" ? body : JSON.stringify(body), headers, delayMs };
};
const rejectsWith = async (code: string, retryable: boolean, extra: Partial<TranscriptionProviderError> = {}) => {
  await assert.rejects(provider.transcribe(AUDIO, "audio/ogg; codecs=opus"), (error: unknown) => {
    assert(error instanceof TranscriptionProviderError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    for (const [key, value] of Object.entries(extra)) assert.equal((error as unknown as Record<string, unknown>)[key], value);
    assert.doesNotMatch(error.message, /ficticio|chave/i, "erro sem corpo nem chave");
    return true;
  });
};

try {
  // 1) Sucesso: multipart com arquivo .ogg, modelo, pt, vocabulário do agro e chave no header.
  respond(200, { text: "  Bom dia, quero cotar dez sacas de semente ficticia.  " });
  assert.equal(await provider.transcribe(AUDIO, "audio/ogg; codecs=opus"), "Bom dia, quero cotar dez sacas de semente ficticia.");
  const sent = recorded[recorded.length - 1];
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/openai/v1/audio/transcriptions");
  assert.equal(sent.headers.authorization, "Bearer chave-ficticia");
  assert.match(String(sent.headers["content-type"]), /^multipart\/form-data; boundary=/);
  assert.match(sent.body, /name="file"; filename="audio\.ogg"\r\nContent-Type: audio\/ogg\r\n\r\nOggS-audio-ficticio/);
  assert.match(sent.body, /name="model"\r\n\r\nwhisper-large-v3\r\n/);
  assert.match(sent.body, /name="language"\r\n\r\npt\r\n/);
  assert.match(sent.body, /name="response_format"\r\n\r\njson\r\n/);
  assert(sent.body.includes(Buffer.from(AGRO_VOCABULARY_PROMPT, "utf8").toString("latin1")), "prompt de vocabulário vai junto");
  assert.doesNotMatch(AGRO_VOCABULARY_PROMPT, /\d{3}/, "o vocabulário não traz números");

  // 2) Texto longo é cortado.
  respond(200, { text: "a".repeat(MAX_TRANSCRIPT_CHARS + 50) });
  assert.equal((await provider.transcribe(AUDIO, null)).length, MAX_TRANSCRIPT_CHARS);

  // 3) 429 da Groq: pode tentar de novo e respeita retry-after.
  respond(429, { error: { message: "Rate limit reached ficticio" } }, { "retry-after": "7" });
  await rejectsWith("rate_limited", true, { status: 429, retryAfterMs: 7000 });
  respond(429, { error: { message: "limite ficticio" } });
  await rejectsWith("rate_limited", true, { retryAfterMs: null });

  // 4) Erro do provedor: 5xx tenta de novo; 4xx (chave inválida, arquivo ruim) não.
  respond(503, { error: { message: "fora do ar ficticio" } });
  await rejectsWith("http_503", true, { status: 503 });
  respond(401, { error: { message: "chave ficticia invalida" } });
  await rejectsWith("http_401", false, { status: 401 });
  respond(400, { error: { message: "arquivo ficticio invalido" } });
  await rejectsWith("http_400", false);

  // 5) Resposta inválida e timeout.
  respond(200, "não é json");
  await rejectsWith("invalid_response", true);
  respond(200, { outro: "campo" });
  await rejectsWith("invalid_response", true);
  respond(200, { text: "tarde demais" }, undefined, 600);
  await rejectsWith("timeout", true);

  // 6) Tipo do arquivo e retry-after.
  assert.deepEqual(audioFileType("audio/ogg; codecs=opus"), { type: "audio/ogg", extension: "ogg" });
  assert.deepEqual(audioFileType("audio/mp4"), { type: "audio/mp4", extension: "m4a" });
  assert.deepEqual(audioFileType("AUDIO/MPEG"), { type: "audio/mpeg", extension: "mp3" });
  assert.deepEqual(audioFileType(null), { type: "audio/ogg", extension: "ogg" });
  assert.deepEqual(audioFileType("application/octet-stream"), { type: "audio/ogg", extension: "ogg" });
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("1.5"), 1500);
  assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfterMs("depois"), null);
  assert.equal(parseRetryAfterMs(null), null);

  console.log("whatsappTranscriptionProvider.test.ts: ok");
} finally {
  server.close();
}
