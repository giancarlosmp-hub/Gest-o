import { prisma } from "../config/prisma.js";

export const PLATFORM_HEALTH_CACHE_TTL_MS = 60_000;
export const PLATFORM_HEALTH_ROLES = new Set(["diretor", "administrador", "admin", "suporte", "ti"]);

export type Severity = "healthy" | "warning" | "critical";
type MetricMap = Record<string, number>;

const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
export const metricFrom = (metrics: unknown, ...keys: string[]) => {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return 0;
  const source = metrics as Record<string, unknown>;
  for (const key of keys) if (key in source) return numberValue(source[key]);
  return 0;
};

export const buildAlerts = (input: { metrics: MetricMap; lastSyncAt: Date | null; durationMs: number; averageDurationMs: number; duplicates: number; partnerTitlesInconsistent: number; financialProfilesOrphaned: number; codeChangesToday: number }, now = new Date()) => {
  const alerts: Array<{ id: string; severity: Severity; title: string; detail: string; metric: string; value: number }> = [];
  const add = (id: string, severity: Severity, title: string, detail: string, metric: string, value: number) => alerts.push({ id, severity, title, detail, metric, value });
  if (input.metrics.documentConflicts > 0) add("document-conflicts", "critical", "Conflitos documentais", "Existem correspondências ERP rejeitadas por conflito documental.", "documentConflicts", input.metrics.documentConflicts);
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
    prisma.erpSyncRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: 100, select: { id: true, scope: true, status: true, startedAt: true, finishedAt: true, durationMs: true, syncedCount: true, metrics: true, errors: true, errorMessage: true, trigger: true } }),
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
  const last = runs[0] ?? null;
  const completed = runs.filter(r => r.durationMs != null);
  const avgDuration = completed.length ? Math.round(completed.reduce((sum, r) => sum + (r.durationMs || 0), 0) / completed.length) : 0;
  const aggregate = runs.reduce<MetricMap>((acc, run) => {
    const m = run.metrics;
    const mappings: Record<string, string[]> = { partnersReceived: ["received"], partnersUpdated: ["updated"], clientsCreated: ["created"], clientsUpdated: ["updated"], ordersSynced: ["ordersSynced", "synced"], ordersError: ["ordersError", "errors"], documentConflicts: ["documentErpConflicts", "rejected_document_conflict"], fallbackNoDocument: ["identity_fallback_no_document"], codeExact: ["code_exact"], documentExact: ["document_exact"], rejectConflict: ["rejected_document_conflict"], createNoSafeMatch: ["create_no_safe_match"] };
    for (const [target, keys] of Object.entries(mappings)) acc[target] = (acc[target] || 0) + metricFrom(m, ...keys);
    return acc;
  }, {});
  const duplicates = Number(duplicateRows[0]?.count ?? 0);
  const partnerTitlesInconsistent = Number(jsonQualityRows[0]?.partner_titles ?? 0);
  const financialProfilesOrphaned = Number(jsonQualityRows[0]?.financial_orphans ?? 0);
  const invalidRows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Client" WHERE COALESCE("cnpj", '') <> '' AND LENGTH(REGEXP_REPLACE(COALESCE("cnpjNormalized", ''), '[^0-9]', '', 'g')) NOT IN (11, 14)`;
  const invalidDocument = Number(invalidRows[0]?.count ?? 0);
  const quality = { totalClients, missingDocument, invalidDocument, duplicates, missingSeller, missingRegion, missingPortfolio: missingSeller, missingCity, missingState, missingPhone: Number(contactQualityRows[0]?.missing_phone ?? 0), missingEmail: Number(contactQualityRows[0]?.missing_email ?? 0), financialProfilesOrphaned, partnerTitlesInconsistent, archived };
  const alerts = buildAlerts({ metrics: aggregate, lastSyncAt: last?.finishedAt ?? last?.startedAt ?? null, durationMs: last?.durationMs || 0, averageDurationMs: avgDuration, duplicates, partnerTitlesInconsistent, financialProfilesOrphaned, codeChangesToday: auditToday });
  const success = runs.filter(r => r.status === "success").length;
  return { generatedAt: new Date().toISOString(), cacheTtlSeconds: PLATFORM_HEALTH_CACHE_TTL_MS / 1000, periodDays: days, overview: { lastSync: last, averageDurationMs: avgDuration, metrics: { ...aggregate, clientCodeChanges: auditToday } }, quality, integration: { connected: Boolean(last && last.status !== "error"), lastCommunication: last?.finishedAt ?? last?.startedAt ?? null, latencyMs: last?.durationMs ?? null, averageDurationMs: avgDuration, successRate: runs.length ? success / runs.length : 0, errorRate: runs.length ? runs.filter(r => r.status === "error").length / runs.length : 0, retries: runs.filter(r => r.status === "skipped").length, recentRuns: runs.slice(0, 20) }, trends: { clientCodeChanges: auditTrend.map(x => ({ date: x.createdAt.toISOString().slice(0, 10), value: x._count._all })), syncDuration: completed.map(x => ({ date: x.startedAt.toISOString().slice(0, 10), value: x.durationMs || 0 })).reverse() }, alerts, notifications: { providers: ["slack", "teams", "email", "webhook"], status: "abstraction-only" } };
};

export async function getPlatformHealthSnapshot(days: 7 | 30 | 90, force = false) {
  if (!force && cache && cache.expiresAt > Date.now() && cache.data.periodDays === days) return { ...cache.data, cacheHit: true };
  const data = await querySnapshot(days); cache = { data, expiresAt: Date.now() + PLATFORM_HEALTH_CACHE_TTL_MS }; return { ...data, cacheHit: false };
}
