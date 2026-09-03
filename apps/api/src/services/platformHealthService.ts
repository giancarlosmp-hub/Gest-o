import { prisma } from "../config/prisma.js";
import { getErpAutomaticSyncState } from "../jobs/erpSyncScheduler.js";
import { projectAutomaticEvidence, projectPlatformHealthRuns, projectSellerQuality } from "./platformHealthProjection.js";
import { readFile } from "node:fs/promises";
import { PLATFORM_HEALTH_CONTRACT_VERSION, platformHealthSnapshotSchema } from "@salesforce-pro/shared";

export const PLATFORM_HEALTH_CACHE_TTL_MS = 60_000;
export const PLATFORM_HEALTH_ROLES = new Set(["diretor", "gerente"]);

export type Severity = "healthy" | "warning" | "critical";
type MetricMap = Record<string, number | null>;

const readUltraFv3Reachability = async () => {
  try {
    const raw = JSON.parse(await readFile("/var/run/gest-o/ultrafv3-reachability.json", "utf8"));
    if (!["available", "unavailable"].includes(raw.status) || !["ok", "auth", "timeout", "connect", "5xx"].includes(raw.reason)) throw new Error("invalid state");
    return { dataState: "available", status: raw.status, reason: raw.reason, endpointClass: "ultrafv3_read_only", durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : null, checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null };
  } catch {
    return { dataState: "empty", status: "unknown", reason: null, endpointClass: "ultrafv3_read_only", durationMs: null, checkedAt: null };
  }
};

const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
export const metricFrom = (metrics: unknown, ...keys: string[]) => {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const source = metrics as Record<string, unknown>;
  for (const key of keys) if (key in source) return numberValue(source[key]);
  return null;
};

export const buildAlerts = (input: { metrics: MetricMap; lastSyncAt: Date | null; durationMs: number; averageDurationMs: number; duplicates: number; partnerTitlesInconsistent: number; financialProfilesOrphaned: number; codeChangesToday: number }, now = new Date()) => {
  const alerts: Array<{ id: string; severity: Severity; title: string; detail: string; metric: string; value: number }> = [];
  const add = (id: string, severity: Severity, title: string, detail: string, metric: string, value: number) => alerts.push({ id, severity, title, detail, metric, value });
  if ((input.metrics.documentConflicts ?? 0) > 0) add("document-conflicts", "critical", "Conflitos documentais", "Existem correspondências ERP rejeitadas por conflito documental.", "documentConflicts", input.metrics.documentConflicts!);
  if (input.codeChangesToday > 20) add("code-changes", "warning", "Alterações de Client.code acima do limite", "Mais de 20 alterações foram auditadas hoje.", "codeChangesToday", input.codeChangesToday);
  if (!input.lastSyncAt || now.getTime() - input.lastSyncAt.getTime() > 2 * 60 * 60 * 1000) add("sync-stopped", "critical", "Sincronização parada", "Nenhuma comunicação ERP concluída nas últimas duas horas.", "minutesSinceSync", input.lastSyncAt ? Math.floor((now.getTime() - input.lastSyncAt.getTime()) / 60_000) : -1);
  if (input.averageDurationMs > 0 && input.durationMs > input.averageDurationMs * 1.5) add("slow-sync", "warning", "Sincronização acima do tempo esperado", "A última execução excedeu em 50% o tempo médio.", "durationMs", input.durationMs);
  if (input.duplicates > 0) add("duplicates", "warning", "Clientes duplicados encontrados", "Revise os documentos repetidos na qualidade dos dados.", "duplicates", input.duplicates);
  if (input.partnerTitlesInconsistent > 0) add("partner-titles", "warning", "PartnerTitles inconsistentes", "Há estruturas de títulos ausentes ou inválidas.", "partnerTitlesInconsistent", input.partnerTitlesInconsistent);
  if (input.financialProfilesOrphaned > 0) add("financial-profiles", "warning", "FinancialProfiles órfãos", "Há perfis financeiros sem títulos associados.", "financialProfilesOrphaned", input.financialProfilesOrphaned);
  return alerts;
};

