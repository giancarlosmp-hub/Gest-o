import { ErpSyncTrigger } from "@prisma/client";
import { env } from "../config/env.js";
import { syncErpOrderStatuses } from "../services/erpOrderService.js";
import { syncOrderStatus, syncPartners, syncProducts, syncConnection } from "../services/ultraFv3SyncService.js";
import { logApiEvent } from "../utils/logger.js";

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_PRODUCTS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PARTNERS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ORDER_STATUS_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_HEALTHCHECK_INTERVAL_MS = 5 * 60 * 1000;

type ScheduledJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  timer?: NodeJS.Timeout;
  running: boolean;
};

const clampInterval = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(value, MIN_INTERVAL_MS);
};

const buildJob = (name: string, intervalMs: number, run: () => Promise<unknown>): ScheduledJob => ({
  name,
  intervalMs,
  run,
  running: false,
});

const executeJob = async (job: ScheduledJob) => {
  if (job.running) {
    logApiEvent("WARN", "[erp sync scheduler] previous job execution still running", { job: job.name });
    return;
  }
  job.running = true;
  try {
    await job.run();
  } catch (error) {
    logApiEvent("ERROR", "[erp sync scheduler] job failed", {
      job: job.name,
      error: error instanceof Error ? error.message : String(error),
      operationalAlert: true,
    });
  } finally {
    job.running = false;
  }
};

let scheduledJobs: ScheduledJob[] = [];

export function startErpSyncScheduler() {
  if (!env.erpSyncSchedulerEnabled) {
    logApiEvent("INFO", "[erp sync scheduler] disabled by configuration");
    return;
  }
  if (scheduledJobs.length > 0) return;

  scheduledJobs = [
    buildJob("ultrafv3-healthcheck", clampInterval(env.erpSyncHealthcheckIntervalMs, DEFAULT_HEALTHCHECK_INTERVAL_MS), () => syncConnection({ trigger: ErpSyncTrigger.scheduler, failIfLocked: false })),
    buildJob("ultrafv3-products", clampInterval(env.erpSyncProductsIntervalMs, DEFAULT_PRODUCTS_INTERVAL_MS), () => syncProducts({ trigger: ErpSyncTrigger.scheduler, failIfLocked: false })),
    buildJob("ultrafv3-partners", clampInterval(env.erpSyncPartnersIntervalMs, DEFAULT_PARTNERS_INTERVAL_MS), () => syncPartners({ trigger: ErpSyncTrigger.scheduler, failIfLocked: false })),
    buildJob("ultrafv3-order-status", clampInterval(env.erpSyncOrderStatusIntervalMs, DEFAULT_ORDER_STATUS_INTERVAL_MS), () => syncOrderStatus(() => syncErpOrderStatuses(), { trigger: ErpSyncTrigger.scheduler, failIfLocked: false })),
  ];

  for (const job of scheduledJobs) {
    job.timer = setInterval(() => void executeJob(job), job.intervalMs);
    job.timer.unref?.();
    logApiEvent("INFO", "[erp sync scheduler] job registered", { job: job.name, intervalMs: job.intervalMs });
  }
}

export function stopErpSyncScheduler() {
  for (const job of scheduledJobs) {
    if (job.timer) clearInterval(job.timer);
  }
  scheduledJobs = [];
}

export const erpSyncSchedulerDefaults = {
  productsIntervalMs: DEFAULT_PRODUCTS_INTERVAL_MS,
  partnersIntervalMs: DEFAULT_PARTNERS_INTERVAL_MS,
  orderStatusIntervalMs: DEFAULT_ORDER_STATUS_INTERVAL_MS,
  healthcheckIntervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
};
