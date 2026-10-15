import assert from "node:assert/strict";
import test from "node:test";
import { buildAlerts, CLIENT_CONTACT_QUALITY_SQL, isSyncStopped, loadPlatformHealthRuns, metricFrom, PLATFORM_HEALTH_CACHE_TTL_MS, PLATFORM_HEALTH_RECENT_RUN_LIMIT, PLATFORM_HEALTH_ROLES } from "./platformHealthService.js";
import { projectPlatformHealthRuns, type PlatformHealthRun } from "./platformHealthProjection.js";

// Horários em America/Sao_Paulo (UTC-3): 19h = 22:00Z; a janela do scheduler é 07:00–19:00.
const sp = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 7, day, hour + 3, minute));
const alertsAt = (lastSyncAt: Date | null, now: Date) => buildAlerts({ metrics: {}, lastSyncAt, durationMs: 0, averageDurationMs: 0, duplicates: 0, partnerTitlesInconsistent: 0, financialProfilesOrphaned: 0, codeChangesToday: 0 }, now);
const fakeRun = (id: string, scope: string, trigger: string, startedAt: Date): PlatformHealthRun => ({ id, scope, trigger, status: "success", startedAt, finishedAt: startedAt, durationMs: 1_000, syncedCount: 1, metrics: null, errors: null, errorMessage: null, correlationId: "round" });
// Simula findMany do Prisma para os filtros usados: startedAt >= since, OR de scope/trigger, ordem desc e take.
const fakeDb = (rows: PlatformHealthRun[]) => ({ erpSyncRun: { findMany: async ({ where, take }: any) => rows
  .filter(row => row.startedAt >= where.startedAt.gte)
  .filter(row => !where.OR || where.OR.some((kind: any) => row.scope === kind.scope && row.trigger === kind.trigger))
  .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
  .slice(0, take) } }) as any;

test("reutiliza métricas persistidas sem duplicar regras de matching", () => { assert.equal(metricFrom({ code_exact: 4 }, "code_exact"), 4); assert.equal(metricFrom(null, "code_exact"), null); });
test("permissões iniciais são restritas aos perfis operacionais", () => { for (const role of ["diretor", "gerente"]) assert.equal(PLATFORM_HEALTH_ROLES.has(role), true); assert.equal(PLATFORM_HEALTH_ROLES.has("vendedor"), false); });
test("alertas simples detectam conflito, volume, parada, lentidão e duplicidade", () => { const alerts = buildAlerts({ metrics: { documentConflicts: 2 }, lastSyncAt: new Date("2026-07-30T00:00:00Z"), durationMs: 200, averageDurationMs: 100, duplicates: 1, partnerTitlesInconsistent: 1, financialProfilesOrphaned: 1, codeChangesToday: 21 }, new Date("2026-07-31T15:00:00Z")); assert.deepEqual(new Set(alerts.map(x => x.id)), new Set(["document-conflicts","code-changes","sync-stopped","slow-sync","duplicates","partner-titles","financial-profiles"])); });
test("cache executivo evita consultas em cada render", () => assert.equal(PLATFORM_HEALTH_CACHE_TTL_MS, 60_000));
test("qualidade de contato trata espaços como ausência e evita multiplicação por join", () => {
  assert.match(CLIENT_CONTACT_QUALITY_SQL, /NOT EXISTS/);
  assert.match(CLIENT_CONTACT_QUALITY_SQL, /BTRIM\(ct\.phone\) <> ''/);
  assert.match(CLIENT_CONTACT_QUALITY_SQL, /BTRIM\(ct\.email\) <> ''/);
  assert.doesNotMatch(CLIENT_CONTACT_QUALITY_SQL, /JOIN\s+"Contact"/i);
});
test("alerta financeiro descreve o predicado JSON sem alegar órfão relacional", () => {
  const alert = buildAlerts({ metrics: {}, lastSyncAt: new Date(), durationMs: 0, averageDurationMs: 0, duplicates: 0, partnerTitlesInconsistent: 0, financialProfilesOrphaned: 1, codeChangesToday: 0 }).find(item => item.id === "financial-profiles");
  assert.equal(alert?.title, "Clientes com perfil financeiro sem títulos");
});

test("execução-pai mais antiga que as 100 linhas de etapas ainda é encontrada", async () => {
  const parent = fakeRun("parent", "automatic", "scheduler", sp(12, 8));
  const stages = Array.from({ length: PLATFORM_HEALTH_RECENT_RUN_LIMIT + 50 }, (_, index) => fakeRun(`stage-${index}`, "partners", "scheduler", sp(12, 8, 1 + (index % 50))));
  const runs = await loadPlatformHealthRuns(sp(10, 0), fakeDb([parent, ...stages]));
  const projection = projectPlatformHealthRuns(runs);
  assert.equal(projection.lastSync?.id, "parent");
  assert.equal(projection.lastAutomaticSuccess?.id, "parent");
  assert.equal(projection.successRate, 1);
  assert.equal(runs.filter(run => run.id === "parent").length, 1);
});
test("sellerPortfolio não é buscado como execução-pai", async () => {
  const runs = await loadPlatformHealthRuns(sp(10, 0), fakeDb([fakeRun("portfolio", "sellerPortfolio", "manual", sp(12, 8)), ...Array.from({ length: 120 }, (_, index) => fakeRun(`stage-${index}`, "partners", "manual", sp(12, 9)))]));
  assert.equal(projectPlatformHealthRuns(runs).lastSync, null);
});
test("sem execução-pai não há alerta com número negativo", () => {
  const alerts = alertsAt(null, sp(12, 10));
  assert.equal(alerts.some(alert => alert.id === "sync-stopped"), false);
  assert.equal(alerts.some(alert => alert.value < 0), false);
});
test("fora da janela, com última execução às 19h, não há alerta de sincronização parada", () => {
  assert.equal(isSyncStopped(sp(12, 19), sp(12, 23, 30)), false);
  assert.equal(isSyncStopped(sp(12, 19), sp(13, 6, 59)), false);
  assert.equal(alertsAt(sp(12, 19), sp(12, 23, 30)).some(alert => alert.id === "sync-stopped"), false);
});
test("início da janela tem duas horas de tolerância após a noite", () => assert.equal(isSyncStopped(sp(12, 19), sp(13, 8, 59)), false));
test("dentro da janela, com atraso real, alerta com minutos desde a última execução-pai", () => {
  const alert = alertsAt(sp(12, 19), sp(13, 10)).find(item => item.id === "sync-stopped");
  assert.equal(alert?.value, 15 * 60);
  assert.equal(isSyncStopped(sp(13, 9), sp(13, 11, 1)), true);
  assert.equal(isSyncStopped(sp(13, 9), sp(13, 10, 59)), false);
});
