import { ErpSyncRunStatus, ErpSyncTrigger, Prisma } from "@prisma/client";
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
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

const AUTOMATIC_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const AUTOMATIC_SYNC_CONFIG_KEY = "erp.automaticSync.config";
const AUTOMATIC_SYNC_SCOPE = "automatic";
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

type AutomaticSyncPanelStatus =
  | "scheduled"
  | "running"
  | "success"
  | "error"
  | "skipped_lock"
  | "outside_window"
  | "disabled";

type AutomaticSyncSkipReason =
  | "outside_window"
  | "lock_active"
  | "configuration_error"
  | "step_error"
  | "scheduler_disabled"
  | "database_disabled"
  | "already_running"
  | null;

type AutomaticSyncState = {
  enabled: boolean;
  enabledByEnv: boolean;
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
  lastSkippedReason: AutomaticSyncSkipReason;
  lastSkippedReasonLabel: string | null;
  panelStatus: AutomaticSyncPanelStatus;
  lastAttemptStatus: string | null;
  lastAttemptAt: string | null;
  lastAttemptFinishedAt: string | null;
  lastAttemptCorrelationId: string | null;
  lastStepError: string | null;
  statusLabel: string;
};

type AutomaticSyncPersistedConfig = {
  enabled: boolean;
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
let lastAutomaticSkippedReason: AutomaticSyncSkipReason = null;
let persistedAutomaticSyncEnabled = false;


async function loadAutomaticSyncPersistedConfig(): Promise<AutomaticSyncPersistedConfig> {
  const stored = await prisma.appConfig.findUnique({
    where: { key: AUTOMATIC_SYNC_CONFIG_KEY },
    select: { value: true },
  });
  if (!stored?.value) return { enabled: false };
  try {
    const parsed = JSON.parse(stored.value) as Partial<AutomaticSyncPersistedConfig>;
    return { enabled: parsed.enabled === true };
  } catch {
    return { enabled: false };
  }
}

async function saveAutomaticSyncPersistedConfig(config: AutomaticSyncPersistedConfig) {
  await prisma.appConfig.upsert({
    where: { key: AUTOMATIC_SYNC_CONFIG_KEY },
    update: { value: JSON.stringify(config) },
    create: { key: AUTOMATIC_SYNC_CONFIG_KEY, value: JSON.stringify(config) },
  });
}

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

const formatAutomaticSkipReason = (reason: AutomaticSyncSkipReason) => {
  switch (reason) {
    case "outside_window":
      return "Fora da janela configurada (07:00–19:00 America/Sao_Paulo).";
    case "lock_active":
      return "Ignorada porque existe lock de sincronização ativo.";
    case "configuration_error":
      return "Erro de configuração do UltraFV3 ou do scheduler.";
    case "step_error":
      return "Erro em etapa específica da sincronização automática.";
    case "scheduler_disabled":
      return "Scheduler desativado por variável de ambiente.";
    case "database_disabled":
      return "Scheduler desativado na configuração do painel.";
    case "already_running":
      return "Ignorada porque a execução automática anterior ainda está em andamento.";
    default:
      return null;
  }
};

const getErrorStatusCode = (error: unknown) =>
  typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : null;

const formatErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function loadLatestAutomaticRunSummary() {
  const [latestFinished, latestSuccess, latestAttempt] = await Promise.all([
    prisma.erpSyncRun.findFirst({
      where: {
        scope: AUTOMATIC_SYNC_SCOPE,
        trigger: ErpSyncTrigger.scheduler,
        status: { in: [ErpSyncRunStatus.success, ErpSyncRunStatus.error] },
      },
      orderBy: [{ startedAt: "desc" }],
    }),
    prisma.erpSyncRun.findFirst({
      where: {
        scope: AUTOMATIC_SYNC_SCOPE,
        trigger: ErpSyncTrigger.scheduler,
        status: ErpSyncRunStatus.success,
      },
      orderBy: [{ startedAt: "desc" }],
    }),
    prisma.erpSyncRun.findFirst({
      where: { scope: AUTOMATIC_SYNC_SCOPE, trigger: ErpSyncTrigger.scheduler },
      orderBy: [{ startedAt: "desc" }],
    }),
  ]);

  return { latestFinished, latestSuccess, latestAttempt };
}

async function executeAutomaticErpSync(scheduledFor = nextAutomaticRunAt) {
  const schedulerTickAt = new Date();
  const tickMetadataBase = {
    schedulerTickAt: schedulerTickAt.toISOString(),
    scheduledFor: scheduledFor?.toISOString() ?? null,
    timezone: SAO_PAULO_TIME_ZONE,
  };

  if (!isInsideAutomaticSyncWindow(schedulerTickAt)) {
    lastAutomaticSkippedReason = "outside_window";
    nextAutomaticRunAt = calculateNextAutomaticRunAt(schedulerTickAt);
    logApiEvent("INFO", "[erp automatic sync] scheduler tick skipped", {
      ...tickMetadataBase,
      shouldRun: false,
      skippedReason: lastAutomaticSkippedReason,
      startedAt: null,
      finishedAt: schedulerTickAt.toISOString(),
      status: "skipped",
      correlationId: null,
    });
    return;
  }

  if (automaticSyncRunning) {
    lastAutomaticSkippedReason = "already_running";
    logApiEvent("WARN", "[erp automatic sync] scheduler tick skipped", {
      ...tickMetadataBase,
      shouldRun: false,
      skippedReason: lastAutomaticSkippedReason,
      startedAt: null,
      finishedAt: schedulerTickAt.toISOString(),
      status: "skipped",
      correlationId: currentAutomaticRunId,
    });
    return;
  }

  const diagnostics = ultraFv3Client.getDiagnostics();
  if (!diagnostics.isConfigured) {
    lastAutomaticSkippedReason = "configuration_error";
    lastAutomaticError = `UltraFV3 não configurado: ${diagnostics.missingConfig.join(", ") || "configuração ausente"}.`;
    logApiEvent("WARN", "[erp automatic sync] scheduler tick skipped", {
      ...tickMetadataBase,
      shouldRun: false,
      skippedReason: lastAutomaticSkippedReason,
      missingConfig: diagnostics.missingConfig,
      startedAt: null,
      finishedAt: schedulerTickAt.toISOString(),
      status: "skipped",
      correlationId: null,
      operationalAlert: true,
    });
    return;
  }

  const correlationId = randomUUID();
  const startedAt = new Date();
  const startedAtMs = Date.now();
  currentAutomaticRunId = correlationId;
  lastAutomaticCorrelationId = correlationId;
  lastAutomaticRunAt = startedAt;
  lastAutomaticSkippedReason = null;
  automaticSyncRunning = true;

  const overallRun = await prisma.erpSyncRun.create({
    data: {
      scope: AUTOMATIC_SYNC_SCOPE,
      trigger: ErpSyncTrigger.scheduler,
      status: ErpSyncRunStatus.running,
      correlationId,
      startedAt,
      metrics: {
        schedulerTickAt: schedulerTickAt.toISOString(),
        scheduledFor: scheduledFor?.toISOString() ?? null,
        timezone: SAO_PAULO_TIME_ZONE,
        totalSteps: AUTOMATIC_SYNC_STEPS.length,
      } as Prisma.InputJsonValue,
    },
  });

  logApiEvent("INFO", "[erp automatic sync] scheduler tick accepted", {
    ...tickMetadataBase,
    shouldRun: true,
    skippedReason: null,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: "running",
    correlationId,
    runId: overallRun.id,
    scopes: AUTOMATIC_SYNC_STEPS.map((step) => step.scope),
  });

  const completedSteps: Array<{ scope: string; label: string }> = [];
  let failedStep: { scope: string; label: string; step: number } | null = null;
  let failedStepErrorPrefix: string | null = null;

  try {
    for (const [index, step] of AUTOMATIC_SYNC_STEPS.entries()) {
      logApiEvent("INFO", "[erp automatic sync] step started", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: AUTOMATIC_SYNC_STEPS.length,
      });
      try {
        await step.run({
          trigger: ErpSyncTrigger.scheduler,
          failIfLocked: true,
          correlationId,
        });
      } catch (error) {
        failedStep = { scope: step.scope, label: step.label, step: index + 1 };
        failedStepErrorPrefix = step.label;
        throw error;
      }
      completedSteps.push({ scope: step.scope, label: step.label });
      logApiEvent("INFO", "[erp automatic sync] step finished", {
        correlationId,
        scope: step.scope,
        label: step.label,
        step: index + 1,
        totalSteps: AUTOMATIC_SYNC_STEPS.length,
      });
    }

    const finishedAt = new Date();
    lastAutomaticSuccessAt = finishedAt;
    lastAutomaticFinishedAt = finishedAt;
    lastAutomaticError = null;
    await prisma.erpSyncRun.update({
      where: { id: overallRun.id },
      data: {
        status: ErpSyncRunStatus.success,
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        syncedCount: completedSteps.length,
        metrics: {
          schedulerTickAt: schedulerTickAt.toISOString(),
          scheduledFor: scheduledFor?.toISOString() ?? null,
          timezone: SAO_PAULO_TIME_ZONE,
          completedSteps,
          totalSteps: AUTOMATIC_SYNC_STEPS.length,
        } as Prisma.InputJsonValue,
      },
    });
    nextAutomaticRunAt = calculateNextAutomaticRunAt(finishedAt);
    logApiEvent("INFO", "[erp automatic sync] hourly ERP sync finished", {
      schedulerTickAt: schedulerTickAt.toISOString(),
      shouldRun: true,
      skippedReason: null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: "success",
      correlationId,
      runId: overallRun.id,
    });
  } catch (error) {
    const finishedAt = new Date();
    const message = formatErrorMessage(error);
    const isLock = getErrorStatusCode(error) === 409;
    lastAutomaticSkippedReason = isLock ? "lock_active" : "step_error";
    lastAutomaticError = failedStepErrorPrefix ? `${failedStepErrorPrefix}: ${message}` : message;
    lastAutomaticFinishedAt = finishedAt;
    await prisma.erpSyncRun.update({
      where: { id: overallRun.id },
      data: {
        status: isLock ? ErpSyncRunStatus.skipped : ErpSyncRunStatus.error,
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        syncedCount: completedSteps.length,
        metrics: {
          schedulerTickAt: schedulerTickAt.toISOString(),
          scheduledFor: scheduledFor?.toISOString() ?? null,
          timezone: SAO_PAULO_TIME_ZONE,
          completedSteps,
          failedStep,
          skippedReason: lastAutomaticSkippedReason,
          totalSteps: AUTOMATIC_SYNC_STEPS.length,
        } as Prisma.InputJsonValue,
        errors: [{ message, failedStep, at: finishedAt.toISOString(), correlationId }] as Prisma.InputJsonValue,
        errorMessage: lastAutomaticError,
      },
    });
    if (!isLock) nextAutomaticRunAt = calculateNextAutomaticRunAt(finishedAt);
    logApiEvent(isLock ? "WARN" : "ERROR", "[erp automatic sync] hourly ERP sync did not complete", {
      schedulerTickAt: schedulerTickAt.toISOString(),
      shouldRun: true,
      skippedReason: lastAutomaticSkippedReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: isLock ? "skipped" : "error",
      correlationId,
      runId: overallRun.id,
      failedStep,
      error: lastAutomaticError,
      operationalAlert: !isLock,
    });
  } finally {
    automaticSyncRunning = false;
    currentAutomaticRunId = null;
  }
}

