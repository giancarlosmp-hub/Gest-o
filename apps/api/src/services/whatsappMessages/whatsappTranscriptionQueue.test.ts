import assert from "node:assert/strict";
import { WhatsAppMessageIngestion } from "./whatsappMessageIngestion.js";
import { createMemoryWhatsAppMessageStore } from "./whatsappMessagesTestStore.js";
import {
  INTERRUPTED_AFTER_MS,
  MAX_ATTEMPTS,
  MAX_AUDIO_BYTES,
  RETRY_DELAYS_MS,
  USAGE_KEY_PREFIX,
  WhatsAppTranscriptionQueue,
  initialTranscription,
  transcriptionOf,
  type TranscriptionJob
} from "./whatsappTranscriptionQueue.js";
import { TranscriptionProviderError, type TranscriptionProvider } from "./whatsappTranscriptionProvider.js";

// Transcrição dos áudios do WhatsApp: ingestão (estado inicial e fila) e fila em memória (download, provedor,
// 429, novas tentativas, teto diário, apagada no meio, limpeza de pendentes). Números, ids, chaves, áudios e
// textos fictícios. Os logs são capturados para conferir que não levam conteúdo.

const logs: string[] = [];
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const capture = (...args: unknown[]) => void logs.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
console.info = capture;
console.warn = capture;
console.error = capture;
const testLog = original.log;
console.log = (...args: unknown[]) => (typeof args[0] === "string" && args[0].endsWith(": ok") ? testLog(...args) : capture(...args));

const memory = createMemoryWhatsAppMessageStore();
let clock = new Date("2026-11-07T15:00:00.000Z");
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const SECRET_TEXT = "Transcricao ficticia sigilosa dez sacas";
const AUDIO_BYTES = Buffer.from("OggS-audio-ficticio");
type DownloadResult = { base64: string; mimetype: string | null } | Error;
const downloads: { instance: string; message: unknown }[] = [];
let downloadPlan: DownloadResult[] = [];
let providerPlan: (string | Error)[] = [];
const received: { bytes: string; mimetype: string | null }[] = [];
let lastBuffer: Buffer | null = null;
let onTranscribe: (() => void) | null = null;

const provider: TranscriptionProvider = {
  model: "whisper-large-v3",
  async transcribe(audio, mimetype) {
    lastBuffer = audio;
    received.push({ bytes: audio.toString("utf8"), mimetype });
    onTranscribe?.();
    const next = providerPlan.shift() ?? SECRET_TEXT;
    if (next instanceof Error) throw next;
    return next;
  }
};

let dailyMaxSeconds = 180 * 60;
const queue = new WhatsAppTranscriptionQueue({
  store: memory.transcriptionStore,
  download: async (instance, message) => {
    downloads.push({ instance, message });
    const next = downloadPlan.shift() ?? { base64: AUDIO_BYTES.toString("base64"), mimetype: "audio/ogg; codecs=opus" };
    if (next instanceof Error) throw next;
    return next;
  },
  provider: () => provider,
  dailyMaxSeconds: () => dailyMaxSeconds,
  now,
  autoRun: false
});

let transcriptionOn = true;
const ingestion = new WhatsAppMessageIngestion(memory.store, () => true, {
  enabled: () => transcriptionOn,
  maxSeconds: () => 600,
  enqueue: (job: TranscriptionJob) => queue.enqueue(job)
});

const INSTANCE = "crm-aaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT = "5511900000001";
const CONTACT = "5511900000101";
memory.instances.set(INSTANCE, { userId: "seller-a", account: ACCOUNT });
memory.phoneIndex.set(CONTACT, ["client-a"]);

