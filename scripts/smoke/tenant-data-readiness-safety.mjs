import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../apps/api/src/tenancy/tenantDataReadinessPreflight.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /@prisma\/client|from\s+["'][^"']*prisma/i);
assert.doesNotMatch(source, /\.\s*(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(\s*\{|\$executeRaw|\$queryRawUnsafe/i);
assert.doesNotMatch(source, /memberships\s*\[\s*0\s*\]/);
assert.doesNotMatch(source, /req\.(headers|query|body)|x-tenant/i);
for (const root of ["Client", "AgendaEvent", "Product", "AppConfig", "Goal", "ActivityKPI", "Sale", "SellerTerritoryCity", "KnowledgeDocument", "ErpSyncRun", "ErpSyncLock"]) assert.match(source, new RegExp(`"${root}"`));
for (const field of ["contractVersion", "rootsEvaluated", "aggregateHash", "blockers", "quarantineCount", "durationMs"]) assert.match(source, new RegExp(field));
console.log("TENANT_DATA_READINESS_SAFETY=PASS");
