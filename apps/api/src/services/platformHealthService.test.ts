import assert from "node:assert/strict";
import test from "node:test";
import { buildAlerts, metricFrom, PLATFORM_HEALTH_CACHE_TTL_MS, PLATFORM_HEALTH_ROLES } from "./platformHealthService.js";

test("reutiliza métricas persistidas sem duplicar regras de matching", () => { assert.equal(metricFrom({ code_exact: 4 }, "code_exact"), 4); assert.equal(metricFrom(null, "code_exact"), null); });
test("permissões iniciais são restritas aos perfis operacionais", () => { for (const role of ["diretor", "gerente"]) assert.equal(PLATFORM_HEALTH_ROLES.has(role), true); assert.equal(PLATFORM_HEALTH_ROLES.has("vendedor"), false); });
test("alertas simples detectam conflito, volume, parada, lentidão e duplicidade", () => { const alerts = buildAlerts({ metrics: { documentConflicts: 2 }, lastSyncAt: new Date("2026-07-30T00:00:00Z"), durationMs: 200, averageDurationMs: 100, duplicates: 1, partnerTitlesInconsistent: 1, financialProfilesOrphaned: 1, codeChangesToday: 21 }, new Date("2026-07-31T00:00:00Z")); assert.deepEqual(new Set(alerts.map(x => x.id)), new Set(["document-conflicts","code-changes","sync-stopped","slow-sync","duplicates","partner-titles","financial-profiles"])); });
test("cache executivo evita consultas em cada render", () => assert.equal(PLATFORM_HEALTH_CACHE_TTL_MS, 60_000));