function scheduleAutomaticSyncChecker() {
  nextAutomaticRunAt = calculateNextAutomaticRunAt(new Date());
  automaticTimer = setInterval(() => {
    const now = new Date();
    if (!nextAutomaticRunAt || now >= nextAutomaticRunAt) {
      const scheduledFor = nextAutomaticRunAt;
      void executeAutomaticErpSync(scheduledFor);
    }
  }, AUTOMATIC_SYNC_CHECK_INTERVAL_MS);
  automaticTimer.unref?.();
}

export async function startErpSyncScheduler() {
  const config = await loadAutomaticSyncPersistedConfig();
  persistedAutomaticSyncEnabled = config.enabled;
  if (!env.erpSyncSchedulerEnabled) {
    lastAutomaticSkippedReason = "scheduler_disabled";
    logApiEvent("INFO", "[erp automatic sync] disabled by environment configuration", { envVar: "ERP_SYNC_SCHEDULER_ENABLED" });
    return;
  }
  if (!persistedAutomaticSyncEnabled) {
    lastAutomaticSkippedReason = "database_disabled";
    logApiEvent("INFO", "[erp automatic sync] disabled by database configuration", { configKey: AUTOMATIC_SYNC_CONFIG_KEY });
    return;
  }

  const diagnostics = ultraFv3Client.getDiagnostics();
  if (!diagnostics.isConfigured) {
    lastAutomaticSkippedReason = "configuration_error";
    lastAutomaticError = `UltraFV3 não configurado: ${diagnostics.missingConfig.join(", ") || "configuração ausente"}.`;
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
  nextAutomaticRunAt = persistedAutomaticSyncEnabled ? calculateNextAutomaticRunAt(new Date()) : null;
}

export async function setErpAutomaticSyncEnabled(enabled: boolean) {
  persistedAutomaticSyncEnabled = enabled;
  await saveAutomaticSyncPersistedConfig({ enabled });
  if (enabled) {
    await startErpSyncScheduler();
  } else {
    stopErpSyncScheduler();
  }
  return getErpAutomaticSyncState();
}

export async function refreshErpAutomaticSyncConfig() {
  const config = await loadAutomaticSyncPersistedConfig();
  persistedAutomaticSyncEnabled = config.enabled;
  if (config.enabled && env.erpSyncSchedulerEnabled && !automaticTimer) {
    nextAutomaticRunAt = calculateNextAutomaticRunAt(new Date());
  }
  return getErpAutomaticSyncState();
}

export async function getErpAutomaticSyncState(): Promise<AutomaticSyncState> {
  const { latestFinished, latestSuccess, latestAttempt } = await loadLatestAutomaticRunSummary();
  const now = new Date();
  const insideWindow = isInsideAutomaticSyncWindow(now);
  const diagnostics = ultraFv3Client.getDiagnostics();

  let derivedSkippedReason = lastAutomaticSkippedReason;
  if (!env.erpSyncSchedulerEnabled) derivedSkippedReason = "scheduler_disabled";
  else if (!persistedAutomaticSyncEnabled) derivedSkippedReason = "database_disabled";
  else if (!diagnostics.isConfigured) derivedSkippedReason = "configuration_error";
  else if (!insideWindow) derivedSkippedReason = "outside_window";

  const latestAttemptStatus = latestAttempt?.status ?? null;
  const panelStatus: AutomaticSyncPanelStatus = !persistedAutomaticSyncEnabled || !env.erpSyncSchedulerEnabled || !diagnostics.isConfigured
    ? "disabled"
    : automaticSyncRunning || latestAttemptStatus === ErpSyncRunStatus.running
      ? "running"
      : derivedSkippedReason === "lock_active" || latestAttemptStatus === ErpSyncRunStatus.skipped
        ? "skipped_lock"
        : !insideWindow
          ? "outside_window"
          : latestAttemptStatus === ErpSyncRunStatus.error
            ? "error"
            : latestAttemptStatus === ErpSyncRunStatus.success
              ? "success"
              : "scheduled";

  const statusLabel = (() => {
    switch (panelStatus) {
      case "running":
        return "Em execução";
      case "success":
        return "Executada com sucesso";
      case "error":
        return "Executada com erro";
      case "skipped_lock":
        return "Ignorada por lock";
      case "outside_window":
        return "Fora da janela";
      case "disabled":
        return persistedAutomaticSyncEnabled ? "Scheduler desativado" : "Inativa";
      default:
        return "Agendada";
    }
  })();

  return {
    enabled: persistedAutomaticSyncEnabled,
    enabledByEnv: env.erpSyncSchedulerEnabled,
    active: Boolean(automaticTimer),
    timezone: SAO_PAULO_TIME_ZONE,
    windowStartHour: AUTOMATIC_SYNC_START_HOUR,
    windowEndHour: AUTOMATIC_SYNC_END_HOUR,
    intervalMs: AUTOMATIC_SYNC_INTERVAL_MS,
    isRunning: automaticSyncRunning,
    lastRunAt: (latestFinished?.startedAt ?? lastAutomaticRunAt)?.toISOString() ?? null,
    lastSuccessAt: (latestSuccess?.finishedAt ?? latestSuccess?.startedAt ?? lastAutomaticSuccessAt)?.toISOString() ?? null,
    lastFinishedAt: (latestFinished?.finishedAt ?? lastAutomaticFinishedAt)?.toISOString() ?? null,
    nextRunAt: nextAutomaticRunAt?.toISOString() ?? null,
    lastError: latestAttempt?.errorMessage ?? lastAutomaticError,
    currentRunId: currentAutomaticRunId,
    lastCorrelationId: lastAutomaticCorrelationId ?? latestAttempt?.correlationId ?? null,
    lastSkippedReason: derivedSkippedReason,
    lastSkippedReasonLabel: formatAutomaticSkipReason(derivedSkippedReason),
    panelStatus,
    lastAttemptStatus: latestAttemptStatus,
    lastAttemptAt: latestAttempt?.startedAt.toISOString() ?? null,
    lastAttemptFinishedAt: latestAttempt?.finishedAt?.toISOString() ?? null,
    lastAttemptCorrelationId: latestAttempt?.correlationId ?? null,
    lastStepError: latestAttempt?.errorMessage ?? null,
    statusLabel,
  };
}

export const erpSyncSchedulerDefaults = {
  automaticIntervalMs: AUTOMATIC_SYNC_INTERVAL_MS,
  timezone: SAO_PAULO_TIME_ZONE,
  windowStartHour: AUTOMATIC_SYNC_START_HOUR,
  windowEndHour: AUTOMATIC_SYNC_END_HOUR,
};
