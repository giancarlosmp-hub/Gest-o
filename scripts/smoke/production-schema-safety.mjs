import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const migrationDir = resolve(root, "apps/api/prisma/migrations");
const migrations = readdirSync(migrationDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFileSync(resolve(migrationDir, entry.name, "migration.sql"), "utf8"));
const approved = migrations.find((sql) => sql.includes("SAFE_PRODUCTION_SCHEMA_TRANSITION"));
assert.ok(approved, "controlled migration must exist");
assert.ok(migrations.every((sql) => !/DROP\s+(TABLE|COLUMN)[^;]*incident_/i.test(sql)), "no migration may drop incident objects");
assert.ok(migrations.every((sql) => !/TRUNCATE/i.test(sql)), "no migration may truncate data");
assert.doesNotMatch(approved, /DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE/i);
for (const table of ["ClientCodeAudit", "CommunicationIntegrationAccount", "CommunicationConversation", "CommunicationMessage", "CommunicationWebhookEvent"]) {
  assert.match(approved, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
}
assert.match(approved, /ADD COLUMN IF NOT EXISTS "phoneHash" VARCHAR\(64\)/);
assert.match(approved, /ADD COLUMN IF NOT EXISTS "phoneNormalized" VARCHAR\(32\)/);
assert.match(approved, /HAVING count\(\*\) > 1[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS/);

const preview = resolve(root, "scripts/production-schema-preview.sh");
const temporary = mkdtempSync(resolve(tmpdir(), "gesto-schema-test-"));
const maliciousSql = resolve(temporary, "destructive.sql");
writeFileSync(maliciousSql, 'DROP TABLE "incident_20260718_client_map";\n');
const malicious = spawnSync("bash", [preview], {
  cwd: root,
  env: { ...process.env, MODE: "validate", SQL_FILE: maliciousSql }, encoding: "utf8"
});
rmSync(temporary, { recursive: true });
assert.notEqual(malicious.status, 0, "preview must reject DROP");
assert.match(malicious.stdout + malicious.stderr, /BLOQUEADO/);

const apply = readFileSync(resolve(root, "scripts/production-schema-apply.sh"), "utf8");
assert.match(apply, /CONFIRM=PRODUCTION_SCHEMA_APPLY/);
assert.doesNotMatch(apply, /db push|prisma:seed|seedOnBootstrap/);
const unconfirmed = spawnSync("bash", [resolve(root, "scripts/production-schema-apply.sh")], {
  cwd: root, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8"
});
assert.notEqual(unconfirmed.status, 0, "apply must fail without explicit confirmation");
assert.match(unconfirmed.stdout + unconfirmed.stderr, /CONFIRM=PRODUCTION_SCHEMA_APPLY/);
const bootstrap = readFileSync(resolve(root, "apps/api/src/scripts/bootstrap.ts"), "utf8");
const productionBranch = bootstrap.slice(bootstrap.indexOf('NODE_ENV === "production"'), bootstrap.indexOf("} else {", bootstrap.indexOf('NODE_ENV === "production"')));
assert.doesNotMatch(productionBranch, /prisma:migrate|db push/);
assert.ok(bootstrap.indexOf("await runDatabaseBootstrap()") < bootstrap.indexOf("app.listen"));
assert.ok(bootstrap.indexOf("app.listen") < bootstrap.lastIndexOf("startErpSyncScheduler"));
const deploy = readFileSync(resolve(root, "scripts/deploy-production.sh"), "utf8");
assert.match(deploy, /schema_evidence/);
assert.doesNotMatch(deploy, /migrate down|migrate reset/);
console.log("production schema safety smoke passed");
