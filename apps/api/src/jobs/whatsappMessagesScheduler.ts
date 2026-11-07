import { logApiEvent } from "../utils/logger.js";
import { isWhatsAppEvolutionConfigured, isWhatsAppEvolutionEnabled, isWhatsAppMessagesEnabled } from "../services/whatsappConnection/config.js";
import { rebuildClientPhoneIndex } from "../services/whatsappMessages/clientPhoneIndex.js";
import { runWhatsAppMessagesMaintenance } from "../services/whatsappMessages/whatsappMessagesMaintenance.js";
import { reconcileWebhookSubscriptions } from "../services/whatsappMessages/whatsappWebhookSubscriptions.js";
import { syncRecordingState } from "../services/whatsappMessages/whatsappRecordingState.js";
import { whatsappTranscriptionQueue } from "../services/whatsappMessages/whatsappTranscriptionQueue.js";

// WhatsApp Fase B, de hora em hora:
// - limpeza: fila "não vinculadas" vencida (7 dias) e retenção das mensagens vinculadas (sempre roda,
//   mesmo com a gravação desligada, para os dados já gravados respeitarem a retenção);
// - uma vez por dia (e na subida): eventos do webhook das instâncias conectadas conforme as flags e, com a
//   gravação ligada, reconstrução completa do índice telefone → cliente;
// - transcrição dos áudios: pendente antigo fora da fila (a API reiniciou) vira failed/interrupted e os
//   contadores diários antigos saem (sempre roda, mesmo com a transcrição desligada).
// Logs só com contagens e o nome do erro.

const INTERVAL_MS = 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let started = false;
let running = false;
let lastDailyAt = 0;

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export const whatsappMessagesTick = async (now = new Date()) => {
  if (running) return;
  running = true;
  try {
    const counts = await runWhatsAppMessagesMaintenance(now);
    logApiEvent("INFO", "[whatsapp scheduler] maintenance", counts);
    await whatsappTranscriptionQueue
      .sweep(now)
      .then((sweep) => logApiEvent("INFO", "[whatsapp transcription] sweep", sweep))
      .catch((error) => logApiEvent("WARN", "[whatsapp transcription] sweep failed", { error: errorName(error) }));
    if (now.getTime() - lastDailyAt >= DAILY_MS) {
      lastDailyAt = now.getTime();
      if (isWhatsAppEvolutionEnabled() && isWhatsAppEvolutionConfigured()) {
        await reconcileWebhookSubscriptions().catch((error) => logApiEvent("WARN", "[whatsapp scheduler] webhook reconcile failed", { error: errorName(error) }));
      }
      if (isWhatsAppMessagesEnabled()) {
        const index = await rebuildClientPhoneIndex();
        logApiEvent("INFO", "[whatsapp] phone index rebuilt", { reason: "daily", ...index });
      }
    }
  } finally {
    running = false;
  }
};

export const startWhatsAppMessagesScheduler = async () => {
  if (started) return;
  started = true;
  logApiEvent("INFO", "[whatsapp scheduler] initialized", { intervalMs: INTERVAL_MS });
  // "Gravação ligada/desligada desde": a flag só muda com a API reiniciando, então basta conferir na subida.
  await syncRecordingState()
    .then(({ changed, state }) => logApiEvent("INFO", "[whatsapp] recording state", { enabled: state.enabled, changed }))
    .catch((error) => logApiEvent("WARN", "[whatsapp] recording state sync failed", { error: errorName(error) }));
  await whatsappMessagesTick().catch((error) => logApiEvent("ERROR", "[whatsapp scheduler] tick failed", { error: errorName(error) }));
  timer = setInterval(() => {
    void whatsappMessagesTick().catch((error) => logApiEvent("ERROR", "[whatsapp scheduler] tick failed", { error: errorName(error) }));
  }, INTERVAL_MS);
  timer.unref?.();
};

export const stopWhatsAppMessagesScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  lastDailyAt = 0;
};
