import { Role } from "@prisma/client";
import type { WhatsAppDailySummaryConfig, WhatsAppDailySummaryRunState, WhatsAppDailySummarySellerDay } from "@salesforce-pro/shared";
import { prisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { isWhatsAppEvolutionConfigured, isWhatsAppEvolutionEnabled } from "../whatsappConnection/config.js";
import { resolveCrmUserRecipient, type CrmUserRecipient, type CrmUserRecipientResolution } from "../whatsappConnection/crmUserRecipient.js";
import type { EvolutionSendResult } from "../whatsappConnection/evolutionClient.js";
import {
  appConfigDailySummaryStore,
  brazilClock,
  DAILY_SUMMARY_RETENTION_DAYS,
  DAILY_SUMMARY_WINDOW_MINUTES,
  emptyDailySummaryCounts,
  loadDailySummaryConfig,
  sendTimeMinutes,
  type DailySummaryStore
} from "./dailySummaryConfig.js";
import { buildDailySummaryMessage } from "./dailySummaryData.js";
import { checkDailySummarySender, sendDailySummaryText, type DailySummarySenderCheck } from "./dailySummarySender.js";
import { createDailySummaryTipsRound, DAILY_SUMMARY_TIPS_USAGE_BUCKET, type DailySummaryTipsRound } from "./dailySummaryTips.js";

// WhatsApp Fase D: uma rodada do resumo diário (o agendador chama a cada poucos minutos).
// - só em dia útil, a partir do horário configurado (Brasília) e dentro da janela de DAILY_SUMMARY_WINDOW_MINUTES;
// - remetente conferido antes de qualquer envio; indisponível: nada sai, a situação do dia fica registrada;
// - cada vendedor uma vez por dia: a linha do AppConfig é criada antes do envio (trava);
// - intervalo aleatório entre envios; só "conexão recusada" tenta de novo (até MAX_ATTEMPTS), o resto não
//   repete para nunca duplicar;
// - vendedor sem nada: não envia, fica "empty"; destino recusado: "refused" com o motivo;
// - dicas do gerente comercial (se ligadas): geradas na montagem do texto, com orçamento curto; a primeira falha
//   da IA na rodada desliga as dicas para os demais vendedores (disjuntor), sem atrasar nem bloquear o envio.
// Log só com contagens e códigos: sem texto, nomes, números ou ids.

export const MAX_ATTEMPTS = 3;
export const MIN_INTERVAL_MS = 8_000;
export const MAX_EXTRA_INTERVAL_MS = 12_000;
const DAY_MS = 86_400_000;

export type DailySummarySeller = { id: string; name: string };

export type DailySummaryRunnerDeps = {
  isAvailable(): boolean;
  loadConfig(): Promise<WhatsAppDailySummaryConfig>;
  listSellers(): Promise<DailySummarySeller[]>;
  checkSender(senderUserId: string | null): Promise<DailySummarySenderCheck>;
  buildText(seller: DailySummarySeller, config: WhatsAppDailySummaryConfig, now: Date, tipsRound: DailySummaryTipsRound): Promise<string | null>;
  resolveRecipient(userId: string): Promise<CrmUserRecipientResolution>;
  send(instanceName: string, recipient: CrmUserRecipient, text: string): Promise<EvolutionSendResult>;
  store: DailySummaryStore;
  sleep(ms: number): Promise<void>;
  random(): number;
  log(level: "INFO" | "WARN", message: string, data: Record<string, unknown>): void;
};

export type DailySummaryTickResult =
  | { status: "skipped"; reason: "whatsapp_disabled" | "disabled" | "not_business_day" | "before_time" | "window_closed" }
  | { status: "sender_unavailable"; code: string }
  | { status: "done"; processed: number; counts: WhatsAppDailySummaryRunState["counts"] };

/** Vendedor ainda a processar hoje: sem linha, ou falha certa por conexão recusada com tentativas sobrando. */
const isPending = (day: WhatsAppDailySummarySellerDay | undefined) =>
  !day || (day.status === "failed" && day.code === "connection_refused" && day.attempts < MAX_ATTEMPTS);

const countDays = (days: Map<string, WhatsAppDailySummarySellerDay>) => {
  const counts = emptyDailySummaryCounts();
  for (const day of days.values()) counts[day.status] += 1;
  return counts;
};

export async function runDailySummaryTick(now: Date, deps: DailySummaryRunnerDeps): Promise<DailySummaryTickResult> {
  if (!deps.isAvailable()) return { status: "skipped", reason: "whatsapp_disabled" };
  const config = await deps.loadConfig();
  if (!config.enabled) return { status: "skipped", reason: "disabled" };
  const clock = brazilClock(now);
  if (clock.weekday === 0 || clock.weekday === 6) return { status: "skipped", reason: "not_business_day" };
  const start = sendTimeMinutes(config.sendTime);
  if (clock.minutes < start) return { status: "skipped", reason: "before_time" };

  const { dayKey } = clock;
  const at = now.toISOString();
  const lastRun = await deps.store.getRunState();
  const windowClosed = clock.minutes >= start + DAILY_SUMMARY_WINDOW_MINUTES;
  if (windowClosed && lastRun?.dayKey === dayKey) return { status: "skipped", reason: "window_closed" };

  const sellers = (await deps.listSellers()).filter((seller) => seller.id !== config.senderUserId);
  const days = await deps.store.getSellerDays(dayKey, sellers.map((seller) => seller.id));

  if (windowClosed) {
    await deps.store.setRunState({ dayKey, state: "window_closed", code: null, at, counts: countDays(days) });
    return { status: "skipped", reason: "window_closed" };
  }

  if (lastRun?.dayKey !== dayKey) {
    const removed = await deps.store.cleanup(new Date(now.getTime() - DAILY_SUMMARY_RETENTION_DAYS * DAY_MS));
    if (removed) deps.log("INFO", "[whatsapp daily summary] cleanup", { removed });
  }

  const pending = sellers.filter((seller) => isPending(days.get(seller.id)));
  if (pending.length === 0) {
    if (lastRun?.dayKey !== dayKey || lastRun.state !== "done") {
      await deps.store.setRunState({ dayKey, state: "done", code: null, at, counts: countDays(days) });
    }
    return { status: "done", processed: 0, counts: countDays(days) };
  }

  const sender = await deps.checkSender(config.senderUserId);
  if (!sender.ok) {
    await deps.store.setRunState({ dayKey, state: "sender_unavailable", code: sender.code, at, counts: countDays(days) });
    deps.log("WARN", "[whatsapp daily summary] sender unavailable", { code: sender.code, pending: pending.length });
    return { status: "sender_unavailable", code: sender.code };
  }

  const record = async (sellerId: string, state: WhatsAppDailySummarySellerDay) => {
    if (days.has(sellerId)) await deps.store.updateSellerDay(dayKey, sellerId, state);
    else if (!(await deps.store.createSellerDay(dayKey, sellerId, state))) return false;
    days.set(sellerId, state);
    return true;
  };

  const codes: Record<string, number> = {};
  let processed = 0;
  let sentBefore = false;
  let senderLost: string | null = null;
  const tipsRound = createDailySummaryTipsRound();
  for (const seller of pending) {
    const previous = days.get(seller.id);
    const attempts = previous?.attempts ?? 0;
    const text = await deps.buildText(seller, config, now, tipsRound);
    if (text === null) {
      await record(seller.id, { status: "empty", code: null, attempts, at: now.toISOString() });
      processed += 1;
      continue;
    }
    const resolution = await deps.resolveRecipient(seller.id);
    if (!resolution.ok) {
      await record(seller.id, { status: "refused", code: resolution.reason, attempts, at: now.toISOString() });
      codes[resolution.reason] = (codes[resolution.reason] ?? 0) + 1;
      processed += 1;
      continue;
    }
    if (sentBefore) await deps.sleep(MIN_INTERVAL_MS + Math.floor(deps.random() * MAX_EXTRA_INTERVAL_MS));
    // Trava: a linha "sending" é gravada antes do envio. Se a API cair no meio, fica "sending" (incerto) e não repete.
    if (!(await record(seller.id, { status: "sending", code: null, attempts: attempts + 1, at: new Date().toISOString() }))) continue;
    const result = await deps.send(sender.instanceName, resolution.recipient, text);
    sentBefore = true;
    processed += 1;
    const finishedAt = new Date().toISOString();
    if (result.kind === "sent") {
      await record(seller.id, { status: "sent", code: null, attempts: attempts + 1, at: finishedAt });
      continue;
    }
    codes[result.code] = (codes[result.code] ?? 0) + 1;
    await record(seller.id, { status: result.kind === "uncertain" ? "uncertain" : "failed", code: result.code, attempts: attempts + 1, at: finishedAt });
    if (result.kind === "not_sent" && (result.code === "instance_not_found" || result.code === "unauthorized")) {
      senderLost = result.code;
      break;
    }
  }

  const counts = countDays(days);
  if (senderLost) {
    await deps.store.setRunState({ dayKey, state: "sender_unavailable", code: senderLost, at: now.toISOString(), counts });
    deps.log("WARN", "[whatsapp daily summary] sender unavailable", { code: senderLost, processed, counts });
    return { status: "sender_unavailable", code: senderLost };
  }
  await deps.store.setRunState({ dayKey, state: "done", code: null, at: now.toISOString(), counts });
  deps.log("INFO", "[whatsapp daily summary] run", { processed, counts, codes });
  return { status: "done", processed, counts };
}

export function createDailySummaryRunnerDeps(): DailySummaryRunnerDeps {
  return {
    isAvailable: () => isWhatsAppEvolutionEnabled() && isWhatsAppEvolutionConfigured(),
    loadConfig: () => loadDailySummaryConfig(),
    listSellers: () =>
      prisma.user.findMany({ where: { role: Role.vendedor, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    checkSender: (senderUserId) => checkDailySummarySender(senderUserId),
    buildText: async (seller, config, now, tipsRound) =>
      (await buildDailySummaryMessage(seller, config, now, { round: tipsRound, usageKey: DAILY_SUMMARY_TIPS_USAGE_BUCKET })).text,
    resolveRecipient: (userId) => resolveCrmUserRecipient(userId),
    send: (instanceName, recipient, text) => sendDailySummaryText(instanceName, recipient, text),
    store: appConfigDailySummaryStore(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    log: (level, message, data) => logApiEvent(level, message, data)
  };
}
