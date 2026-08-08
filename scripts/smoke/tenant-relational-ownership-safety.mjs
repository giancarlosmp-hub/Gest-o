import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const opportunity = readFileSync("apps/api/src/tenancy/opportunityTenantRepository.ts", "utf8");
const activity = readFileSync("apps/api/src/tenancy/activityTenantRepository.ts", "utf8");
const tests = readFileSync("apps/api/src/tenancy/relationalTenantRepositories.test.ts", "utf8");
const workflow = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
const runtime = readFileSync("apps/api/src/routes/crudRoutes.ts", "utf8");
const sources = opportunity + activity;

for (const semantic of ["AuthTenantContext", "tenantIdFromAuthContext", "updateMany", "deleteMany", "$transaction", "client: { tenantId", "TENANT_OWNERSHIP_MISMATCH"]) assert.ok(sources.includes(semantic), `missing ${semantic}`);
for (const forbidden of ["req.", "request.", "AsyncLocalStorage", "from \"../lib/prisma", ".filter(", "continue-on-error", "|| true", "exit 77"]) assert.ok(!sources.includes(forbidden), `forbidden repository pattern: ${forbidden}`);
for (const proof of ["activity-divergent", "activity-orphan", "Promise.all", "contextVersion: 99", "opportunity-b", "relink", "moveToClient", "aggregate(contextA)"]) assert.ok(tests.includes(proof), `missing proof ${proof}`);
assert.ok(!runtime.includes("OpportunityTenantRepository") && !runtime.includes("ActivityTenantRepository"), "pilot must not be wired to controllers");
const predecessor = workflow.indexOf("Prove tenant-scoped data access isolation");
const relational = workflow.indexOf("Prove tenant relational ownership isolation");
const smoke = workflow.indexOf("Prove synthetic PostgreSQL 16 backup restore");
assert.ok(predecessor >= 0 && predecessor < relational && relational < smoke, "CI gate must be after data-access proof and before general smokes");
const gateBlock = workflow.slice(relational, smoke);
for (const bypass of ["continue-on-error", "if:", "SKIP", "exit 77", "|| true"]) assert.ok(!gateBlock.includes(bypass), `CI bypass forbidden: ${bypass}`);
console.log("TENANT_RELATIONAL_OWNERSHIP_STATIC_GATE=PASS");
