import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = readFileSync("apps/api/src/tenancy/agendaDescendantTenantRepositories.ts", "utf8");
const test = readFileSync("apps/api/src/tenancy/agendaDescendantTenantRepositories.test.ts", "utf8");
const routes = readFileSync("apps/api/src/routes/crudRoutes.ts", "utf8");
const workflow = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
for (const proof of ["AuthTenantContext", "tenantIdFromAuthContext", "AgendaStopTenantRepository", "AgendaActivityTenantRepository", "agendaEvent: agendaScope", "updateMany", "deleteMany", "authorizeAgenda", "Includes are intentionally absent"]) assert.ok(repository.includes(proof), proof);
for (const forbidden of ["PrismaClient", "from \"../prisma", "AsyncLocalStorage", "req.", "request.", "include:", ".filter("]) assert.ok(!repository.includes(forbidden), `forbidden authority/integration: ${forbidden}`);
for (const fixture of ["scross", "sorphan", "multi-source", "null-root", "parents-convergent", "parents-divergent", "activity-cross-tenant", "activity-orphan", "Promise.all", "args.where.agendaEvent?.OR"]) assert.ok(test.includes(fixture), fixture);
assert.ok(!routes.includes("AgendaStopTenantRepository") && !routes.includes("AgendaActivityTenantRepository"), "isolated adapters connected to runtime");
const predecessor = workflow.indexOf("Prove Agenda and Timeline tenant ownership isolation");
const gate = workflow.indexOf("Prove Agenda descendants tenant ownership isolation");
const smoke = workflow.indexOf("Prove synthetic PostgreSQL 16 backup restore");
assert.ok(predecessor >= 0 && predecessor < gate && gate < smoke, "CI gate order invalid");
const block = workflow.slice(gate, smoke);
assert.ok(block.includes("npm run test:tenant-agenda-descendants"));
for (const bypass of ["continue-on-error", "|| true", "SKIP", "exit 77"]) assert.ok(!block.includes(bypass), bypass);
console.log("AGENDA_DESCENDANTS_STATIC_GATE=PASS");
