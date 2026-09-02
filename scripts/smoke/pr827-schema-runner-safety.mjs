import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"../.."); const read=p=>readFileSync(resolve(root,p),"utf8");
const sql=read("apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql");
assert.equal(createHash("sha256").update(sql).digest("hex"),"61b4443a685471ea0425613d97da35a06cedf677d77c26807ce7ff27ccdb5b9e");
assert.doesNotMatch(sql,/^\s*(DROP|TRUNCATE|UPDATE|DELETE|INSERT|MERGE)\b/im); assert.doesNotMatch(sql,/ALTER TABLE "ErpOrderSync" ADD COLUMN[^;]*NOT NULL/i);
const runner=read("scripts/pr827-schema-runner.sh"), registry=read("scripts/production-schema-migrations.mjs");
const diagnostics=read("scripts/sql/pr827-connection-diagnostics.sql"), ledgerSql=read("scripts/sql/pr827-ledger-query.sql");
for(const token of ["20260827190000_add_erp_order_manual_resolution","APPLY_PR827_SCHEMA","applied.tsv","checksum","history/catalog state is divergent","post-diff is not empty","PR827_MIGRATION_IDEMPOTENCY=PASS","PR827_ENV_METADATA=VALID","PR827_DATABASE_URL_CONTRACT=PASS","PR827_ENV_IMMUTABLE=PASS"]) assert.match(runner,new RegExp(token));
for (const token of ["BEGIN TRANSACTION READ ONLY", "current_database()", "current_user", "current_schema()", "current_setting\\('search_path'\\)", "server_version", "to_regclass\\('public.\"_prisma_migrations\"'\\)", "PRISMA_LEDGER_LOCATION", "PRISMA_LEDGER_VISIBILITY", "PREDECESSOR_CATALOG_STATE", "PR827_CATALOG_STATE"])
  assert.match(runner + diagnostics + read("scripts/pr827-predecessor-catalog.sql"), new RegExp(token));
