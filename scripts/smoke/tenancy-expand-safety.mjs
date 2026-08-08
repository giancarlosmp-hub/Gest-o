import assert from "node:assert/strict";
import fs from "node:fs";

const migrationPath = "apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql";
const sql = fs.readFileSync(migrationPath, "utf8");
const roots = ["KnowledgeDocument", "Client", "AgendaEvent", "Goal", "ActivityKPI", "Sale", "SellerTerritoryCity", "AppConfig", "Product", "ErpSyncRun", "ErpSyncLock"];
const forbidden = [/\b(?:INSERT|UPDATE|DELETE)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bSET\s+NOT\s+NULL\b/i, /tenant-default-v1/i, /\b(?:Tenant|TenantMembership)\b\s+(?:DROP|ALTER\s+COLUMN)/i, /\b(?:GRANT|REVOKE|CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i];
for (const pattern of forbidden) assert.doesNotMatch(sql, pattern);
const statements = sql.split(";").map((value) => value.trim()).filter(Boolean);
assert.equal(statements.length, roots.length * 3);
for (const root of roots) {
  assert.ok(statements.includes(`ALTER TABLE "${root}" ADD COLUMN "tenantId" TEXT`));
  assert.ok(statements.includes(`CREATE INDEX "${root}_tenantId_idx" ON "${root}"("tenantId")`));
  assert.ok(statements.includes(`ALTER TABLE "${root}" ADD CONSTRAINT "${root}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")`));
}
assert.equal(new Set(statements).size, statements.length);
console.log("tenancy expand migration safety passed");