const MEDIA_KEY = "chave-de-midia-ficticia";
const MEDIA_URL = "https://mmg.invalid/arquivo-ficticio";
const audioEvent = (id: string, seconds: number | undefined, options: { fromMe?: boolean; fileLength?: number } = {}) => ({
  event: "messages.upsert",
  instance: INSTANCE,
  data: {
    key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: options.fromMe ?? false, id },
    pushName: "Contato Ficticio",
    message: {
      audioMessage: {
        url: MEDIA_URL,
        directPath: "/v/caminho-ficticio",
        mediaKey: MEDIA_KEY,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
        ...(seconds !== undefined ? { seconds } : {}),
        ...(options.fileLength !== undefined ? { fileLength: options.fileLength } : {})
      }
    },
    messageTimestamp: Math.floor(clock.getTime() / 1000) - 60
  }
});
const messageOf = (id: string) => memory.messages.find((row) => row.externalMessageId === id)!;
const stateOf = (id: string) => transcriptionOf(messageOf(id).mediaMetadata);

// 1) Estado inicial.
assert.deepEqual(initialTranscription({ seconds: 42, maxSeconds: 600, now: clock }), { status: "pending", at: clock.toISOString() });
assert.deepEqual(initialTranscription({ seconds: 601, maxSeconds: 600, now: clock }), { status: "skipped", reason: "too_long", at: clock.toISOString() });
assert.deepEqual(initialTranscription({ seconds: 600, maxSeconds: 600, now: clock }).status, "pending", "600 s ainda transcreve");
assert.deepEqual(initialTranscription({ seconds: 30, fileLength: MAX_AUDIO_BYTES + 1, maxSeconds: 600, now: clock }).reason, "too_long");
assert.deepEqual(initialTranscription({ seconds: undefined, maxSeconds: 600, now: clock }).reason, "no_duration");

// 2) Desligada: o áudio é gravado como antes, sem estado e sem fila.
transcriptionOn = false;
const off = await ingestion.handle(audioEvent("AUD-OFF", 12), clock);
assert.equal(off.status, "stored");
assert.equal("transcription" in off, false);
assert.deepEqual(messageOf("AUD-OFF").mediaMetadata, { kind: "audio", seconds: 12 });
assert.equal(queue.size, 0);
transcriptionOn = true;

// 3) Ligada: recebido fica pendente e vai para a fila; a referência do arquivo não é gravada.
const stored = await ingestion.handle(audioEvent("AUD-1", 42), clock);
assert.equal(stored.transcription, "pending");
assert.deepEqual(messageOf("AUD-1").mediaMetadata, { kind: "audio", seconds: 42, transcription: { status: "pending", at: clock.toISOString() } });
assert.equal(messageOf("AUD-1").textContent, "[áudio 0:42]", "o texto da mensagem continua o rótulo");
assert.equal(queue.size, 1);
assert(queue.has(ACCOUNT, "AUD-1"));
assert.doesNotMatch(JSON.stringify(memory.messages), new RegExp(`${MEDIA_KEY}|${MEDIA_URL}|caminho-ficticio`), "mediaKey/url/directPath nunca no banco");

// Reentrega: não duplica na fila.
assert.equal((await ingestion.handle(audioEvent("AUD-1", 42), clock)).status, "duplicate");
assert.equal(queue.size, 1);

// Longo demais e sem duração: pulados, sem fila.
assert.equal((await ingestion.handle(audioEvent("AUD-LONG", 601), clock)).transcription, "skipped");
assert.deepEqual(stateOf("AUD-LONG"), { status: "skipped", reason: "too_long", at: clock.toISOString() });
assert.equal((await ingestion.handle(audioEvent("AUD-BIG", 30, { fileLength: MAX_AUDIO_BYTES + 1 }), clock)).transcription, "skipped");
assert.equal(stateOf("AUD-BIG")?.reason, "too_long");
assert.equal((await ingestion.handle(audioEvent("AUD-NODUR", undefined), clock)).transcription, "skipped");
assert.equal(stateOf("AUD-NODUR")?.reason, "no_duration");
assert.equal(queue.size, 1);

