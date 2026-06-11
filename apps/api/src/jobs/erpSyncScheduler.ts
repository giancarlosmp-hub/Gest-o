import { ErpSyncTrigger } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { syncErpOrderStatuses } from "../services/erpOrderService.js";
import {
  syncBranches,
  syncConnection,
  syncOperations,
  syncOrderStatus,
  syncPartners,
  syncPaymentMethods,
  syncPrices,
  syncPriceTables,
  syncPriceVariations,
  syncProducts,
  syncReceivingConditions,
  syncSalesmen,
  type RunSyncOptions,
} from "../services/ultraFv3SyncService.js";
import { ultraFv3Client } from "../services/ultraFv3Client.js";
import { logApiEvent } from "../utils/logger.js";

const AUTOMATIC_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const AUTOMATIC_SYNC_CHECK_INTERVAL_MS = 60 * 1000;
const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";
const AUTOMATIC_SYNC_START_HOUR = 7;
const AUTOMATIC_SYNC_END_HOUR = 19;

const AUTOMATIC_SYNC_STEPS: Array<{
  scope: string;
  label: string;
  run: (options?: RunSyncOptions) => Promise<unknown>;
}> = [
  { scope: "connection", label: "Conexão", run: syncConnection },
  { scope: "salesmen", label: "Vendedores", run: syncSalesmen },
  { scope: "partners", label: "Clientes/parceiros", run: syncPartners },
  { scope: "products", label: "Produtos", run: syncProducts },
  { scope: "priceTables", label: "Tabelas de preço", run: syncPriceTables },
  { scope: "prices", label: "Preços calculados", run: syncPrices },
  { scope: "priceVariations", label: "Variações por tabela", run: syncPriceVariations },
  { scope: "receivingConditions", label: "Condições de pagamento", run: syncReceivingConditions },
  { scope: "paymentMethods", label: "Formas de pagamento", run: syncPaymentMethods },
  { scope: "branches", label: "Filiais", run: syncBranches },
  { scope: "operations", label: "Operações", run: syncOperations },
  { scope: "orderStatus", label: "Status de pedidos", run: (options) => syncOrderStatus(() => syncErpOrderStatuses(), options) },
];

type AutomaticSyncState = {
  enabled: boolean;
  active: boolean;
  timezone: typeof SAO_PAULO_TIME_ZONE;
  windowStartHour: number;
  windowEndHour: number;
  intervalMs: number;
  isRunning: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFinishedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  currentRunId: string | null;
  lastCorrelationId: string | null;
  lastSkippedReason: string | null;
};

let automaticTimer: NodeJS.Timeout | null = null;
let automaticSyncRunning = false;
let lastAutomaticRunAt: Date | null = null;
let lastAutomaticSuccessAt: Date | null = null;
let lastAutomaticFinishedAt: Date | null = null;
let nextAutomaticRunAt: Date | null = null;
let lastAutomaticError: string | null = null;
let currentAutomaticRunId: string | null = null;
let lastAutomaticCorrelationId: string | null = null;
let lastAutomaticSkippedReason: string | null = null;

const getSaoPauloHour = (date: Date) => {
  const hourText = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hourText === "24" ? "0" : hourText);
};

const isInsideAutomaticSyncWindow = (date: Date) => {
  const hour = getSaoPauloHour(date);
  return hour >= AUTOMATIC_SYNC_START_HOUR && hour < AUTOMATIC_SYNC_END_HOUR;
};

const calculateNextAutomaticRunAt = (from = new Date()) => {
  const probe = new Date(from.getTime());
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(0);
  probe.setUTCHours(probe.getUTCHours() + 1);

  for (let i = 0; i < 48; i += 1) {
    if (isInsideAutomaticSyncWindow(probe)) return probe;
    probe.setUTCHours(probe.getUTCHours() + 1);
  }

  return new Date(from.getTime() + AUTOMATIC_SYNC_INTERVAL_MS);
};

