import { logApiEvent } from "../utils/logger.js";
import { loadCommercialAutomationsConfig, runCommercialAutomations } from "../services/commercialAutomationsService.js";

const COMMERCIAL_AUTOMATIONS_INTERVAL_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let started = false;

const tick = async () => {
  const tickAt = new Date();
  logApiEvent("INFO", "[commercial automations scheduler] tick", { tickAt: tickAt.toISOString() });

  const config = await loadCommercialAutomationsConfig();
  if (!config.inactiveClientWorkflow.enabled) {
    logApiEvent("INFO", "[commercial automations scheduler] skipped", { reason: "workflow_disabled", tickAt: tickAt.toISOString() });
    return;
  }

  await runCommercialAutomations("scheduler", tickAt);
};

export const startCommercialAutomationsScheduler = async () => {
  if (started) return;
  started = true;

  logApiEvent("INFO", "[commercial automations scheduler] initialized", { intervalMs: COMMERCIAL_AUTOMATIONS_INTERVAL_MS });
  await tick().catch((error) => logApiEvent("ERROR", "[commercial automations scheduler] tick failed", { error: error instanceof Error ? error.message : String(error) }));
  timer = setInterval(() => {
    void tick().catch((error) => logApiEvent("ERROR", "[commercial automations scheduler] tick failed", { error: error instanceof Error ? error.message : String(error) }));
  }, COMMERCIAL_AUTOMATIONS_INTERVAL_MS);
};

export const stopCommercialAutomationsScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
};
