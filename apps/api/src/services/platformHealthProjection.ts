export type PlatformHealthRun = {
  id: string;
  scope: string;
  trigger: "manual" | "scheduler" | string;
  status: "running" | "success" | "error" | "skipped" | string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  syncedCount: number;
  metrics: unknown;
  errors: unknown;
  errorMessage: string | null;
  correlationId: string | null;
};

export type ClassifiedPlatformHealthRun = PlatformHealthRun & {
  runKind: "parent" | "stage";
  parentCorrelationId: string | null;
};

export type SchedulerEvidence = {
  initialized: boolean;
  enabled: boolean;
  enabledByEnv: boolean;
  nextRunAt: string | null;
  status: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
};

export type SyncLockEvidence = {
  scope: string;
  runId: string;
  lockedUntil: Date;
  updatedAt: Date;
};

const byNewest = <T extends PlatformHealthRun>(left: T, right: T) =>
  right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id);

// Execução-pai completa: "Sincronização Completa" (syncAll manual) e o scheduler (automatic).
// sellerPortfolio e etapas isoladas não são execução-pai.
export const MANUAL_PARENT_RUN = { scope: "syncAll", trigger: "manual" } as const;
export const SCHEDULER_PARENT_RUN = { scope: "automatic", trigger: "scheduler" } as const;
// Filtro de banco com o mesmo critério dos predicados abaixo; usa o índice (scope, startedAt).
export const PARENT_RUN_WHERE = { OR: [{ ...MANUAL_PARENT_RUN }, { ...SCHEDULER_PARENT_RUN }] };

const matches = (run: PlatformHealthRun, kind: typeof MANUAL_PARENT_RUN | typeof SCHEDULER_PARENT_RUN) => run.scope === kind.scope && run.trigger === kind.trigger;
// "Executar agora" grava scope automatic/trigger scheduler com metrics.origin = "run_now".
export const isRunNowParent = (run: PlatformHealthRun) => matches(run, SCHEDULER_PARENT_RUN) && Boolean(run.metrics && typeof run.metrics === "object" && (run.metrics as Record<string, unknown>).origin === "run_now");
export const isManualParent = (run: PlatformHealthRun) => matches(run, MANUAL_PARENT_RUN) || isRunNowParent(run);
export const isAutomaticParent = (run: PlatformHealthRun) => matches(run, SCHEDULER_PARENT_RUN) && !isRunNowParent(run);
export const isParentRun = (run: PlatformHealthRun) => matches(run, MANUAL_PARENT_RUN) || matches(run, SCHEDULER_PARENT_RUN);

// Junta as execuções-pai buscadas diretamente com as linhas recentes, sem duplicar por id.
export const mergePlatformHealthRuns = <T extends PlatformHealthRun>(parentRuns: T[], recentRuns: T[]) =>
  [...new Map([...recentRuns, ...parentRuns].map(run => [run.id, run])).values()];

export function classifyPlatformHealthRuns(runs: PlatformHealthRun[]): ClassifiedPlatformHealthRun[] {
  const parentCorrelations = new Set(runs.filter(isParentRun).map(run => run.correlationId).filter((id): id is string => Boolean(id)));
  return [...runs].sort(byNewest).map(run => ({
    ...run,
    runKind: isParentRun(run) ? "parent" : "stage",
    parentCorrelationId: !isParentRun(run) && run.correlationId && parentCorrelations.has(run.correlationId) ? run.correlationId : null,
  }));
}

export function projectPlatformHealthRuns(runs: PlatformHealthRun[]) {
  const recentRuns = classifyPlatformHealthRuns(runs);
  const parentRuns = recentRuns.filter(run => run.runKind === "parent");
  const completedParents = parentRuns.filter(run => run.status !== "running");
  const manualParents = completedParents.filter(isManualParent);
  const automaticParents = completedParents.filter(isAutomaticParent);
  const successfulAutomaticParents = automaticParents.filter(run => run.status === "success");
  const lastSync = completedParents[0] ?? null;
  const durations = completedParents.flatMap(run => run.durationMs == null ? [] : [run.durationMs]);
  const successes = completedParents.filter(run => run.status === "success").length;
  const errors = completedParents.filter(run => run.status === "error").length;

  return {
    dataState: completedParents.length ? "available" as const : "empty" as const,
    lastSync,
    lastManualSync: manualParents[0] ?? null,
    lastAutomaticSync: automaticParents[0] ?? null,
    lastAutomaticSuccess: successfulAutomaticParents[0] ?? null,
    parentRuns,
    stageRuns: recentRuns.filter(run => run.runKind === "stage"),
    recentRuns,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    successRate: completedParents.length ? successes / completedParents.length : null,
    errorRate: completedParents.length ? errors / completedParents.length : null,
    retries: completedParents.length ? completedParents.filter(run => run.status === "skipped").length : null,
  };
}

export function projectLockState(locks: SyncLockEvidence[], now = new Date()) {
  const sorted = [...locks].sort((left, right) => right.lockedUntil.getTime() - left.lockedUntil.getTime());
  const active = sorted.find(lock => lock.lockedUntil.getTime() > now.getTime()) ?? null;
  if (active) return { state: "active" as const, lock: active };
  if (sorted.length) return { state: "expired_recoverable" as const, lock: sorted[0] };
  return { state: "free" as const, lock: null };
}

export function projectAutomaticEvidence(runs: PlatformHealthRun[], scheduler: SchedulerEvidence, locks: SyncLockEvidence[], now = new Date()) {
  const projection = projectPlatformHealthRuns(runs);
  const lock = projectLockState(locks, now);
  const automaticProven = Boolean(
    scheduler.initialized && scheduler.enabled && projection.lastAutomaticSuccess && lock.state !== "active",
  );
  return {
    schedulerState: !scheduler.initialized ? "not_initialized" as const : !scheduler.enabled ? "disabled" as const : "enabled" as const,
    automaticRunState: projection.lastAutomaticSync ? projection.lastAutomaticSync.status : "not_proven",
    automaticProven,
    lock,
  };
}

export const projectAuditDataState = (total: number) => total > 0 ? "available" as const : "empty" as const;
export const projectSellerQuality = (inactiveSeller: number) => ({ inactiveSeller, missingSeller: null });
export const platformHealthCollectionError = () => ({ contractVersion: "3.0", dataState: "error" as const, code: "PLATFORM_HEALTH_COLLECTION_FAILED", message: "Não foi possível coletar a Saúde da Plataforma." });
export async function collectPlatformHealthHttp<T>(collector: () => Promise<T>) {
  try {
    return { status: 200 as const, body: await collector() };
  } catch {
    return { status: 503 as const, body: platformHealthCollectionError() };
  }
}
