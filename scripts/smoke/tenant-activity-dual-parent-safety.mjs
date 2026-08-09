import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const harness = readFileSync("scripts/smoke/tenant-activity-dual-parent-postgres.sh", "utf8");
const ddl = readFileSync("scripts/smoke/sql/activity-dual-parent-candidate.sql", "utf8");
const workflow = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
const repository = readFileSync("apps/api/src/tenancy/activityTenantRepository.ts", "utf8");
const runtime = readFileSync("apps/api/src/routes/crudRoutes.ts", "utf8");

for (const proof of ["postgres:16", "docker exec -i", "psql -X", "ON_ERROR_STOP=1", "fixtures_before_ddl", "baseline_before_ddl", "candidate_ddl", "positive_and_null_proofs", "negative_proofs", "catalog", "concurrency", "post_diff", "rollback_proof"]) {
  assert.ok(harness.includes(proof), `missing harness proof: ${proof}`);
}
assert.ok(harness.indexOf("fixtures_before_ddl") < harness.indexOf("candidate_ddl"));
assert.ok(harness.indexOf("baseline_before_ddl") < harness.indexOf("candidate_ddl"));
for (const forbidden of ["|| true", "IF EXISTS", "incident_"]) assert.ok(!harness.includes(forbidden), `forbidden harness bypass/dependency: ${forbidden}`);
for (const candidate of ["UNIQUE INDEX", "(id, \"clientId\")", "FOREIGN KEY (\"opportunityId\", \"clientId\")", "NOT VALID", "PROOF ONLY"]) assert.ok(ddl.includes(candidate), `missing candidate DDL: ${candidate}`);
for (const xor of ["hasClient === hasOpportunity", "clientId: { not: null }, opportunityId: null", "clientId: null, opportunityId: { not: null }"]) assert.ok(repository.includes(xor), `productive XOR changed: ${xor}`);
assert.ok(!runtime.includes("ActivityTenantRepository"), "proof must not be integrated into runtime");
const relational = workflow.indexOf("Prove tenant relational ownership isolation");
const dual = workflow.indexOf("Prove Activity dual-parent enforcement on PostgreSQL 16");
const smoke = workflow.indexOf("Prove synthetic PostgreSQL 16 backup restore");
assert.ok(relational >= 0 && relational < dual && dual < smoke, "dual-parent gate ordering invalid");
const block = workflow.slice(dual, smoke);
assert.ok(block.includes("npm run test:tenant-activity-dual-parent:postgres"));
for (const bypass of ["continue-on-error", "if:", "SKIP", "exit 77", "|| true"]) assert.ok(!block.includes(bypass), `CI bypass forbidden: ${bypass}`);
console.log("TENANT_ACTIVITY_DUAL_PARENT_STATIC_GATE=PASS");
