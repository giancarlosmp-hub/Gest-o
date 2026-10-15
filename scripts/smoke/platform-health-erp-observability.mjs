import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Complementary wiring/architecture guard. Behavioral scenarios execute TypeScript functions in
// platformHealthProjection.test.ts; this file intentionally does not claim behavioral coverage.
const service = readFileSync("apps/api/src/services/platformHealthService.ts", "utf8");
const route = readFileSync("apps/api/src/routes/platformHealthRoutes.ts", "utf8");
const page = readFileSync("apps/web/src/pages/PlatformHealthPage.tsx", "utf8");
const projection = readFileSync("apps/api/src/services/platformHealthProjection.ts", "utf8");
const packageJson = JSON.parse(readFileSync("apps/api/package.json", "utf8"));

assert.match(service, /projectPlatformHealthRuns\(runs\)/, "collector must delegate run semantics to the pure projection");
assert.match(service, /ownerSeller:\s*\{\s*is:\s*\{\s*isActive:\s*false/, "inactive seller query must match its label");
assert.doesNotMatch(service, /ownerSellerId:\s*""/, "required ownerSellerId must not be queried as empty");
assert.match(projection, /runKind: "parent" \| "stage"/, "history must classify parent and stage rows");
assert.match(projection, /MANUAL_PARENT_RUN = \{ scope: "syncAll", trigger: "manual" \}/, "manual parent contract must be exact");
assert.match(projection, /SCHEDULER_PARENT_RUN = \{ scope: "automatic", trigger: "scheduler" \}/, "automatic parent contract must be exact");
assert.match(service, /\.\.\.PARENT_RUN_WHERE/, "parent runs must be queried directly, not filtered from the recent window");
assert.match(service, /lastSuccessfulSyncAt: lastSuccessfulParent\?\./, "sync-stopped must count from the last successful parent run");
assert.match(service, /ordersError: erpOrders\.openErrorOrders/, "order cards must read ErpOrderSync with the ERP integration rule");
assert.match(route, /collectPlatformHealthHttp\(/, "HTTP collection failure must use the sanitized error contract");
assert.match(page, /Não instrumentado/, "frontend must render null as not instrumented");
assert.match(page, /Execução-pai/, "frontend history must distinguish parent and stage");
assert.match(page, /AbortController/, "frontend must cancel stale requests");
assert.match(page, /Tentar novamente/, "frontend error state must be actionable");
assert.match(packageJson.scripts["test:platform-health"], /platformHealthProjection\.test\.ts/, "official API test command must execute behavioral projection tests");
for (const forbidden of ["ULTRAFV3_PASSWORD", "DATABASE_URL", "ERP_CREDENTIAL_ENCRYPTION_KEY"])
  assert.equal(service.includes(forbidden) || page.includes(forbidden), false, `${forbidden} must not enter the health payload`);
console.log("PLATFORM_HEALTH_ERP_OBSERVABILITY_STATIC=PASS");
