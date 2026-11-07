import { logApiEvent } from "../utils/logger.js";
import { createDailySummaryRunnerDeps, runDailySummaryTick } from "../services/whatsappDailySummary/dailySummaryRunner.js";

// WhatsApp Fase D: confere o resumo diário a cada 5 minutos. Desligado por padrão (configuração no AppConfig)
// e só age com a integração do WhatsApp ligada e configurada. Uma rodada por vez; log só com o nome do erro.

const INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let started = false;
let running = false;

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export const whatsappDailySummaryTick = async (now = new Date()) => {
  if (running) return;
  running = true;
  try {
    await runDailySummaryTick(now, createDailySummaryRunnerDeps());
  } finally {
    running = false;
  }
};

export const startWhatsAppDailySummaryScheduler = async () => {
  if (started) return;
  started = true;
  logApiEvent("INFO", "[whatsapp daily summary] scheduler initialized", { intervalMs: INTERVAL_MS });
  timer = setInterval(() => {
    void whatsappDailySummaryTick().catch((error) => logApiEvent("ERROR", "[whatsapp daily summary] tick failed", { error: errorName(error) }));
  }, INTERVAL_MS);
  timer.unref?.();
};

export const stopWhatsAppDailySummaryScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
};
