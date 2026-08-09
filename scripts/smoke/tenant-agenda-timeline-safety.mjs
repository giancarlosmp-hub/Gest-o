import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = readFileSync("apps/api/src/tenancy/agendaTimelineTenantRepositories.ts", "utf8");
const test = readFileSync("apps/api/src/tenancy/agendaTimelineTenantRepositories.test.ts", "utf8");
const routes = readFileSync("apps/api/src/routes/crudRoutes.ts", "utf8");
const workflow = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
for (const proof of ["AuthTenantContext", "tenantIdFromAuthContext", "AgendaEventTenantRepository", "TimelineEventTenantRepository", "updateMany", "deleteMany", "TENANT_OWNERSHIP_MISMATCH", "groupBy", "Includes are intentionally absent"]) assert.ok(repository.includes(proof), proof);
for (const forbidden of ["PrismaClient", "from \"../prisma", "AsyncLocalStorage", "req.", "request.", "include:"]) assert.ok(!repository.includes(forbidden), `forbidden authority/integration: ${forbidden}`);
for (const fixture of ["multi-convergent", "multi-divergent", "multi-cross", "orphan", "null-parent", "Promise.all", "args.where.OR", "independent includes are forbidden"]) assert.ok(test.includes(fixture), fixture);
assert.ok(!routes.includes("AgendaEventTenantRepository") && !routes.includes("TimelineEventTenantRepository"), "pilot connected to runtime");
const predecessor = workflow.indexOf("Prove Activity dual-parent enforcement on PostgreSQL 16");
const gate = workflow.indexOf("Prove Agenda and Timeline tenant ownership isolation");
const smoke = workflow.indexOf("Prove synthetic PostgreSQL 16 backup restore");
assert.ok(predecessor >= 0 && predecessor < gate && gate < smoke, "CI gate order invalid");
const block = workflow.slice(gate, smoke);
assert.ok(block.includes("npm run test:tenant-agenda-timeline"));
for (const bypass of ["continue-on-error", "|| true", "SKIP", "exit 77"]) assert.ok(!block.includes(bypass), bypass);
console.log("AGENDA_TIMELINE_STATIC_GATE=PASS");