let cache: { expiresAt: number; data: Awaited<ReturnType<typeof querySnapshot>> } | null = null;
const querySnapshot = async (days: 7 | 30 | 90) => {
  const since = new Date(Date.now() - days * 86_400_000);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const [runs, totalClients, archived, missingDocument, missingSeller, missingRegion, missingCity, missingState, duplicateRows, contactQualityRows, jsonQualityRows, auditToday, auditTrend] = await Promise.all([
    prisma.erpSyncRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: 100, select: { id: true, scope: true, status: true, startedAt: true, finishedAt: true, durationMs: true, syncedCount: true, metrics: true, errors: true, errorMessage: true, trigger: true, correlationId: true } }),
    prisma.client.count(), prisma.client.count({ where: { isArchived: true } }),
    prisma.client.count({ where: { OR: [{ cnpj: null }, { cnpj: "" }] } }),
    prisma.client.count({ where: { ownerSeller: { is: { isActive: false } } } }),
    prisma.client.count({ where: { region: "" } }), prisma.client.count({ where: { city: "" } }), prisma.client.count({ where: { state: "" } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COALESCE(SUM(c - 1), 0)::bigint AS count FROM (SELECT COUNT(*) c FROM "Client" WHERE "cnpjNormalized" IS NOT NULL AND "cnpjNormalized" <> '' GROUP BY "cnpjNormalized" HAVING COUNT(*) > 1) d`,
    prisma.$queryRaw<Array<{ missing_phone: bigint; missing_email: bigint }>>`SELECT COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."clientId" = c.id AND COALESCE(ct.phone, '') <> ''))::bigint AS missing_phone, COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."clientId" = c.id AND COALESCE(ct.email, '') <> ''))::bigint AS missing_email FROM "Client" c`,
    prisma.$queryRaw<Array<{ partner_titles: bigint; financial_orphans: bigint }>>`SELECT COUNT(*) FILTER (WHERE "partnerTitles" IS NOT NULL AND jsonb_typeof("partnerTitles") NOT IN ('array', 'object'))::bigint AS partner_titles, COUNT(*) FILTER (WHERE "financialProfile" IS NOT NULL AND "partnerTitles" IS NULL)::bigint AS financial_orphans FROM "Client"`,
    prisma.clientCodeAudit.count({ where: { createdAt: { gte: today } } }),
    prisma.clientCodeAudit.groupBy({ by: ["createdAt"], where: { createdAt: { gte: since } }, _count: { _all: true } })
  ]);
  const runProjection = projectPlatformHealthRuns(runs);
  const metricKeys = ["partnersReceived", "partnersUpdated", "clientsCreated", "clientsUpdated", "ordersSynced", "ordersError", "documentConflicts", "fallbackNoDocument", "codeExact", "documentExact", "rejectConflict", "createNoSafeMatch"];
  const aggregate = runProjection.parentRuns.reduce<MetricMap>((acc, run) => {
    const m = run.metrics;
    const mappings: Record<string, string[]> = { partnersReceived: ["received"], partnersUpdated: ["updated"], clientsCreated: ["created"], clientsUpdated: ["updated"], ordersSynced: ["ordersSynced", "synced"], ordersError: ["ordersError", "errors"], documentConflicts: ["documentErpConflicts", "rejected_document_conflict"], fallbackNoDocument: ["identity_fallback_no_document"], codeExact: ["code_exact"], documentExact: ["document_exact"], rejectConflict: ["rejected_document_conflict"], createNoSafeMatch: ["create_no_safe_match"] };
    for (const [target, keys] of Object.entries(mappings)) {
      const value = metricFrom(m, ...keys);
      if (value !== null) acc[target] = (acc[target] ?? 0) + value;
    }
    return acc;
  }, Object.fromEntries(metricKeys.map(key => [key, null])));
  const duplicates = Number(duplicateRows[0]?.count ?? 0);
  const partnerTitlesInconsistent = Number(jsonQualityRows[0]?.partner_titles ?? 0);
  const financialProfilesOrphaned = Number(jsonQualityRows[0]?.financial_orphans ?? 0);
  const invalidRows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Client" WHERE COALESCE("cnpj", '') <> '' AND LENGTH(REGEXP_REPLACE(COALESCE("cnpjNormalized", ''), '[^0-9]', '', 'g')) NOT IN (11, 14)`;
  const invalidDocument = Number(invalidRows[0]?.count ?? 0);
  const quality = { totalClients, missingDocument, invalidDocument, duplicates, ...projectSellerQuality(missingSeller), missingRegion, missingPortfolio: null, missingCity, missingState, missingPhone: Number(contactQualityRows[0]?.missing_phone ?? 0), missingEmail: Number(contactQualityRows[0]?.missing_email ?? 0), financialProfilesOrphaned, partnerTitlesInconsistent, archived };
  const alerts = buildAlerts({ metrics: aggregate, lastSyncAt: runProjection.lastSync?.finishedAt ?? runProjection.lastSync?.startedAt ?? null, durationMs: runProjection.lastSync?.durationMs || 0, averageDurationMs: runProjection.averageDurationMs ?? 0, duplicates, partnerTitlesInconsistent, financialProfilesOrphaned, codeChangesToday: auditToday });
  const [scheduler, locks, reachability] = await Promise.all([
    getErpAutomaticSyncState(),
    prisma.erpSyncLock.findMany({ orderBy: { lockedUntil: "desc" }, take: 20, select: { scope: true, runId: true, lockedUntil: true, updatedAt: true } }),
    readUltraFv3Reachability(),
  ]);
  const automaticEvidence = projectAutomaticEvidence(runs, { initialized: scheduler.initialized, enabled: scheduler.enabled, enabledByEnv: scheduler.enabledByEnv, nextRunAt: scheduler.nextRunAt, status: scheduler.panelStatus, lastRunAt: scheduler.lastRealSchedulerRunAt, lastSuccessAt: scheduler.lastRealSchedulerSuccessAt }, locks);
  if (!runProjection.lastSync) alerts.unshift({ id: "sync-never-observed", severity: "critical", title: "Sem execução ERP completa comprovada", detail: "Não há execução-pai concluída na janela selecionada; etapas isoladas não provam uma sincronização completa.", metric: "parentRuns", value: 0 });
  if (!runProjection.lastAutomaticSync) alerts.unshift({ id: "scheduler-run-not-proven", severity: "warning", title: "Execução automática não comprovada", detail: "Execuções manuais e etapas isoladas não comprovam o scheduler.", metric: "schedulerParentRuns", value: 0 });
  if (!scheduler.initialized || !scheduler.enabled) alerts.unshift({ id: "scheduler-inactive", severity: "critical", title: "Scheduler inativo ou não inicializado", detail: "Verifique os gates de ambiente e AppConfig.", metric: "schedulerInitialized", value: scheduler.initialized ? 1 : 0 });
  if (reachability.status === "unavailable") alerts.unshift({ id: "ultrafv3-unavailable", severity: "critical", title: "UltraFV3 indisponível", detail: "Verifique servidor Windows, Tailscale e UltraFV3Rest. A recuperação não reenvia pedidos.", metric: "erpReachability", value: 0 });
  const safeRun = (run: typeof runProjection.lastSync) => run ? ({ runKind: run.runKind, scope: run.scope, trigger: run.trigger, status: run.status, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, durationMs: run.durationMs, syncedCount: run.syncedCount }) : null;
  const safeLock = { state: automaticEvidence.lock.state, lock: automaticEvidence.lock.lock ? { scope: automaticEvidence.lock.lock.scope, lockedUntil: automaticEvidence.lock.lock.lockedUntil.toISOString(), updatedAt: automaticEvidence.lock.lock.updatedAt.toISOString() } : null };
  const dataState = runProjection.dataState === "available" && Object.values(aggregate).some(value => value === null) ? "partial" : runProjection.dataState;
  return { contractVersion: PLATFORM_HEALTH_CONTRACT_VERSION, dataState, generatedAt: new Date().toISOString(), cacheTtlSeconds: PLATFORM_HEALTH_CACHE_TTL_MS / 1000, periodDays: days, overview: { dataState, lastSync: safeRun(runProjection.lastSync), lastManualSync: safeRun(runProjection.lastManualSync), lastAutomaticSync: safeRun(runProjection.lastAutomaticSync), lastAutomaticSuccess: safeRun(runProjection.lastAutomaticSuccess), averageDurationMs: runProjection.averageDurationMs, metrics: { ...aggregate, clientCodeChanges: auditToday } }, quality: { dataState: "available", ...quality }, integration: { dataState, reachability, connected: automaticEvidence.automaticProven ? true : null, latencyMs: runProjection.lastSync?.durationMs ?? null, averageDurationMs: runProjection.averageDurationMs, successRate: runProjection.successRate, errorRate: runProjection.errorRate, retries: runProjection.retries, recentRuns: runProjection.recentRuns.slice(0, 20).map(run => safeRun(run)!), scheduler: { initialized: scheduler.initialized, enabled: scheduler.enabled, enabledByEnv: scheduler.enabledByEnv, nextRunAt: scheduler.nextRunAt, status: scheduler.panelStatus, lastRunAt: scheduler.lastRealSchedulerRunAt, lastSuccessAt: scheduler.lastRealSchedulerSuccessAt }, automaticEvidence: { schedulerState: automaticEvidence.schedulerState, automaticRunState: automaticEvidence.automaticRunState, automaticProven: automaticEvidence.automaticProven, lock: safeLock }, lock: safeLock }, trends: { clientCodeChanges: auditTrend.map(x => ({ date: x.createdAt.toISOString().slice(0, 10), value: x._count._all })), syncDuration: runProjection.parentRuns.filter(x => x.durationMs != null).map(x => ({ date: x.startedAt.toISOString().slice(0, 10), value: x.durationMs! })).reverse() }, alerts, notifications: { providers: ["slack", "teams", "email", "webhook"], status: "not_instrumented" as const } };
};

export async function getPlatformHealthSnapshot(days: 7 | 30 | 90, force = false) {
  if (!force && cache && cache.expiresAt > Date.now() && cache.data.periodDays === days) return platformHealthSnapshotSchema.parse({ ...cache.data, cacheHit: true });
  const data = await querySnapshot(days); cache = { data, expiresAt: Date.now() + PLATFORM_HEALTH_CACHE_TTL_MS }; return platformHealthSnapshotSchema.parse({ ...data, cacheHit: false });
}
