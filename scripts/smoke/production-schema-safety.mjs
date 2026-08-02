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
assert.doesNotMatch(approved, /"updatedAt" TIMESTAMP\(3\) NOT NULL DEFAULT/);
const generated = spawnSync(resolve(root, "node_modules/.bin/prisma"), ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "apps/api/prisma/schema.prisma", "--script"], { cwd: root, encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const expectedIndexes = [...generated.stdout.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "(?:ClientCodeAudit|Contact|Communication[^"]+)"/g)].map((match) => match[1]);
for (const name of expectedIndexes) assert.match(approved, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "${name}"`), `missing Prisma index name ${name}`);

const postgresSmoke = readFileSync(resolve(root, "scripts/smoke/production-schema-postgres.sh"), "utf8");
const predecessorCheckpoint = readFileSync(resolve(root, "scripts/schema-predecessor-checkpoint.mjs"), "utf8");
for (const name of ["TenantStatus", "TenantMembershipStatus", "TenantRole", "Tenant", "TenantMembership", "Tenant_slug_key", "TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"]) {
  assert.match(predecessorCheckpoint, new RegExp(name), `strict predecessor checkpoint must recognize ${name}`);
}
assert.doesNotMatch(predecessorCheckpoint, /Communication|ClientCodeAudit|Contact|AgendaEvent/, "checkpoint allowlist must not accept predecessor residual DDL");
const checkpointDir = mkdtempSync(resolve(tmpdir(), "gesto-predecessor-checkpoint-"));
const checkpointAllowed = resolve(checkpointDir, "allowed.sql");
const checkpointResidual = resolve(checkpointDir, "residual.sql");
writeFileSync(checkpointAllowed, 'CREATE TYPE "TenantStatus" AS ENUM (\'active\', \'suspended\', \'archived\');\nCREATE TABLE "Tenant" ("id" TEXT NOT NULL);\nCREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");\n');
writeFileSync(checkpointResidual, 'ALTER TABLE "ClientCodeAudit" ADD CONSTRAINT "ClientCodeAudit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id");\n');
const checkpointAccepted = spawnSync("node", [resolve(root, "scripts/schema-predecessor-checkpoint.mjs"), checkpointAllowed], { encoding: "utf8" });
const checkpointRejected = spawnSync("node", [resolve(root, "scripts/schema-predecessor-checkpoint.mjs"), checkpointResidual], { encoding: "utf8" });
rmSync(checkpointDir, { recursive: true });
assert.equal(checkpointAccepted.status, 0, checkpointAccepted.stderr);
assert.notEqual(checkpointRejected.status, 0, "predecessor residual FK must fail the intermediate checkpoint");
assert.match(postgresSmoke, /APP_COMMIT=\$\{APP_COMMIT:-\$\{EXPECTED_SHA:-\}\}/, "disposable test must require the tested SHA");
assert.match(postgresSmoke, /API_IMAGE=\$\{API_IMAGE:-"gest-o-api:\$\{APP_COMMIT\}"\}/, "API image must default to the tested SHA");
assert.match(postgresSmoke, /docker image inspect "\$API_IMAGE"/);
assert.match(postgresSmoke, /org\.opencontainers\.image\.revision/);
assert.match(postgresSmoke, /image_revision" != "\$APP_COMMIT"/);
assert.match(postgresSmoke, /docker network create "\$NETWORK_NAME"/);
assert.match(postgresSmoke, /--network "\$NETWORK_NAME"/);
assert.match(postgresSmoke, /--pull=never/);
assert.doesNotMatch(postgresSmoke, /docker run[^\n]*\s-p(?:\s|$)/, "PostgreSQL must not publish a host port");
assert.doesNotMatch(postgresSmoke, /^\s*-p(?:\s|$)/m, "multiline docker arguments must not publish a host port");
assert.doesNotMatch(postgresSmoke, /(?:source|\.)\s+[^\n]*production\.env/, "test must not load production.env");
assert.match(postgresSmoke, /reject_production_target "\$\{TEST_DATABASE_URL:-\}"/);
assert.match(postgresSmoke, /reject_production_target "\$\{DATABASE_URL:-\}"/);
assert.match(postgresSmoke, /gest-o-db-clean-v2-20260717/);
assert.match(postgresSmoke, /PRODUCTION_DB_HOST_EXPECTED/);
assert.match(postgresSmoke, /localhost/);
assert.match(postgresSmoke, /127\.0\.0\.1/);
assert.match(postgresSmoke, /salesforce_pro/);
assert.match(postgresSmoke, /gest-o_default/);
assert.match(postgresSmoke, /docker rm -f "\$PG_NAME"[\s\S]*docker network rm "\$NETWORK_NAME"[\s\S]*rm -rf "\$tmp"/, "trap cleanup must remove every disposable resource");
assert.match(postgresSmoke, /prisma_diff\(\)[\s\S]*docker run --rm[\s\S]*"\$API_IMAGE"[\s\S]*\.\/node_modules\/\.bin\/prisma migrate diff/, "Prisma must run inside the API image");
assert.equal((postgresSmoke.match(/prisma_diff --/g) ?? []).length, 6, "full generation and all five schema scenarios must use containerized Prisma");
assert.equal((postgresSmoke.match(/\.\/node_modules\/\.bin\/prisma/g) ?? []).length, 1, "the Prisma binary may only appear in the docker run wrapper");
for (const scenario of ["recovered.sql", "before", "after-first", "post.raw.sql", "after-second", "post2.raw.sql", "partial.raw.sql"]) {
  assert.match(postgresSmoke, new RegExp(scenario.replace(".", "\\.")), `missing disposable migration scenario: ${scenario}`);
}
assert.match(postgresSmoke, /DROP TABLE "TenantMembership", "Tenant";/, "recovered fixture must not start with an already materialized control plane");
assert.match(postgresSmoke, /DROP TYPE "TenantMembershipStatus", "TenantRole", "TenantStatus";/, "recovered fixture must not retain control-plane enums");
assert.equal(
  (postgresSmoke.match(/<apps\/api\/prisma\/migrations\/20260731150000_safe_production_schema_transition\/migration\.sql/g) ?? []).length,
  1,
  "predecessor migration must be executed exactly once"
);
assert.equal(
  (postgresSmoke.match(/<apps\/api\/prisma\/migrations\/20260802120000_tenancy_control_plane\/migration\.sql/g) ?? []).length,
  1,
  "control-plane migration must be executed exactly once"
);
for (const checkpoint of ["fixture-base.tsv", "after-predecessor.tsv", "after-control-plane.tsv", "after-predecessor-diff.raw.sql", "after-predecessor-diff.sql", "after-predecessor-catalog.tsv"]) {
  assert.match(postgresSmoke, new RegExp(checkpoint.replaceAll(".", "\\.")), `missing structural checkpoint ${checkpoint}`);
}
assert.match(postgresSmoke, /schema-predecessor-checkpoint\.mjs "\$tmp\/after-predecessor-diff\.sql"/, "predecessor checkpoint must have a dedicated strict validator");
assert.match(postgresSmoke, /AFTER PREDECESSOR RAW DIFF[\s\S]*AFTER PREDECESSOR MANAGED DIFF[\s\S]*AFTER PREDECESSOR CATALOG/, "intermediate failure must expose all checkpoint evidence");
assert.match(postgresSmoke, /expected-predecessor-fks\.tsv[\s\S]*cmp "\$tmp\/expected-predecessor-fks\.tsv" "\$tmp\/after-predecessor-fks\.tsv"/, "every predecessor FK definition must be verified before control plane");
assert.match(postgresSmoke, /cmp "\$tmp\/after-predecessor-fks\.tsv" "\$tmp\/after-control-plane-fks\.tsv"/, "control plane must preserve every predecessor FK");
assert.match(postgresSmoke, /schema-diff-filter\.mjs "\$tmp\/post\.raw\.sql" "\$tmp\/post\.sql" post[\s\S]*test ! -s "\$tmp\/post\.sql"/, "final managed diff must remain strictly empty");
assert.match(postgresSmoke, /set \+e[\s\S]*schema-diff-filter\.mjs "\$tmp\/post\.raw\.sql" "\$tmp\/post\.sql" post[\s\S]*FILTER_STATUS=\$\?[\s\S]*set -e/, "post-filter exit code must be captured without weakening fail-fast globally");
assert.match(postgresSmoke, /if \[\[ "\$FILTER_STATUS" -ne 0 \]\]; then[\s\S]*POST-APPLY PRISMA DIFF RAW[\s\S]*cat "\$tmp\/post\.raw\.sql"[\s\S]*POST-APPLY MANAGED DIFF[\s\S]*cat "\$tmp\/post\.sql"[\s\S]*CONTROL-PLANE STRUCTURAL CATALOG[\s\S]*cat "\$tmp\/control-plane-catalog\.tsv"[\s\S]*exit "\$FILTER_STATUS"/, "failed post-filter must expose structural evidence and preserve failure");
assert.match(postgresSmoke, /information_schema\.columns[\s\S]*pg_indexes[\s\S]*pg_constraint/, "diagnostic catalog must cover columns, indexes, FKs and checks");
assert.doesNotMatch(postgresSmoke, /result\.tsv/, "disposable harness must not publish PASS evidence");
const diagnosticFailure = postgresSmoke.slice(postgresSmoke.indexOf('if [[ "$FILTER_STATUS" -ne 0 ]]'), postgresSmoke.indexOf('test ! -s "$tmp/post.sql"'));
assert.doesNotMatch(diagnosticFailure, /DATABASE_URL|PASSWORD|email|token|secret|SELECT \*/, "failure diagnostics must not expose connection secrets or row data");

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
assert.match(apply, /PSQL_DATABASE_URL=\$\(DATABASE_URL="\$DATABASE_URL" node scripts\/postgres-connection-url\.mjs\)/);
assert.doesNotMatch(apply, /psql\s+"\$DATABASE_URL"/, "Prisma DATABASE_URL must never be sent directly to psql");
assert.match(apply, /PRODUCTION_DB_CONTAINER_REQUIRED=gest-o-db-clean-v2-20260717/);
assert.match(apply, /docker exec --user postgres -i "\$PRODUCTION_DB_CONTAINER_EXPECTED"[\s\S]*psql --dbname="\$DB_NAME" -X -v ON_ERROR_STOP=1/);
assert.match(apply, /admin_psql --single-transaction -f - < "\$MIGRATION"/);
assert.match(apply, /current_database\(\)[\s\S]*current_user/);
assert.doesNotMatch(apply, /POSTGRES_PASSWORD|GRANT\s+CREATE|ALTER\s+SCHEMA[\s\S]*OWNER|ALTER\s+TABLE[\s\S]*OWNER/i);
assert.doesNotMatch(apply, /docker\s+compose\s+down|docker\s+volume\s+rm|docker\s+(?:rm|volume rm)[^\n]*postgres/i);
assert.ok(apply.indexOf("incident.after.tsv") < apply.indexOf("post-apply-diff.sql"));

const prismaUrl = "postgresql://user:p%40ss@db.example:5433/gesto?schema=public&sslmode=require&connection_limit=8";
const sanitized = spawnSync("node", [resolve(root, "scripts/postgres-connection-url.mjs"), prismaUrl], { encoding: "utf8" });
assert.equal(sanitized.status, 0, sanitized.stderr);
const sanitizedUrl = new URL(sanitized.stdout);
assert.equal(sanitizedUrl.username, "user");
assert.equal(sanitizedUrl.password, "p%40ss");
assert.equal(sanitizedUrl.hostname, "db.example");
assert.equal(sanitizedUrl.port, "5433");
assert.equal(sanitizedUrl.pathname, "/gesto");
assert.equal(sanitizedUrl.searchParams.get("sslmode"), "require");
assert.equal(sanitizedUrl.searchParams.has("schema"), false);
assert.equal(sanitizedUrl.searchParams.has("connection_limit"), false);

for (const script of readdirSync(resolve(root, "scripts"), { recursive: true })
  .filter((name) => name.endsWith(".sh"))) {
  const source = readFileSync(resolve(root, "scripts", script), "utf8");
  assert.doesNotMatch(source, /psql[^\n]*\$DATABASE_URL/, `${script} sends Prisma DATABASE_URL directly to psql`);
}
const unconfirmed = spawnSync("bash", [resolve(root, "scripts/production-schema-apply.sh")], {
  cwd: root, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8"
});
assert.notEqual(unconfirmed.status, 0, "apply must fail without explicit confirmation");
assert.match(unconfirmed.stdout + unconfirmed.stderr, /CONFIRM=PRODUCTION_SCHEMA_APPLY/);
assert.match(apply, /pre-apply-diff\.raw\.sql[\s\S]*schema-diff-filter\.mjs[\s\S]*--single-transaction/);
assert.match(apply, /post-apply-diff\.raw\.sql[\s\S]*post-apply-diff\.sql[\s\S]*result\.tsv[\s\S]*schema-state\.tsv/);
assert.ok(apply.indexOf("post-apply-diff.sql") < apply.indexOf('>"$evidence/result.tsv"'), "evidence must only be released after empty Prisma diff");
assert.match(postgresSmoke, /CREATE ROLE runtime/);
assert.match(postgresSmoke, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
assert.match(postgresSmoke, /psql -U runtime[\s\S]*--single-transaction/);
assert.match(postgresSmoke, /rollback_probe[\s\S]*missing_mid_migration[\s\S]*to_regclass/);
const partialDir = mkdtempSync(resolve(tmpdir(), "gesto-schema-partial-"));
const partialSql = resolve(partialDir, "partial.sql");
const partialOut = resolve(partialDir, "out.sql");
writeFileSync(partialSql, 'ALTER TABLE "CommunicationMessage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;\n');
const partial = spawnSync("node", [resolve(root, "scripts/schema-diff-filter.mjs"), partialSql, partialOut, "pre"], { encoding: "utf8" });
rmSync(partialDir, { recursive: true });
assert.notEqual(partial.status, 0, "partial/incompatible target table must fail preflight");

function assertContactDiff(name, sql, accepted) {
  const testDir = mkdtempSync(resolve(tmpdir(), "gesto-contact-diff-"));
  const input = resolve(testDir, "input.sql");
  const output = resolve(testDir, "output.sql");
  writeFileSync(input, sql);
  const result = spawnSync("node", [resolve(root, "scripts/schema-diff-filter.mjs"), input, output, "pre"], { encoding: "utf8" });
  rmSync(testDir, { recursive: true });
  assert.equal(result.status === 0, accepted, `${name}: ${result.stdout}${result.stderr}`);
}

assertContactDiff("grouped Contact columns", `ALTER TABLE "Contact"
ADD COLUMN "phoneHash" VARCHAR(64),
ADD COLUMN "phoneNormalized" VARCHAR(32);`, true);
assertContactDiff("grouped Contact columns in reverse order", `ALTER TABLE "Contact"
ADD COLUMN "phoneNormalized" VARCHAR(32),
ADD COLUMN "phoneHash" VARCHAR(64);`, true);
assertContactDiff("separate Contact statements", `ALTER TABLE "Contact" ADD COLUMN "phoneHash" VARCHAR(64);
ALTER TABLE "Contact" ADD COLUMN "phoneNormalized" VARCHAR(32);`, true);
assertContactDiff("unexpected third Contact column", `ALTER TABLE "Contact"
ADD COLUMN "phoneHash" VARCHAR(64),
ADD COLUMN "phoneNormalized" VARCHAR(32),
ADD COLUMN "unexpected" TEXT;`, false);
assertContactDiff("wrong Contact column size", 'ALTER TABLE "Contact" ADD COLUMN "phoneHash" VARCHAR(32);', false);
assertContactDiff("non-null Contact column", 'ALTER TABLE "Contact" ADD COLUMN "phoneHash" VARCHAR(64) NOT NULL;', false);
assertContactDiff("defaulted Contact column", `ALTER TABLE "Contact" ADD COLUMN "phoneHash" VARCHAR(64) DEFAULT 'x';`, false);
assertContactDiff("altered Contact column", `ALTER TABLE "Contact" ALTER COLUMN "phoneHash" SET DEFAULT 'x';`, false);
assertContactDiff("dropped Contact column", 'ALTER TABLE "Contact" DROP COLUMN "phoneHash";', false);
assertContactDiff("mixed Contact operations", `ALTER TABLE "Contact"
ADD COLUMN "phoneHash" VARCHAR(64),
DROP COLUMN "phoneNormalized";`, false);
const bootstrap = readFileSync(resolve(root, "apps/api/src/scripts/bootstrap.ts"), "utf8");
assert.match(bootstrap, /type DatabaseSchemaMode = "external" \| "ephemeral-push"/);
assert.match(bootstrap, /if \(value === "external" \|\| value === "ephemeral-push"\) return value/);
const externalBranch = bootstrap.slice(bootstrap.indexOf('schemaMode === "external"'), bootstrap.indexOf("} else if", bootstrap.indexOf('schemaMode === "external"')));
assert.doesNotMatch(externalBranch, /prisma:migrate|db push|ensureErpOrderNumberSequence/);
assert.match(bootstrap, /schemaMode === "ephemeral-push"[\s\S]*prisma:migrate/);
assert.match(bootstrap, /schemaMode === "ephemeral-push" && env\.seedOnBootstrap/);
assert.match(bootstrap, /schemaMode === "ephemeral-push" && env\.enableSmokeBootstrap/);
assert.ok(bootstrap.indexOf("await runDatabaseBootstrap()") < bootstrap.indexOf("app.listen"));
assert.ok(bootstrap.indexOf("app.listen") < bootstrap.lastIndexOf("startErpSyncScheduler"));
const deploy = readFileSync(resolve(root, "scripts/deploy-production.sh"), "utf8");
assert.match(deploy, /schema_evidence/);
assert.doesNotMatch(deploy, /migrate down|migrate reset/);
const productionCompose = readFileSync(resolve(root, "docker-compose.production.yml"), "utf8");
assert.match(productionCompose, /DATABASE_SCHEMA_MODE:\s*external/);
assert.doesNotMatch(productionCompose, /DATABASE_SCHEMA_MODE:\s*\$\{/);
assert.match(productionCompose, /SEED_ON_BOOTSTRAP:\s*"false"/);
const disposableCompose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const previewCompose = readFileSync(resolve(root, "docker-compose.preview.yml"), "utf8");
assert.match(disposableCompose, /DATABASE_SCHEMA_MODE:\s*ephemeral-push/);
assert.match(previewCompose, /DATABASE_SCHEMA_MODE:\s*ephemeral-push/);
console.log("production schema safety smoke passed");