// 4) Fila: baixa pela mensagem inteira, transcreve e grava o texto; o arquivo é zerado depois do uso.
assert.deepEqual(await queue.runDue(), ["done"]);
assert.deepEqual(downloads[0], {
  instance: INSTANCE,
  message: {
    key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: false, id: "AUD-1" },
    message: { audioMessage: { url: MEDIA_URL, directPath: "/v/caminho-ficticio", mediaKey: MEDIA_KEY, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 42 } }
  }
});
assert.deepEqual(received[0], { bytes: "OggS-audio-ficticio", mimetype: "audio/ogg; codecs=opus" });
assert(lastBuffer && (lastBuffer as Buffer).every((byte) => byte === 0), "buffer do áudio zerado");
assert.deepEqual(stateOf("AUD-1"), { status: "done", text: SECRET_TEXT, attempts: 1, model: "whisper-large-v3", at: clock.toISOString() });
assert.equal(messageOf("AUD-1").mediaMetadata?.seconds, 42, "duração mantida");
assert.equal(memory.usage.get("2026-11-07"), 42, "minutos do dia (Brasília) contados");
assert.equal(queue.size, 0);

// 5) Enviado pelo app também é transcrito.
await ingestion.handle(audioEvent("AUD-OUT", 5, { fromMe: true }), clock);
assert.deepEqual(await queue.runDue(), ["done"]);
assert.equal(stateOf("AUD-OUT")?.status, "done");
assert.equal((downloads[1].message as { key: { fromMe: boolean } }).key.fromMe, true);

// 6) 429 do provedor: pausa a fila pelo retry-after, tenta de novo e transcreve.
await ingestion.handle(audioEvent("AUD-429", 10), clock);
providerPlan = [new TranscriptionProviderError("rate_limited", true, 429, 7_000)];
assert.deepEqual(await queue.runDue(), ["retry"]);
assert.equal(stateOf("AUD-429")?.status, "pending");
advance(6_000);
assert.deepEqual(await queue.runDue(), [], "ainda em pausa");
advance(1_000);
assert.deepEqual(await queue.runDue(), ["done"]);
assert.equal(stateOf("AUD-429")?.attempts, 2);

// 7) 429 em todas as tentativas: failed/rate_limited; sem retry-after vale a espera padrão.
await ingestion.handle(audioEvent("AUD-429X", 10), clock);
for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
  providerPlan = [new TranscriptionProviderError("rate_limited", true, 429, attempt === 0 ? null : 1_000)];
  const outcome = await queue.runDue();
  assert.deepEqual(outcome, [attempt < MAX_ATTEMPTS - 1 ? "retry" : "failed"]);
  if (attempt === 0) {
    advance(RETRY_DELAYS_MS[0] - 1);
    assert.deepEqual(await queue.runDue(), [], "sem retry-after espera o padrão");
    advance(1);
  } else advance(1_000);
}
assert.deepEqual(stateOf("AUD-429X"), { status: "failed", reason: "rate_limited", attempts: MAX_ATTEMPTS, at: stateOf("AUD-429X")!.at });

// 8) Download falha: espera crescente e, esgotado, failed/download_failed (sem gastar minutos).
const usedBefore = memory.usage.get("2026-11-07");
await ingestion.handle(audioEvent("AUD-DL", 10), clock);
downloadPlan = Array.from({ length: MAX_ATTEMPTS }, () => Object.assign(new Error("x"), { reason: "media_http_400" }));
for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
  assert.deepEqual(await queue.runDue(), [attempt < MAX_ATTEMPTS - 1 ? "retry" : "failed"]);
  advance(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
}
assert.equal(stateOf("AUD-DL")?.reason, "download_failed");
assert.equal(memory.usage.get("2026-11-07"), usedBefore);

// 9) Provedor: 4xx falha na hora; 5xx tenta de novo.
await ingestion.handle(audioEvent("AUD-401", 10), clock);
providerPlan = [new TranscriptionProviderError("http_401", false, 401)];
assert.deepEqual(await queue.runDue(), ["failed"]);
assert.deepEqual(stateOf("AUD-401"), { status: "failed", reason: "provider_failed", attempts: 1, at: clock.toISOString() });
await ingestion.handle(audioEvent("AUD-503", 10), clock);
providerPlan = [new TranscriptionProviderError("http_503", true, 503)];
assert.deepEqual(await queue.runDue(), ["retry"]);
advance(RETRY_DELAYS_MS[0]);
assert.deepEqual(await queue.runDue(), ["done"]);