async function executeAutomaticErpSync() {
  const now = new Date();
  if (!isInsideAutomaticSyncWindow(now)) {
    lastAutomaticSkippedReason = "outside_window";
    nextAutomaticRunAt = calculateNextAutomaticRunAt(now);
    return;
  }

  if (automaticSyncRunning) {
    lastAutomaticSkippedReason = "already_running";
    logApiEvent("WARN", "[erp automatic sync] skipped because previous automatic sync is still running", {
      currentAutomaticRunId,
      nextRunAt: nextAutomaticRunAt?.toISOString() ?? null,
    });
    return;
  }

  const correlationId = randomUUID();
  currentAutomaticRunId = correlationId;
  lastAutomaticCorrelationId = correlationId;
  lastAutomaticRunAt = now;
  lastAutomaticSkippedReason = null;
  automaticSyncRunning = true;

  logApiEvent("INFO", "[erp automatic sync] hourly ERP sync started", {
    correlationId,
    timezone: SAO_PAULO_TIME_ZONE,
    scopes: AUTOMATIC_SYNC_STEPS.map((step) => step.scope),
  });

  try {
    for (const [index, step] of AUTOMATIC_SYNC_STEPS.entries()) {
      logApiEvent("INFO", "[erp automatic sync] step started", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: AUTOMATIC_SYNC_STEPS.length,
      });
      await step.run({
        trigger: ErpSyncTrigger.scheduler,
        failIfLocked: true,
        correlationId,
      });
      logApiEvent("INFO", "[erp automatic sync] step finished", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: AUTOMATIC_SYNC_STEPS.length,
      });
    }
    lastAutomaticSuccessAt = new Date();
    lastAutomaticError = null;
    logApiEvent("INFO", "[erp automatic sync] hourly ERP sync finished", { correlationId });
  } catch (error) {
    lastAutomaticError = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[erp automatic sync] hourly ERP sync failed", {
      correlationId,
      error: lastAutomaticError,
      operationalAlert: true,
    });
  } finally {
    automaticSyncRunning = false;
    currentAutomaticRunId = null;
    lastAutomaticFinishedAt = new Date();
    nextAutomaticRunAt = calculateNextAutomaticRunAt(lastAutomaticFinishedAt);
  }
}

function scheduleAutomaticSyncChecker() {
  nextAutomaticRunAt = calculateNextAutomaticRunAt(new Date());
  automaticTimer = setInterval(() => {
    const now = new Date();
    if (!nextAutomaticRunAt || now >= nextAutomaticRunAt) {
      nextAutomaticRunAt = calculateNextAutomaticRunAt(now);
      void executeAutomaticErpSync();
    }
  }, AUTOMATIC_SYNC_CHECK_INTERVAL_MS);
  automaticTimer.unref?.();
}

export function startErpSyncScheduler() {
  if (!env.erpSyncSchedulerEnabled) {
    logApiEvent("INFO", "[erp automatic sync] disabled by configuration");
    return;
  }

  const diagnostics = ultraFv3Client.getDiagnostics();
  if (!diagnostics.isConfigured) {
    logApiEvent("WARN", "[erp automatic sync] disabled because UltraFV3 is not configured", {
      missingConfig: diagnostics.missingConfig,
      operationalAlert: true,
    });
    return;
  }

  if (automaticTimer) return;
  scheduleAutomaticSyncChecker();
  logApiEvent("INFO", "[erp automatic sync] hourly ERP sync registered", {
    intervalMs: AUTOMATIC_SYNC_INTERVAL_MS,
    timezone: SAO_PAULO_TIME_ZONE,
    windowStartHour: AUTOMATIC_SYNC_START_HOUR,
    windowEndHour: AUTOMATIC_SYNC_END_HOUR,
    nextRunAt: nextAutomaticRunAt?.toISOString() ?? null,
  });
}

export function stopErpSyncScheduler() {
  if (automaticTimer) clearInterval(automaticTimer);
  automaticTimer = null;
  nextAutomaticRunAt = null;
}

export function getErpAutomaticSyncState(): AutomaticSyncState {
  return {
    enabled: env.erpSyncSchedulerEnabled,
    active: Boolean(automaticTimer),
    timezone: SAO_PAULO_TIME_ZONE,
    windowStartHour: AUTOMATIC_SYNC_START_HOUR,
    windowEndHour: AUTOMATIC_SYNC_END_HOUR,
    intervalMs: AUTOMATIC_SYNC_INTERVAL_MS,
    isRunning: automaticSyncRunning,
    lastRunAt: lastAutomaticRunAt?.toISOString() ?? null,
    lastSuccessAt: lastAutomaticSuccessAt?.toISOString() ?? null,
    lastFinishedAt: lastAutomaticFinishedAt?.toISOString() ?? null,
    nextRunAt: nextAutomaticRunAt?.toISOString() ?? null,
    lastError: lastAutomaticError,
    currentRunId: currentAutomaticRunId,
    lastCorrelationId: lastAutomaticCorrelationId,
    lastSkippedReason: lastAutomaticSkippedReason,
  };
}

export const erpSyncSchedulerDefaults = {
  automaticIntervalMs: AUTOMATIC_SYNC_INTERVAL_MS,
  timezone: SAO_PAULO_TIME_ZONE,
  windowStartHour: AUTOMATIC_SYNC_START_HOUR,
  windowEndHour: AUTOMATIC_SYNC_END_HOUR,
};
