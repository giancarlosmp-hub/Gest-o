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
assert.equal((postgresSmoke.match(/prisma_diff --/g) ?? []).length, 5, "full generation and all four schema scenarios must use containerized Prisma");
assert.equal((postgresSmoke.match(/\.\/node_modules\/\.bin\/prisma/g) ?? []).length, 1, "the Prisma binary may only appear in the docker run wrapper");
for (const scenario of ["recovered.sql", "before", "after-first", "post.raw.sql", "after-second", "post2.raw.sql", "partial.raw.sql"]) {
  assert.match(postgresSmoke, new RegExp(scenario.replace(".", "\\.")), `missing disposable migration scenario: ${scenario}`);
}

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

// Enum additions: only the exact one-line ALTER TYPE "<enum>" ADD VALUE IF NOT EXISTS '<value>' passes.
function runPreview(sql) {
  const dir = mkdtempSync(resolve(tmpdir(), "gesto-schema-enum-"));
  const file = resolve(dir, "candidate.sql");
  writeFileSync(file, sql);
  const result = spawnSync("bash", [preview], { cwd: root, env: { ...process.env, MODE: "validate", SQL_FILE: file }, encoding: "utf8" });
  rmSync(dir, { recursive: true });
  return result;
}
const agendaSplitSql = readFileSync(resolve(root, "apps/api/prisma/migrations/20261023120000_agenda_activity_planning_split/migration.sql"), "utf8");
const agendaSplitPreview = runPreview(agendaSplitSql);
assert.equal(agendaSplitPreview.status, 0, `Agenda/Activity migration must pass the preview validator: ${agendaSplitPreview.stdout}${agendaSplitPreview.stderr}`);
assert.match(agendaSplitPreview.stdout, /RESUMO aditivas=10 destrutivas=0 bloqueadas=0/);
for (const [name, sql] of [
  ["enum value rename", `ALTER TYPE "AgendaEventStatus" RENAME VALUE 'vencido' TO 'cancelado';\n`],
  ["enum value drop", `ALTER TYPE "AgendaEventStatus" DROP VALUE 'vencido';\n`],
  ["enum type drop", `DROP TYPE "AgendaEventStatus";\n`],
  ["enum type rename", `ALTER TYPE "AgendaEventStatus" RENAME TO "AgendaStatus";\n`],
  ["column type change", `ALTER TABLE "Activity" ALTER COLUMN "type" TYPE TEXT;\n`],
  ["column type change via SET DATA TYPE", `ALTER TABLE "AgendaEvent" ALTER COLUMN "status" SET DATA TYPE TEXT;\n`],
  ["enum addition without IF NOT EXISTS", `ALTER TYPE "AgendaEventStatus" ADD VALUE 'cancelado';\n`],
  ["enum addition with positional clause", `ALTER TYPE "AgendaEventStatus" ADD VALUE IF NOT EXISTS 'cancelado' BEFORE 'vencido';\n`],
  ["enum addition sharing its line with a drop", `ALTER TYPE "AgendaEventStatus" ADD VALUE IF NOT EXISTS 'cancelado'; DROP TYPE "ActivityType";\n`],
  ["lowercase enum addition", `alter type "AgendaEventStatus" add value if not exists 'cancelado';\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 42, `${name} must stay blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout + result.stderr, /BLOQUEADO/, name);
}

// DML: a new migration may only carry DDL; the check reads the SQL itself, without comments.
for (const [name, sql] of [
  ["UPDATE", `UPDATE "Cliente" SET "nome" = 'Fictício';\n`],
  ["DELETE", `DELETE FROM "Cliente" WHERE "id" = 'cli_ficticio';\n`],
  ["INSERT", `INSERT INTO "Cliente" ("id") VALUES ('cli_ficticio');\n`],
  ["MERGE", `MERGE INTO "Cliente" AS c USING "Origem" AS o ON c."id" = o."id" WHEN MATCHED THEN DO NOTHING;\n`],
  ["COPY", `COPY "Cliente" FROM '/tmp/ficticio.csv';\n`],
  ["TRUNCATE", `TRUNCATE "Cliente";\n`],
  ["CREATE OR REPLACE", `CREATE OR REPLACE VIEW "VisaoFicticia" AS SELECT 1;\n`],
  ["lowercase update", `update "Cliente" set "nome" = 'x';\n`],
  ["lowercase delete", `delete from "Cliente";\n`],
  ["lowercase insert", `insert into "Cliente" ("id") values ('x');\n`],
  ["lowercase merge", `merge into "Cliente" using "Origem" on true when matched then do nothing;\n`],
  ["lowercase copy", `copy "Cliente" to stdout;\n`],
  ["lowercase truncate", `truncate table "Cliente";\n`],
  ["lowercase create or replace", `create or replace function "f"() returns int as $$ select 1 $$ language sql;\n`],
  ["mixed case", `UpDaTe "Cliente" SET "nome" = 'x';\n`],
  ["DML with trailing comment", `UPDATE "Cliente" SET "nome" = 'x'; -- ajuste fictício\n`],
  ["DML after DDL on the same line", `ALTER TABLE "Cliente" ADD COLUMN "apelido" TEXT; DELETE FROM "Cliente";\n`],
  ["indented DML", `   INSERT INTO "Cliente" ("id") VALUES ('x');\n`],
  ["DML inside a DO block", `DO $$ BEGIN UPDATE "Cliente" SET "nome" = 'x'; END $$;\n`],
  ["DML split across lines", `DELETE\nFROM "Cliente";\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 42, `${name} must be blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /BLOQUEADO: arquivo aprovado deve conter somente DDL aditiva/, name);
}
for (const [name, sql] of [
  ["update inside a column name", `ALTER TABLE "Cliente" ADD COLUMN "updatedAt" TIMESTAMP(3);\n`],
  ["update/delete in comments", `-- update\n-- DELETE FROM "Cliente";\nALTER TABLE "Cliente" ADD COLUMN "deletedAt" TIMESTAMP(3); -- insert later\n`],
  ["quoted identifiers named like DML", `CREATE TABLE "Copia" ("update" TEXT, "delete" TEXT);\n`],
  ["foreign key referential actions", `ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;\n`],
  ["lowercase foreign key referential actions", `alter table "Pedido" add constraint "Pedido_x_fkey" foreign key ("x") references "Cliente"("id") on delete set null on update cascade;\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 0, `${name} must not be blocked as DML: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /bloqueadas=0/, name);
}

// Comments are read the way PostgreSQL reads them: a "--" inside a string, identifier, block comment
// or dollar-quoted body hides nothing, and a comment PostgreSQL ignores blocks nothing.
for (const [name, sql] of [
  ["B1 -- inside a string hides DML", `ALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT 'a--b'; DELETE FROM "Exemplo";\n`],
  ["B2 -- inside a string hides a drop", `ALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT 'a--b'; DROP TABLE "Exemplo";\n`],
  ["B3 -- inside a string with a doubled quote", `ALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT 'it''s--x'; UPDATE "Exemplo" SET "nota" = 'y';\n`],
  ["B4 -- inside a quoted identifier", `CREATE TABLE "a--b" ("id" TEXT); INSERT INTO "Exemplo" VALUES ('x');\n`],
  ["B5 -- inside a block comment", `/* -- */ DELETE FROM "Exemplo";\n`],
  ["B6 -- inside a $$ body", `DO $$ BEGIN NULL; END -- $$; DELETE FROM "Exemplo";\n`],
  ["B7 -- inside a $tag$ body", `DO $fx$ BEGIN NULL; END -- $fx$; TRUNCATE "Exemplo";\n`],
  ["B8 -- inside an escape string", `ALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT E'a\\'--b'; DELETE FROM "Exemplo";\n`],
  ["DML word in a comment inside a $$ body", `DO $$ BEGIN -- sem DELETE aqui\n NULL; END $$;\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 42, `${name} must be blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /BLOQUEADO/, name);
}
for (const [name, sql] of [
  ["F1 DML inside a block comment", `/* remover depois: DELETE FROM "Exemplo" */\nCREATE TABLE "T" ("id" TEXT);\n`],
  ["F2 DML inside a multi-line block comment", `/*\n UPDATE antigo\n*/\nCREATE TABLE "T" ("id" TEXT);\n`],
  ["F3 quoted identifier with a space", `CREATE TABLE "data update" ("id" TEXT);\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 0, `${name} must not be blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /bloqueadas=0/, name);
}
for (const [name, sql] of [
  ["unterminated string", `ALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT 'a;\n`],
  ["unterminated block comment", `/* CREATE TABLE "T" ("id" TEXT);\n`],
  ["unterminated $tag$ body", `DO $fx$ BEGIN NULL; END $$;\n`],
  ["standard_conforming_strings", `SET standard_conforming_strings = off;\nALTER TABLE "Exemplo" ADD COLUMN "nota" TEXT DEFAULT 'a\\' -- '; DELETE FROM "Exemplo";\n`]
]) {
  const result = runPreview(sql);
  assert.equal(result.status, 42, `${name} must be blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /BLOQUEADO: SQL não pôde ser lido com segurança/, name);
}

// Registered migrations keep passing; only the approved backfill may carry DML, bound to id + sha256.
const { migrations: registered } = await import("../production-schema-migrations.mjs");
const ordersBackfillToken = "orders-tenant-authority-v1";
function runPreviewFile(file, extraEnv = {}) {
  return spawnSync("bash", [preview], { cwd: root, env: { ...process.env, MODE: "validate", SQL_FILE: file, ALLOW_DATA_BACKFILL: "", ...extraEnv }, encoding: "utf8" });
}
for (const { id, path } of Object.values(registered)) {
  const env = id === "20260904120000_orders_operational_view" ? { ALLOW_DATA_BACKFILL: ordersBackfillToken } : {};
  const result = runPreviewFile(path, env);
  assert.equal(result.status, 0, `registered migration ${id} must keep passing: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /destrutivas=0 bloqueadas=0/, id);
}
// Historical migrations outside the registry never go through the gate; they stay blocked for the
// same destructive changes and data writes they always carried.
for (const [id, summary, destructive] of [
  ["20260228110000_unify_companies_into_clients", "aditivas=1 destrutivas=2 bloqueadas=3", true],
  ["20260306120000_add_app_config_weekly_visits", "aditivas=1 destrutivas=0 bloqueadas=1", false],
  ["20260307100000_refactor_app_config_to_key_value", "aditivas=1 destrutivas=1 bloqueadas=2", true],
  ["202607210001_secure_communications_foundation", "aditivas=26 destrutivas=0 bloqueadas=1", false]
]) {
  const result = runPreviewFile(`apps/api/prisma/migrations/${id}/migration.sql`);
  assert.equal(result.status, 42, `historical migration ${id} must stay blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`RESUMO ${summary} `), id);
  assert.match(result.stdout, /BLOQUEADO: arquivo aprovado deve conter somente DDL aditiva/, id);
  assert.equal(/BLOQUEADO: SQL destrutivo\/incompatível detectado/.test(result.stdout), destructive, id);
}
const ordersPath = registered["20260904120000_orders_operational_view"].path;
const ordersSql = readFileSync(resolve(root, ordersPath), "utf8");
assert.match(runPreviewFile(ordersPath, { ALLOW_DATA_BACKFILL: ordersBackfillToken }).stdout, /DML aprovado: 20260904120000_orders_operational_view/);
const ordersWithoutToken = runPreviewFile(ordersPath);
assert.equal(ordersWithoutToken.status, 42, "the approved backfill still requires its token");
for (const [name, sql] of [
  ["approved copy with extra DML", `${ordersSql}\nDELETE FROM "Cliente" WHERE "id" = 'cli_ficticio';\n`],
  ["approved copy with a changed comment", ordersSql.replace(/^--.*$/m, "-- comentário fictício alterado")]
]) {
  assert.notEqual(sql, ordersSql, name);
  const dir = mkdtempSync(resolve(tmpdir(), "gesto-schema-dml-"));
  const file = resolve(dir, "migration.sql");
  writeFileSync(file, sql);
  const result = runPreviewFile(file, { ALLOW_DATA_BACKFILL: ordersBackfillToken });
  rmSync(dir, { recursive: true });
  assert.equal(result.status, 42, `${name} must be blocked: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /BLOQUEADO: arquivo aprovado deve conter somente DDL aditiva/, name);
}

const registry = resolve(root, "scripts/production-schema-migrations.mjs");
const ordersId = "20260904120000_orders_operational_view";
const ordersEntry = spawnSync("node", [registry, ordersId], { cwd: root, encoding: "utf8" });
assert.equal(ordersEntry.status, 0, ordersEntry.stderr);
assert.equal(JSON.parse(ordersEntry.stdout).sha256, "486c25d46702a8f91131fa6669b12e9119a62b098aed6c3a091fff4cdca892b9");
const unknownEntry = spawnSync("node", [registry, "20260904120001_not_allowlisted"], { cwd: root, encoding: "utf8" });
assert.notEqual(unknownEntry.status, 0, "an unregistered migration must be rejected");
assert.match(unknownEntry.stderr, /UNKNOWN_MIGRATION_ID/);
const authorityEntry = spawnSync("node", [registry, "20260911190000_product_price_authority"], { cwd: root, encoding: "utf8" });
assert.equal(authorityEntry.status, 0, authorityEntry.stderr);
assert.equal(JSON.parse(authorityEntry.stdout).sha256, "52101c9cee86211717bac9ba444735fd8f4120723f64988f1f32211dee56c024");
const sourceObsEntry = spawnSync("node", [registry, "20260927160000_product_price_source_observation"], { cwd: root, encoding: "utf8" });
assert.equal(sourceObsEntry.status, 0, sourceObsEntry.stderr);
assert.equal(JSON.parse(sourceObsEntry.stdout).sha256, "5f15e0ec506452ee9f341fa836ad9857baf1bf523f5dd1c7e21bea8f93079e70");
const agendaSplitEntry = spawnSync("node", [registry, "20261023120000_agenda_activity_planning_split"], { cwd: root, encoding: "utf8" });
assert.equal(agendaSplitEntry.status, 0, agendaSplitEntry.stderr);
assert.equal(JSON.parse(agendaSplitEntry.stdout).sha256, "df6508474fed9dd2a7a3f7492946d69158b12ce43e599f2fb6178540af8d2b5e");
assert.doesNotMatch(agendaSplitSql, /\b(UPDATE|DELETE|INSERT|DROP|RENAME|TRUNCATE)\b|NOT NULL|DEFAULT/i, "Agenda/Activity migration must only add enum values and nullable columns");

const apply = readFileSync(resolve(root, "scripts/production-schema-apply.sh"), "utf8");
const productPricePostgres = readFileSync(resolve(root, "scripts/smoke/product-price-authority-migration-postgres.sh"), "utf8");
assert.match(productPricePostgres, /column_name IN \('source', 'availabilityState'\)/, "authority column names must reach PostgreSQL as SQL string literals");
assert.doesNotMatch(productPricePostgres, /-Atc '[^\n]*\\'/, "multi-layer shell quote splicing is forbidden for ProductPrice SQL assertions");
assert.match(productPricePostgres, /authority_columns=\$\(psql -At <<'SQL'/, "catalog assertion must use a protected heredoc");
assert.match(productPricePostgres, /20260911190000_product_price_authority[\s\S]*20260927160000_product_price_source_observation[\s\S]*20261023120000_agenda_activity_planning_split[\s\S]*prisma migrate diff[\s\S]*--exit-code/,
  "authority harness must apply every later expansion before comparing with the current schema");
for (const agendaSplitPostcondition of ["migration Agenda/Atividades parcialmente aplicada", "agenda_split_state\" == 0:0", "agenda_split_state\" == 8:2", "migration Agenda/Atividades já presente; DDL ignorado", "rows_using_new_objects", "8:2:0", "is_nullable='YES' AND data_type='text'"]) assert.ok(apply.includes(agendaSplitPostcondition), `missing Agenda/Activity postcondition ${agendaSplitPostcondition}`);
assert.match(apply, /agenda_split_state" == 8:2 \]\]; then\n  log "migration Agenda\/Atividades já presente; DDL ignorado[\s\S]*else[\s\S]*admin_psql --single-transaction/, "already-applied Agenda/Activity path must not repeat DDL");
assert.match(apply, /production-schema-migrations\.mjs "\$MIGRATION_ID_REQUESTED"/);
for (const ordersPostcondition of ["orders-counts.before.tsv", "tenant_not_null", "tenant_nulls", "ErpOperationalOrderStatus", "ErpRequestAuthorizationStatus", "ErpOrderSync_tenantId_fkey", "ErpOrderSync_tenantId_createdAt_idx", "ErpOrderSync_tenantId_sellerId_createdAt_idx", "ErpOrderStatusHistory", "ErpOrderStatusHistory_erpOrderSyncId_fkey", "ErpOrderStatusHistory_opportunityId_fkey", "ErpOrderStatusHistory_erpOrderSyncId_occurredAt_idx", "ErpOrderStatusHistory_opportunityId_occurredAt_idx", "migration-backfill"]) assert.ok(apply.includes(ordersPostcondition), `missing Orders postcondition ${ordersPostcondition}`);
assert.match(apply, /20260731150000_safe_production_schema_transition\)[\s\S]*required_tables/, "the historical migration must retain its dedicated postconditions");
assert.match(apply, /CONFIRM=PRODUCTION_SCHEMA_APPLY/);
assert.doesNotMatch(apply, /db push|prisma:seed|seedOnBootstrap/);
assert.match(apply, /PSQL_DATABASE_URL=\$\(DATABASE_URL="\$DATABASE_URL" node scripts\/postgres-connection-url\.mjs\)/);
assert.doesNotMatch(apply, /psql\s+"\$DATABASE_URL"/, "Prisma DATABASE_URL must never be sent directly to psql");
assert.match(apply, /PRODUCTION_DB_CONTAINER_REQUIRED=gest-o-db-clean-v2-20260717/);
assert.match(apply, /docker exec --user postgres -i "\$PRODUCTION_DB_CONTAINER_EXPECTED"[\s\S]*psql --dbname="\$DB_NAME" -X -v ON_ERROR_STOP=1/);
assert.match(apply, /admin_psql --single-transaction -f - < "\$MIGRATION"/);
assert.match(apply, /orders_tenant_column" == 1[\s\S]*DDL ignorado[\s\S]*else[\s\S]*admin_psql --single-transaction/, "already-applied Orders path must not repeat DDL");
for (const authorityPostcondition of ["product-price-counts.before.tsv", "product-price-counts.after.tsv", "ProductPrice_source_availabilityState_idx", "migration ProductPrice parcialmente aplicada", "old_api_compatible"] ) assert.ok(apply.includes(authorityPostcondition), `missing ProductPrice authority postcondition ${authorityPostcondition}`);
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

// Verify fail-closed image validation in production-schema-apply.sh:
// 1) Absent API image
// 2) Image present but with divergent OCI revision label
// 3) Image present with correct matching OCI revision label
const testSha = "1234567890abcdef1234567890abcdef12345678";
const scratch = mkdtempSync(resolve(tmpdir(), "gesto-schema-apply-image-test-"));
const fakeBin = resolve(scratch, "bin");
const fakeEnvFile = resolve(scratch, "production.env");
writeFileSync(fakeEnvFile, "DATABASE_URL=postgresql://user:pass@localhost:5432/salesforce_pro\n");
const mockAppDir = resolve(scratch, "app");
const mockScriptsDir = resolve(mockAppDir, "scripts");
const mockNodeModulesDir = resolve(mockAppDir, "node_modules/.bin");
import { mkdirSync, chmodSync } from "node:fs";
mkdirSync(fakeBin, { recursive: true });
mkdirSync(mockScriptsDir, { recursive: true });
mkdirSync(mockNodeModulesDir, { recursive: true });

// Minimal mocks for scripts invoked before image inspection
writeFileSync(resolve(mockScriptsDir, "production-schema-migrations.mjs"), `
console.log(JSON.stringify({ path: "${resolve(mockScriptsDir, "migration.sql")}" }));
`);
writeFileSync(resolve(mockScriptsDir, "migration.sql"), "-- test migration\n");
writeFileSync(resolve(mockScriptsDir, "postgres-connection-url.mjs"), `
console.log("postgresql://user:pass@localhost:5432/salesforce_pro");
`);
writeFileSync(resolve(mockScriptsDir, "production-preflight.sh"), "#!/usr/bin/env bash\nexit 0\n");
chmodSync(resolve(mockScriptsDir, "production-preflight.sh"), 0o755);

// Fake git
writeFileSync(resolve(fakeBin, "git"), `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse HEAD"* || "$*" == *"rev-parse origin/main"* ]]; then
  echo "${testSha}"
  exit 0
fi
if [[ "$*" == *"status --porcelain"* ]]; then
  exit 0
fi
exit 0
`);
chmodSync(resolve(fakeBin, "git"), 0o755);

// Case 1: Absent API image (fake docker returns 1 on docker image inspect)
writeFileSync(resolve(fakeBin, "docker"), `#!/usr/bin/env bash
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 1
fi
exit 0
`);
chmodSync(resolve(fakeBin, "docker"), 0o755);

const missingImageRes = spawnSync("bash", [resolve(root, "scripts/production-schema-apply.sh")], {
  cwd: mockAppDir,
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    APP_DIR: mockAppDir,
    PRODUCTION_ENV_FILE: fakeEnvFile,
    MODE: "preview",
    EXPECTED_SHA: testSha,
    PRODUCTION_DB_CONTAINER_EXPECTED: "gest-o-db-clean-v2-20260717",
    MIGRATION_ID_REQUESTED: "20260927160000_product_price_source_observation"
  },
  encoding: "utf8"
});
assert.notEqual(missingImageRes.status, 0, "missing image must fail-close");
assert.match(missingImageRes.stderr, /imagem API do SHA ausente/);

// Case 2: Divergent image revision label
writeFileSync(resolve(fakeBin, "docker"), `#!/usr/bin/env bash
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  if [[ "$*" == *".Config.Labels"* ]]; then
    echo "wrong_sha_0000000000000000000000000000000"
    exit 0
  fi
  exit 0
fi
exit 0
`);
chmodSync(resolve(fakeBin, "docker"), 0o755);

const divergentImageRes = spawnSync("bash", [resolve(root, "scripts/production-schema-apply.sh")], {
  cwd: mockAppDir,
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    APP_DIR: mockAppDir,
    PRODUCTION_ENV_FILE: fakeEnvFile,
    MODE: "preview",
    EXPECTED_SHA: testSha,
    PRODUCTION_DB_CONTAINER_EXPECTED: "gest-o-db-clean-v2-20260717",
    MIGRATION_ID_REQUESTED: "20260927160000_product_price_source_observation"
  },
  encoding: "utf8"
});
assert.notEqual(divergentImageRes.status, 0, "divergent image revision label must fail-close");
assert.match(divergentImageRes.stderr, /imagem API com SHA divergente/);

// Case 3: Correct matching image revision label (passes image check and reaches preview step)
writeFileSync(resolve(fakeBin, "docker"), `#!/usr/bin/env bash
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  if [[ "$*" == *".Config.Labels"* ]]; then
    echo "${testSha}"
    exit 0
  fi
  exit 0
fi
if [[ "$1" == "run" ]]; then
  echo "mock prisma diff"
  exit 0
fi
exit 0
`);
chmodSync(resolve(fakeBin, "docker"), 0o755);

writeFileSync(resolve(mockScriptsDir, "production-schema-preview.sh"), "#!/usr/bin/env bash\nexit 0\n");
chmodSync(resolve(mockScriptsDir, "production-schema-preview.sh"), 0o755);
writeFileSync(resolve(mockScriptsDir, "schema-diff-filter.mjs"), "import fs from 'node:fs'; fs.writeFileSync(process.argv[3] || 'out.sql', ''); process.exit(0);\n");

const correctImageRes = spawnSync("bash", [resolve(root, "scripts/production-schema-apply.sh")], {
  cwd: mockAppDir,
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    APP_DIR: mockAppDir,
    PRODUCTION_ENV_FILE: fakeEnvFile,
    MODE: "preview",
    EXPECTED_SHA: testSha,
    PRODUCTION_DB_CONTAINER_EXPECTED: "gest-o-db-clean-v2-20260717",
    MIGRATION_ID_REQUESTED: "20260927160000_product_price_source_observation"
  },
  encoding: "utf8"
});
assert.equal(correctImageRes.status, 0, `matching image revision label must pass image check; failed with: ${correctImageRes.stderr}`);
assert.match(correctImageRes.stdout + correctImageRes.stderr, /preview validado em modo estritamente read-only/);

rmSync(scratch, { recursive: true, force: true });
assert.match(apply, /pre-apply-diff\.raw\.sql[\s\S]*schema-diff-filter\.mjs[\s\S]*--single-transaction/);
assert.match(apply, /MODE.*preview[\s\S]*schema-diff-filter\.mjs[\s\S]*preview validado em modo estritamente read-only[\s\S]*exit 0[\s\S]*prepare_schema_evidence_directory/, "preview must exit before evidence preparation and DDL");
assert.match(apply, /schema-diff-filter\.mjs "\$evidence\/pre-apply-diff\.raw\.sql"[\s\S]*pre "\$MIGRATION_ID_REQUESTED"/, "pre-diff authorization must be migration-bound");
assert.match(apply, /umask 077[\s\S]*prepare_schema_evidence_directory/);
assert.match(apply, /post-apply-diff\.raw\.sql[\s\S]*post-apply-diff\.sql[\s\S]*applied_staging/);
assert.ok(apply.indexOf('schema-diff-filter.mjs "$evidence/post-apply-diff.raw.sql"') < apply.indexOf('mv -T -- "$applied_staging" "$evidence/applied.tsv"'), "applied.tsv must be published last, after the post-apply diff");
assert.ok(apply.indexOf('mv -T -- "$applied_staging" "$evidence/applied.tsv"') < apply.indexOf('validate_schema_evidence "$evidence/applied.tsv"'), "producer must call the cutover validator after publication");
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
assertContactDiff("complete Orders columns", `ALTER TABLE "ErpOrderSync"
ADD COLUMN "erpOrderId" TEXT,
ADD COLUMN "operationalOrderStatus" "ErpOperationalOrderStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "operationalStatusRaw" TEXT,
ADD COLUMN "requestAuthorizationStatus" "ErpRequestAuthorizationStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "tenantId" TEXT NOT NULL;`, true);
assertContactDiff("partial Orders columns", 'ALTER TABLE "ErpOrderSync" ADD COLUMN "tenantId" TEXT NOT NULL;', false);

function assertAgendaSplitDiff(name, sql, accepted) {
  const testDir = mkdtempSync(resolve(tmpdir(), "gesto-agenda-split-diff-"));
  const input = resolve(testDir, "input.sql");
  const output = resolve(testDir, "output.sql");
  writeFileSync(input, sql);
  const result = spawnSync("node", [resolve(root, "scripts/schema-diff-filter.mjs"), input, output, "pre", "20261023120000_agenda_activity_planning_split"], { encoding: "utf8" });
  rmSync(testDir, { recursive: true });
  assert.equal(result.status === 0, accepted, `${name}: ${result.stdout}${result.stderr}`);
}
// Exactly what `prisma migrate diff` emits for this migration against the previous schema.
const agendaSplitEnumLines = [
  `ALTER TYPE "ActivityType" ADD VALUE 'reuniao_online';`,
  `ALTER TYPE "ActivityType" ADD VALUE 'reuniao_presencial';`,
  `ALTER TYPE "AgendaEventType" ADD VALUE 'ligacao';`,
  `ALTER TYPE "AgendaEventType" ADD VALUE 'whatsapp';`,
  `ALTER TYPE "AgendaEventType" ADD VALUE 'visita';`,
  `ALTER TYPE "AgendaEventType" ADD VALUE 'proposta';`,
  `ALTER TYPE "AgendaEventType" ADD VALUE 'fechamento';`,
  `ALTER TYPE "AgendaEventStatus" ADD VALUE 'nao_realizado';`
];
const agendaSplitColumnLines = [
  `-- AlterTable\nALTER TABLE "AgendaEvent" ADD COLUMN     "notDoneReason" TEXT;`,
  `-- AlterTable\nALTER TABLE "Activity" ADD COLUMN     "noNextStepReason" TEXT;`
];
const agendaSplitFullDiff = `-- AlterEnum\n-- This migration adds more than one value to an enum.\n\n${agendaSplitEnumLines.join("\n")}\n\n${agendaSplitColumnLines.join("\n\n")}\n`;
assertAgendaSplitDiff("complete Agenda/Activity diff", agendaSplitFullDiff, true);
assertAgendaSplitDiff("already applied (empty diff)", "", true);
assertAgendaSplitDiff("reordered Agenda/Activity diff", [...agendaSplitColumnLines].reverse().join("\n") + "\n" + [...agendaSplitEnumLines].reverse().join("\n"), true);
assertAgendaSplitDiff("partial: enum values without columns", agendaSplitEnumLines.join("\n"), false);
assertAgendaSplitDiff("partial: columns without enum values", agendaSplitColumnLines.join("\n"), false);
assertAgendaSplitDiff("unexpected enum value", `${agendaSplitFullDiff}ALTER TYPE "AgendaEventStatus" ADD VALUE 'cancelado';\n`, false);
assertAgendaSplitDiff("enum value on another enum", agendaSplitFullDiff.replace(`"AgendaEventStatus" ADD VALUE 'nao_realizado'`, `"ActivityType" ADD VALUE 'nao_realizado'`), false);
assertAgendaSplitDiff("non-null reason column", agendaSplitFullDiff.replace(`"notDoneReason" TEXT`, `"notDoneReason" TEXT NOT NULL`), false);
assertAgendaSplitDiff("defaulted reason column", agendaSplitFullDiff.replace(`"noNextStepReason" TEXT`, `"noNextStepReason" TEXT DEFAULT ''`), false);
assertAgendaSplitDiff("unexpected extra column", `${agendaSplitFullDiff}ALTER TABLE "Activity" ADD COLUMN "unexpected" TEXT;\n`, false);
assertAgendaSplitDiff("column type change", `${agendaSplitFullDiff}ALTER TABLE "Activity" ALTER COLUMN "type" SET DATA TYPE TEXT;\n`, false);
assertAgendaSplitDiff("enum value rename", `${agendaSplitFullDiff}ALTER TYPE "AgendaEventStatus" RENAME VALUE 'vencido' TO 'cancelado';\n`, false);
assertAgendaSplitDiff("duplicated enum value", `${agendaSplitFullDiff}${agendaSplitEnumLines[0]}\n`, false);
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