// 10) Apagado pelo contato antes de rodar: nada é baixado nem gravado.
await ingestion.handle(audioEvent("AUD-DEL", 10), clock);
await ingestion.handle({ event: "messages.delete", instance: INSTANCE, data: { id: "AUD-DEL", remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: false } }, clock);
const downloadsBefore = downloads.length;
assert.deepEqual(await queue.runDue(), ["gone"]);
assert.equal(downloads.length, downloadsBefore);
assert.equal(messageOf("AUD-DEL").mediaMetadata, null);

// Apagado durante a transcrição: o texto não é gravado.
await ingestion.handle(audioEvent("AUD-DEL2", 10), clock);
onTranscribe = () => {
  messageOf("AUD-DEL2").mediaMetadata = null;
};
assert.deepEqual(await queue.runDue(), ["done"]);
onTranscribe = null;
assert.equal(messageOf("AUD-DEL2").mediaMetadata, null, "transcrição não volta para mensagem apagada");

// 11) Teto diário: o áudio que passaria do teto é pulado sem baixar.
dailyMaxSeconds = (memory.usage.get("2026-11-07") ?? 0) + 15;
await ingestion.handle(audioEvent("AUD-CAP-OK", 15), clock);
await ingestion.handle(audioEvent("AUD-CAP", 1), clock);
assert.deepEqual(await queue.runDue(), ["done", "skipped"]);
assert.deepEqual(stateOf("AUD-CAP"), { status: "skipped", reason: "daily_cap", at: clock.toISOString() });
// Dia seguinte em Brasília (03:00 UTC = 00:00): conta zerada.
clock = new Date("2026-11-08T03:00:00.000Z");
await ingestion.handle(audioEvent("AUD-NEXT-DAY", 15), clock);
assert.deepEqual(await queue.runDue(), ["done"]);
assert.equal(memory.usage.get("2026-11-08"), 15);
dailyMaxSeconds = 180 * 60;

// 12) Limpeza: pendente antigo fora da fila (a API reiniciou) vira interrupted; o que está na fila fica.
await ingestion.handle(audioEvent("AUD-QUEUED", 10), clock);
const orphan = await ingestion.handle(audioEvent("AUD-ORPHAN", 10), clock);
assert.equal(orphan.transcription, "pending");
queue.clear();
queue.enqueue({ instance: INSTANCE, account: ACCOUNT, externalMessageId: "AUD-QUEUED", seconds: 10, source: { key: { remoteJid: "x", fromMe: false, id: "AUD-QUEUED" }, audioMessage: {} } });
memory.usage.set("2026-09-01", 99);
assert.deepEqual(await queue.sweep(new Date(clock.getTime() + INTERRUPTED_AFTER_MS - 1)), { interrupted: 0, prunedDays: 1 }, "recente ainda espera");
assert.deepEqual(await queue.sweep(new Date(clock.getTime() + INTERRUPTED_AFTER_MS + 1)), { interrupted: 1, prunedDays: 0 });
assert.equal(stateOf("AUD-ORPHAN")?.reason, "interrupted");
assert.equal(stateOf("AUD-QUEUED")?.status, "pending", "o que está na fila não é marcado");
assert.equal(USAGE_KEY_PREFIX, "whatsapp_transcription_seconds:");
queue.clear();

// 13) Logs: só códigos e números; nunca texto, chave, URL, número ou id da mensagem.
assert(logs.some((line) => line.includes("[whatsapp transcription] done")));
assert(logs.some((line) => line.includes("rate_limited")));
const joined = logs.join("\n");
for (const forbidden of [SECRET_TEXT, MEDIA_KEY, MEDIA_URL, "caminho-ficticio", CONTACT, "AUD-1", "OggS", AUDIO_BYTES.toString("base64")]) {
  assert(!joined.includes(forbidden), `log sem ${forbidden.slice(0, 12)}`);
}

Object.assign(console, original);
console.log("whatsappTranscriptionQueue.test.ts: ok");