assert.match(diagnostics,/\(current_schemas\(false\)\)\[1\]/);
assert.doesNotMatch(diagnostics,/current_schemas\(false\)\[1\]/);
assert.match(registry,/20260731150000_safe_production_schema_transition/);
assert.doesNotMatch(registry.slice(registry.indexOf('"20260827190000')),/20260808120000_tenancy_expand_roots/);
assert.doesNotMatch(runner,/db push|migrate reset|migrate dev|migrate deploy/);
const allowlistGate=runner.indexOf("== $MIGRATION_ID ]] || die 'migration is not allowlisted'");
assert.ok(allowlistGate >= 0,"the exact migration allowlist must run");
const previewExit=runner.indexOf('[[ $MODE == preview ]] && exit 0');
assert.ok(previewExit < runner.indexOf('cat "$migration"'),"DDL must remain unreachable in preview");
assert.ok(runner.indexOf("[[ ${CONFIRM:-} == $CONFIRMATION ]]") > previewExit,"apply confirmation must guard writes");
assert.doesNotMatch(runner,/INSERT INTO "_prisma_migrations"|CREATE TABLE "_prisma_migrations"/);
assert.ok(runner.indexOf('cat "$migration"') < runner.indexOf("echo 'COMMIT;'"),"DDL and history publication must share the transaction window");
assert.match(runner,/coproc PR827_TX/); assert.match(runner,/echo 'ROLLBACK;'/); assert.match(runner,/os\.fsync/);
assert.ok(runner.indexOf('Prisma ledger must remain absent') < runner.indexOf('READY_TO_APPLY'), "ledger absence must be verified before readiness");
assert.doesNotMatch(diagnostics + read("scripts/pr827-predecessor-catalog.sql") + read("scripts/pr827-schema-catalog.sql"), /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
const composeCi=read(".github/workflows/docker-compose-ci.yml");
assert.match(composeCi,/npm run test:pr827-preview:postgres/);
for (const token of ["Record checkout lockfile", "node-version-file: .nvmrc", "npm install --global npm@11.4.2", "npm ci", "LOCKFILE_STATE_AFTER_CHECKOUT=CLEAN", "LOCKFILE_STATE_AFTER_TOOLCHAIN_SETUP=CLEAN", "LOCKFILE_STATE_AFTER_DEPENDENCY_INSTALL=CLEAN", "LOCKFILE_STATE_BEFORE_PR827_HARNESS=CLEAN"])
  assert.match(composeCi,new RegExp(token));
assert.doesNotMatch(composeCi,/run: npm install\s*$/m);
assert.ok(composeCi.indexOf("Record checkout lockfile") < composeCi.indexOf("Setup Node.js"),"checkout lockfile must be classified before toolchain setup");
const postgresHarness=read("scripts/smoke/pr827-preview-postgres.sh"), rejectionSql=read("scripts/sql/pr827-read-only-write-rejection.sql");
for (const token of ["readonly_rc=$?", "25006", "READ_ONLY_ENFORCEMENT=PASS", "PR827_PREVIEW_POSTGRES_RESULT=PASS", "docker network create --internal"]) assert.match(postgresHarness,new RegExp(token.replace(/[?$]/g,"\\$&")));
const applyHarness=read("scripts/smoke/pr827-apply-postgres.sh");
for (const token of ["pr827_backup_proof_publish", "pr827_backup_proof_validate", "BACKUP_FIXTURE_CONTRACT=PASS", "BACKUP_FIXTURE_FINAL_VALIDATION=PASS", "BACKUP_NEGATIVE_CASES=PASS", "APPLY_IDEMPOTENCY=PASS", "APPLY_ROLLBACK_CASES=PASS", "PRISMA_LEDGER_CREATED=NO", "PR827_APPLY_POSTGRES_RESULT=PASS"])
  assert.match(applyHarness, new RegExp(token));
for (const negative of ["absent", "dump_absent", "checksum_divergent", "manifest_absent", "manifest_invalid", "timestamp_expired", "sha_mismatch", "database_mismatch", "mode_invalid", "owner_invalid", "symlink"])
  assert.match(applyHarness, new RegExp(negative));
for (const token of ["resolve_backup_fixture_paths", "PR827_BACKUP_RESOLVED_DUMP", "PR827_BACKUP_RESOLVED_MANIFEST", "PR827_BACKUP_RESOLVED_BUNDLE_ID", "fixture_bundle_root", "HARNESS_TEMP_ROOT"])
  assert.match(applyHarness, new RegExp(token));
assert.doesNotMatch(applyHarness, /backup_root\/latest\/dump\.sql\.gz/);
for (const stage of ["BACKUP_FIXTURE_PUBLISH", "BACKUP_FIXTURE_VALIDATE", "RUNNER_OVERRIDE_AUTHORIZATION", "RUNNER_INITIAL_APPLY", "CATALOG_VALIDATION", "IDEMPOTENT_APPLY", "ROLLBACK_PUBLICATION_FAILURE", "DDL_FAILURE_WITHOUT_HISTORY"])
  assert.match(applyHarness, new RegExp(stage));
for (const marker of ["APPLY_STAGE_RC", "APPLY_STAGE_RESULT", "APPLY_HARNESS_OPERATION_RC", "APPLY_HARNESS_CLEANUP_RC", "APPLY_HARNESS_FINAL_RC"])
  assert.match(applyHarness, new RegExp(marker));
assert.doesNotMatch(applyHarness, /printf ['"]PASS/);
assert.doesNotMatch(applyHarness, /\|\|\s*(?:true|:)/);
for (const harness of [postgresHarness, applyHarness]) {
  for (const token of ["HARNESS_TEMP_ROOT", "TMPDIR=/tmp mktemp -d", "status --porcelain=v1", "HARNESS_WORKTREE_%s=PASS"])
    assert.match(harness, new RegExp(token.replace(/[?$]/g,"\\$&")));
  for (const classification of ["UNTRACKED", "TRACKED_MODIFIED", "TRACKED_ADDED", "TRACKED_DELETED"])
    assert.match(harness,new RegExp(classification));
  for (const token of ["HARNESS_EXECUTION_CHECKOUT", "git clone --quiet --no-hardlinks", 'git -C "$HARNESS_EXECUTION_CHECKOUT" update-ref refs/remotes/origin/main', "HARNESS_HEAD_SHA", "HARNESS_EXPECTED_MAIN_SHA", "HARNESS_ORIGIN_MAIN_SHA", "PRIMARY_CHECKOUT_REFS_MODIFIED=NO"])
    assert.match(harness,new RegExp(token.replace(/[?$]/g,"\\$&")));
  assert.doesNotMatch(harness,/git (?:clean|reset|stash|update-index|checkout --)|(?:^|[;&]\s*)git update-ref/m);
}
assert.match(rejectionSql,/\\set VERBOSITY verbose/);
assert.doesNotMatch(postgresHarness,/\|\|\s*(?:true|:)|continue-on-error/);
const workflow=read(".github/workflows/production-schema-pr827.yml"); assert.match(workflow,/options: \[preview, apply\]/); assert.match(workflow,/production-schema/);
const postFilter=read("scripts/pr827-post-diff-filter.mjs");
for (const token of ["ErpOrderManualResolution", "supersedesErpOrderSyncId"]) assert.match(postFilter,new RegExp(token));
assert.match(runner,/pr827-post-diff-filter\.mjs/);
assert.match(workflow,/resolve-production-env\.sh/); assert.match(workflow,/PRODUCTION_ENV_REQUIRE_EXACTLY_ONE=true/);
assert.match(workflow,/PRODUCTION_ENV_SOURCE="\$resolved_env_source" PRODUCTION_ENV_FILE="\$resolved_env_file"/);
assert.match(workflow,/SCHEMA_EVIDENCE_DIR=\/var\/log\/gest-o\/schema/);
assert.match(workflow,/BACKUP_RESULT_FILE=\/var\/log\/gest-o\/backup\/latest\/result\.tsv/);
assert.match(runner,/pr827_backup_proof_validate "\$BACKUP_RESULT_FILE" "\$EXPECTED_SHA"/);
assert.doesNotMatch(runner,/grep -Fqx PASS "\$BACKUP_RESULT_FILE"/);
assert.doesNotMatch(workflow,/MIGRATION_ID_REQUESTED[^\n]+API_IMAGE/);
assert.doesNotMatch(workflow,/PRODUCTION_ENV_FILE=\/root\//);
assert.ok(workflow.indexOf("resolve-production-env.sh") < workflow.indexOf("pr827-schema-runner.sh"));
console.log("PR827 schema runner safety passed");
