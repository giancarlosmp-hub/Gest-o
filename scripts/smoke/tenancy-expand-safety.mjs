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

const harness = fs.readFileSync("scripts/smoke/tenancy-expand-postgres.sh", "utf8");
assert.doesNotMatch(harness, /docker image inspect node:20|\bnode:20\b/);
assert.doesNotMatch(harness, /\brg\b/);
assert.match(harness, /grep -Fxc 'DROP TABLE "incident_synthetic";'/);
assert.match(harness, /image=\$\{API_IMAGE:-gest-o-api:\$sha\}/);
assert.match(harness, /required pinned API tooling image unavailable[\s\S]*exit 1/);
assert.match(harness, /command -v docker[\s\S]*exit 77/);
assert.match(harness, /POSTGRES_DB=expand/);
const readinessCommand = /docker exec -i "\$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d expand -qAt -c 'SELECT 1;'/g;
assert.equal((harness.match(readinessCommand) ?? []).length, 2);
assert.match(harness, /for readiness_attempt in \{1\.\.60\}; do/);
assert.match(harness, /readiness_exit=\$\?/);
assert.match(harness, /wc -l < "\$tmp\/readiness\.out"/);
assert.match(harness, /grep -Fqx '1' "\$tmp\/readiness\.out"/);
assert.match(harness, /step postgres_readiness "wait for expand database SQL readiness"\s+HARNESS_RESULT=RUNNING/);
const readinessLoopEnd = harness.indexOf('[[ "$expand_ready" == true ]]');
const finalReadiness = harness.indexOf('HARNESS_COMMAND="validate final independent expand database SQL connection"');
const readinessPass = harness.indexOf("TENANCY_EXPAND_DATABASE_READINESS=PASS");
const urlDefinition = harness.indexOf('url="postgresql://');
const firstTooling = harness.indexOf("run_tooling(){");
const predecessorMaterialization = harness.indexOf("step predecessor_materialization");
const fixturesStart = harness.indexOf("step fixtures");
const migrationApplyStart = harness.indexOf("step migration_apply");
assert.ok(readinessLoopEnd >= 0 && readinessLoopEnd < finalReadiness && finalReadiness < readinessPass && readinessPass < urlDefinition && readinessPass < firstTooling && readinessPass < predecessorMaterialization && readinessPass < fixturesStart && readinessPass < migrationApplyStart);
assert.match(harness, /final_readiness_exit=\$\?[\s\S]*\[\[ \$final_readiness_exit -eq 0 \]\][\s\S]*readiness-final\.err[\s\S]*wc -l < "\$tmp\/readiness-final\.out"[\s\S]*grep -Fqx '1' "\$tmp\/readiness-final\.out"/);
assert.doesNotMatch(harness, /pg_isready|CREATE DATABASE\s+expand|-d postgres(?:\s|$)|-d template1(?:\s|$)|docker run[^\n]*(?:\s-p\s|--publish)|\beval\b|set -x/i);
assert.match(harness, /--diff-filter=A -- apps\/api\/prisma\/migrations\/20260808120000_tenancy_expand_roots\/migration\.sql/);
assert.doesNotMatch(harness, /git show HEAD:apps\/api\/prisma\/schema\.prisma/);
for (const token of ["docker_network_setup", "postgres_readiness", "predecessor_materialization", "migration_apply", "catalog_validation", "fixtures", "fk_negative_test", "unique_negative_test", "post_diff", "HARNESS_STEP=", "HARNESS_COMMAND=", "HARNESS_RESULT=FAIL", "EXIT_CODE="]) assert.ok(harness.includes(token), token);
console.log("tenancy expand harness contract passed");

const createIncident = harness.indexOf('CREATE TABLE public."incident_synthetic"');
const verifyIncident = harness.indexOf("SELECT to_regclass('public.incident_synthetic') IS NOT NULL");
const baselineIncident = harness.indexOf('SELECT count(*) FROM public."incident_synthetic"');
const migrationApply = harness.indexOf('step migration_apply');
const preservationCheck = harness.indexOf('HARNESS_COMMAND="verify synthetic incident preservation after migration"');
assert.ok(createIncident >= 0 && createIncident < verifyIncident && verifyIncident < baselineIncident && baselineIncident < migrationApply && migrationApply < preservationCheck);
assert.match(harness.slice(harness.indexOf('step fixtures'), migrationApply), /docker exec -i "\$pg" psql[^]*CREATE TABLE public\."incident_synthetic"/);
assert.doesNotMatch(harness.slice(harness.indexOf('step fixtures'), harness.indexOf('step post_diff')), /\|\| true/);
assert.doesNotMatch(harness, /incident_2026|incident_2025|incident_2024/);
assert.match(harness.slice(preservationCheck), /to_regclass\('public\.incident_synthetic'\)[^]*count\(\*\) FROM public\."incident_synthetic"[^]*contype='p'/);

const readinessDecision = ({ database, exitCode, stdout, stderr }) => database === "expand" && exitCode === 0 && stdout === "1\n" && stderr === "";
assert.equal(readinessDecision({ database: "expand", exitCode: 0, stdout: "1\n", stderr: "" }), true);
for (const rejected of [
  { database: "expand", exitCode: 1, stdout: "1\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "0\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "1\n1\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "SELECT 1\n1\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "SELECT 1\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: " 1\n", stderr: "" },
  { database: "postgres", exitCode: 0, stdout: "1\n", stderr: "" },
  { database: "template1", exitCode: 0, stdout: "1\n", stderr: "" },
  { database: "expand", exitCode: 0, stdout: "1\n", stderr: "1\n" },
]) assert.equal(readinessDecision(rejected), false);
