import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repositoryPath = "apps/api/src/tenancy/clientTenantRepository.ts";
const contractPath = "apps/api/src/tenancy/tenantDataAccess.ts";
const repository = readFileSync(repositoryPath, "utf8");
const contract = readFileSync(contractPath, "utf8");
const test = readFileSync("apps/api/src/tenancy/clientTenantRepository.test.ts", "utf8");
const workflow = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
const routes = readFileSync("apps/api/src/routes/crudRoutes.ts", "utf8");

assert.match(repository, /import type \{ AuthTenantContext \}/, "pilot must explicitly consume AuthTenantContext");
assert.doesNotMatch(repository + contract, /req\.(headers|header|body|query)|AsyncLocalStorage|globalThis|memberships\[0\]/, "tenant authority cannot come from HTTP, first membership, or global context");
assert.match(repository, /findFirst\(\{ where: \{ id, tenantId:/, "ID lookup must compose id and tenantId in the Prisma predicate");
assert.match(repository, /updateMany\(\{ where: \{ id, tenantId:/, "update must compose id and tenantId in the Prisma predicate");
assert.match(repository, /deleteMany\(\{ where: \{ id, tenantId:/, "delete must compose id and tenantId in the Prisma predicate");
assert.match(repository, /rejectTenantOwnershipMutation\(data\)/, "updates must reject tenantId ownership mutation");
assert.match(test, /must send tenantId to Prisma/, "tests must inspect predicates sent to the delegate");
assert.doesNotMatch(routes, /ClientTenantRepository|tenantDataAccess/, "pilot cannot be wired to production controllers");

const authGate = workflow.indexOf("- name: Prove TenantContext auth compatibility");
const dataGate = workflow.indexOf("- name: Prove tenant-scoped data access isolation");
const firstSmoke = workflow.indexOf("- name: Prove synthetic PostgreSQL 16 backup restore");
assert.ok(authGate >= 0 && dataGate > authGate && firstSmoke > dataGate, "data-access gate must be after auth compatibility and before general smokes");
const gateBlock = workflow.slice(dataGate, firstSmoke);
assert.match(gateBlock, /run: npm run test:tenant-data-access/);
assert.doesNotMatch(gateBlock, /continue-on-error:|\bif:|exit 77|\|\| true|SKIP/i, "mandatory gate cannot bypass or suppress failure");
assert.doesNotMatch(repository + contract, /TENANCY_MODE|defaultTenant|legacy_default_only/, "additive pilot cannot activate runtime or choose a default tenant");

console.log("TENANT_DATA_ACCESS_STATIC_GATE=PASS");
