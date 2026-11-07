import { CommunicationMessageType, Prisma, type PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { brazilDayKeyOf, shiftDayKey } from "../../utils/dateRange.js";
import { logApiEvent } from "../../utils/logger.js";
import { createEvolutionClient } from "../whatsappConnection/evolutionClient.js";
import type { AudioSource } from "./evolutionMessageParser.js";
import { EVOLUTION_PROVIDER } from "./whatsappMessageStore.js";
import { OpenAICompatibleTranscriptionProvider, TranscriptionProviderError, type TranscriptionProvider } from "./whatsappTranscriptionProvider.js";

// Transcrição dos áudios do WhatsApp (recebidos e enviados pelo app), fora do webhook:
// - A ingestão grava o áudio com mediaMetadata.transcription = pendente (ou pulado: sem duração, mais longo que
//   WHATSAPP_TRANSCRIPTION_MAX_SECONDS ou arquivo grande) e põe o job nesta fila em memória. O job leva a key e
//   o audioMessage (url, directPath, mediaKey), que nunca vão para o banco nem para log: se a API reiniciar,
//   eles se perdem e a limpeza de hora em hora marca o pendente como "interrupted".
// - Um job por vez: confere o teto diário (WHATSAPP_TRANSCRIPTION_DAILY_MAX_MINUTES, dia de Brasília, contado em
//   AppConfig), baixa o áudio pelo Evolution, manda ao provedor e grava o texto. O arquivo fica só em memória e é
//   zerado depois do uso.
// - Tentativas: até 4. 429 do provedor (limite do plano gratuito da Groq) pausa a fila inteira pelo retry-after
//   (sem ele, a espera padrão) e esgotadas as tentativas marca failed/rate_limited. Erro de rede, 5xx e
//   download: espera crescente; 4xx do provedor falha na hora.
// - Mensagem apagada pelo contato nesse meio-tempo (mediaMetadata zerado): nada é gravado.
// Logs só com códigos, segundos e contagens: nunca texto, áudio, URL, chave, número ou id da mensagem.

export type TranscriptionStatus = "pending" | "done" | "failed" | "skipped";
export type TranscriptionReason =
  | "too_long"
  | "no_duration"
  | "daily_cap"
  | "rate_limited"
  | "download_failed"
  | "provider_failed"
  | "interrupted";

export type TranscriptionState = {
  status: TranscriptionStatus;
  at: string;
  text?: string;
  reason?: TranscriptionReason;
  attempts?: number;
  model?: string;
};

export type TranscriptionJob = {
  instance: string;
  account: string;
  externalMessageId: string;
  seconds: number;
  source: AudioSource;
};

export const MAX_ATTEMPTS = 4;
/** Espera antes da 2ª, 3ª e 4ª tentativa (também no 429 sem retry-after). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** retry-after maior que isso é limitado (a tentativa seguinte confere de novo). */
export const MAX_RATE_LIMIT_WAIT_MS = 60 * 60_000;
/** Arquivo maior que isso nem é baixado (10 min de nota de voz ficam perto de 1 a 2 MB). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;
/** Pendente mais antigo que isso e fora da fila: a API reiniciou e a referência do áudio se perdeu. */
export const INTERRUPTED_AFTER_MS = 30 * 60_000;
export const USAGE_KEY_PREFIX = "whatsapp_transcription_seconds:";
const USAGE_KEEP_DAYS = 30;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Estado da transcrição gravado em mediaMetadata, ou null. */
export const transcriptionOf = (mediaMetadata: unknown): TranscriptionState | null => {
  const state = asRecord(asRecord(mediaMetadata)?.transcription);
  return state && typeof state.status === "string" ? (state as TranscriptionState) : null;
};

/** Estado inicial de um áudio novo: pendente, ou pulado sem baixar nada. */
export function initialTranscription(input: { seconds?: number; fileLength?: number; maxSeconds: number; now: Date }): TranscriptionState {
  const at = input.now.toISOString();
  if (input.seconds === undefined || input.seconds <= 0) return { status: "skipped", reason: "no_duration", at };
  if (input.seconds > input.maxSeconds || (input.fileLength !== undefined && input.fileLength > MAX_AUDIO_BYTES)) {
    return { status: "skipped", reason: "too_long", at };
  }
  return { status: "pending", at };
}

export type AudioRow = { id: string; mediaMetadata: Record<string, unknown> | null };
export type PendingRow = AudioRow & { account: string; externalMessageId: string };

export interface TranscriptionStore {
  readAudio(account: string, externalMessageId: string): Promise<AudioRow | null>;
  /** Grava só se a mensagem ainda é um áudio (o contato pode ter apagado). */
  writeTranscription(id: string, mediaMetadata: Record<string, unknown>): Promise<boolean>;
  usedSeconds(day: string): Promise<number>;
  addUsedSeconds(day: string, seconds: number): Promise<void>;
  pendingRows(): Promise<PendingRow[]>;
  /** Apaga os contadores diários anteriores a `day`. */
  pruneUsage(day: string): Promise<number>;
}

const PENDING_SWEEP_LIMIT = 500;
const jsonObject = (value: Prisma.JsonValue | null) => asRecord(value);

export class PrismaTranscriptionStore implements TranscriptionStore {
  constructor(private readonly db: Pick<PrismaClient, "communicationMessage" | "appConfig"> = defaultPrisma) {}

  async readAudio(account: string, externalMessageId: string) {
    const row = await this.db.communicationMessage.findUnique({
      where: { provider_externalAccountId_externalMessageId: { provider: EVOLUTION_PROVIDER, externalAccountId: account, externalMessageId } },
      select: { id: true, mediaMetadata: true }
    });
    return row ? { id: row.id, mediaMetadata: jsonObject(row.mediaMetadata) } : null;
  }

  async writeTranscription(id: string, mediaMetadata: Record<string, unknown>) {
    const result = await this.db.communicationMessage.updateMany({
      where: { id, mediaMetadata: { path: ["kind"], equals: "audio" } },
      data: { mediaMetadata: mediaMetadata as Prisma.InputJsonValue }
    });
    return result.count > 0;
  }

  async usedSeconds(day: string) {
    const row = await this.db.appConfig.findUnique({ where: { key: `${USAGE_KEY_PREFIX}${day}` }, select: { value: true } });
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async addUsedSeconds(day: string, seconds: number) {
    // Um job por vez e uma API só: ler e somar basta.
    const key = `${USAGE_KEY_PREFIX}${day}`;
    const value = String((await this.usedSeconds(day)) + seconds);
    await this.db.appConfig.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async pendingRows() {
    const rows = await this.db.communicationMessage.findMany({
      where: {
        provider: EVOLUTION_PROVIDER,
        type: CommunicationMessageType.AUDIO,
        mediaMetadata: { path: ["transcription", "status"], equals: "pending" }
      },
      take: PENDING_SWEEP_LIMIT,
      select: { id: true, externalAccountId: true, externalMessageId: true, mediaMetadata: true }
    });
    return rows.map((row) => ({ id: row.id, account: row.externalAccountId, externalMessageId: row.externalMessageId, mediaMetadata: jsonObject(row.mediaMetadata) }));
  }

  async pruneUsage(day: string) {
    const result = await this.db.appConfig.deleteMany({ where: { key: { startsWith: USAGE_KEY_PREFIX, lt: `${USAGE_KEY_PREFIX}${day}` } } });
    return result.count;
  }
}

type Download = (instance: string, message: { key: Record<string, unknown>; message: Record<string, unknown> }, maxBase64Length: number) => Promise<{ base64: string; mimetype: string | null }>;

export type QueueOptions = {
  store: TranscriptionStore;
  download: Download;
  provider: () => TranscriptionProvider;
  dailyMaxSeconds: () => number;
  now?: () => Date;
  /** Em produção a fila anda sozinha; nos testes, só com runDue(). */
  autoRun?: boolean;
};

type Entry = { job: TranscriptionJob; attempts: number; notBefore: number };
export type JobOutcome = "done" | "retry" | "failed" | "skipped" | "gone";

const errorCode = (error: unknown) =>
  error instanceof TranscriptionProviderError
    ? error.code
    : typeof (error as { reason?: unknown } | null)?.reason === "string"
      ? (error as { reason: string }).reason
      : error instanceof Error
        ? error.name
        : "unknown";

export class WhatsAppTranscriptionQueue {
  private entries: Entry[] = [];
  private pausedUntil = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get size() {
    return this.entries.length;
  }

  has(account: string, externalMessageId: string) {
    return this.entries.some((entry) => entry.job.account === account && entry.job.externalMessageId === externalMessageId);
  }

  enqueue(job: TranscriptionJob) {
    if (this.has(job.account, job.externalMessageId)) return;
    this.entries.push({ job, attempts: 0, notBefore: 0 });
    this.schedule(0);
  }

  /** Processa, um por vez, os jobs que já podem rodar (respeitando a pausa do 429). */
  async runDue(): Promise<JobOutcome[]> {
    const outcomes: JobOutcome[] = [];
    for (;;) {
      const nowMs = this.now().getTime();
      if (nowMs < this.pausedUntil) break;
      const index = this.entries.findIndex((entry) => entry.notBefore <= nowMs);
      if (index < 0) break;
      const [entry] = this.entries.splice(index, 1);
      outcomes.push(await this.process(entry));
    }
    return outcomes;
  }

  /** Para os testes e o desligamento: esvazia a fila e o timer. */
  clear() {
    this.entries = [];
    this.pausedUntil = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (this.options.autoRun === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pump(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async pump() {
    this.timer = null;
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (error) {
      logApiEvent("WARN", "[whatsapp transcription] queue failed", { error: errorCode(error) });
    } finally {
      this.running = false;
    }
    if (!this.entries.length) return;
    const nowMs = this.now().getTime();
    const next = Math.max(this.pausedUntil, Math.min(...this.entries.map((entry) => entry.notBefore)));
    this.schedule(next - nowMs);
  }

  private async finish(row: AudioRow, state: TranscriptionState) {
    await this.options.store.writeTranscription(row.id, { ...(row.mediaMetadata ?? {}), transcription: state });
  }

  private retryOrFail(entry: Entry, row: AudioRow, reason: TranscriptionReason, delayMs: number, code: string): Promise<JobOutcome> {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      logApiEvent("WARN", "[whatsapp transcription] failed", { reason, code, attempts });
      return this.finish(row, { status: "failed", reason, attempts, at: this.now().toISOString() }).then(() => "failed" as const);
    }
    logApiEvent("INFO", "[whatsapp transcription] retry", { reason, code, attempts, delayMs });
    // Volta para a frente da fila: a ordem dos áudios se mantém.
    this.entries.unshift({ ...entry, attempts, notBefore: this.now().getTime() + delayMs });
    return Promise.resolve("retry");
  }

  private async process(entry: Entry): Promise<JobOutcome> {
    const { job } = entry;
    const { store } = this.options;
    const row = await store.readAudio(job.account, job.externalMessageId);
    // Apagada pelo contato (mediaMetadata zerado) ou já resolvida: nada a fazer.
    if (!row || row.mediaMetadata?.kind !== "audio" || transcriptionOf(row.mediaMetadata)?.status !== "pending") return "gone";

    const started = this.now();
    const day = brazilDayKeyOf(started);
    if ((await store.usedSeconds(day)) + job.seconds > this.options.dailyMaxSeconds()) {
      logApiEvent("INFO", "[whatsapp transcription] skipped", { reason: "daily_cap", seconds: job.seconds });
      await this.finish(row, { status: "skipped", reason: "daily_cap", at: started.toISOString() });
      return "skipped";
    }

    const delay = RETRY_DELAYS_MS[Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1)];
    let audio: Buffer;
    let mimetype: string | null;
    try {
      const media = await this.options.download(
        job.instance,
        { key: job.source.key, message: { audioMessage: job.source.audioMessage } },
        MAX_AUDIO_BASE64_LENGTH
      );
      audio = Buffer.from(media.base64, "base64");
      const declared = job.source.audioMessage.mimetype;
      mimetype = media.mimetype ?? (typeof declared === "string" ? declared : null);
    } catch (error) {
      return this.retryOrFail(entry, row, "download_failed", delay, errorCode(error));
    }

    const provider = this.options.provider();
    let text: string;
    try {
      text = await provider.transcribe(audio, mimetype);
    } catch (error) {
      if (error instanceof TranscriptionProviderError && error.code === "rate_limited") {
        const wait = Math.min(error.retryAfterMs ?? delay, MAX_RATE_LIMIT_WAIT_MS);
        this.pausedUntil = this.now().getTime() + wait;
        return this.retryOrFail(entry, row, "rate_limited", wait, error.code);
      }
      if (error instanceof TranscriptionProviderError && !error.retryable) {
        logApiEvent("WARN", "[whatsapp transcription] failed", { reason: "provider_failed", code: error.code, attempts: entry.attempts + 1 });
        await this.finish(row, { status: "failed", reason: "provider_failed", attempts: entry.attempts + 1, at: this.now().toISOString() });
        return "failed";
      }
      return this.retryOrFail(entry, row, "provider_failed", delay, errorCode(error));
    } finally {
      audio.fill(0);
    }

    await store.addUsedSeconds(day, job.seconds);
    // Relê: o contato pode ter apagado durante a transcrição (aí a gravação condicional não acontece).
    const fresh = (await store.readAudio(job.account, job.externalMessageId)) ?? row;
    const finishedAt = this.now();
    await this.finish(fresh, { status: "done", text, attempts: entry.attempts + 1, model: provider.model, at: finishedAt.toISOString() });
    logApiEvent("INFO", "[whatsapp transcription] done", {
      seconds: job.seconds,
      attempts: entry.attempts + 1,
      empty: text.length === 0,
      durationMs: finishedAt.getTime() - started.getTime()
    });
    return "done";
  }

  /**
   * De hora em hora: pendente antigo que não está na fila (a API reiniciou) vira failed/interrupted, e os
   * contadores diários antigos saem. Devolve só contagens.
   */
  async sweep(now = this.now()) {
    const { store } = this.options;
    const cutoff = now.getTime() - INTERRUPTED_AFTER_MS;
    let interrupted = 0;
    for (const row of await store.pendingRows()) {
      const state = transcriptionOf(row.mediaMetadata);
      const at = state ? Date.parse(state.at) : NaN;
      // Data ilegível conta como antiga.
      if (this.has(row.account, row.externalMessageId) || (Number.isFinite(at) && at >= cutoff)) continue;
      if (await store.writeTranscription(row.id, { ...(row.mediaMetadata ?? {}), transcription: { status: "failed", reason: "interrupted", at: now.toISOString() } })) {
        interrupted++;
      }
    }
    const prunedDays = await store.pruneUsage(shiftDayKey(brazilDayKeyOf(now), -USAGE_KEEP_DAYS));
    return { interrupted, prunedDays };
  }
}

export const whatsappTranscriptionQueue = new WhatsAppTranscriptionQueue({
  store: new PrismaTranscriptionStore(),
  download: (instance, message, maxBase64Length) => createEvolutionClient().getMediaBase64(instance, message, maxBase64Length),
  provider: () =>
    new OpenAICompatibleTranscriptionProvider({
      baseUrl: env.whatsappTranscriptionBaseUrl,
      apiKey: env.whatsappTranscriptionApiKey,
      model: env.whatsappTranscriptionModel
    }),
  dailyMaxSeconds: () => env.whatsappTranscriptionDailyMaxMinutes * 60
});
