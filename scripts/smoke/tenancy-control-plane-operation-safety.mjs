#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root=resolve(import.meta.dirname,"../.."); const read=p=>readFileSync(resolve(root,p),"utf8");
const registry=read("scripts/production-schema-migrations.mjs"), preview=read("scripts/production-tenancy-control-plane-preview.sh");
const apply=read("scripts/production-tenancy-control-plane-apply.sh"), prepare=read("scripts/production-tenant-default-prepare.sh");
const catalog=read("scripts/control-plane-catalog.sql"), validator=read("scripts/control-plane-catalog-validate.mjs");
const operationPostgres=read("scripts/smoke/tenancy-control-plane-operation-postgres.sh");
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh")+read("apps/api/src/scripts/bootstrap.ts");
assert.equal(spawnSync(process.execPath,[resolve(root,"scripts/production-schema-migrations.mjs"),"unknown"],{encoding:"utf8"}).status,2);
for(const value of ["20260802120000_tenancy_control_plane","b9298218b3c34cdadaf35f31a6d0e8a6e1942e9d1cbf5ae5c77ae305d1cc554d","581fbae0a545f53800db7707ab8b28f52dcd3fa1","dc7ceb0f0a23b77fc45a58960f3371b50c7f7365","0576893d97a0d7b55ca73316cfe6af6774eeccc1e91807fe4fa45c8fdad7f24c","20260731150000_safe_production_schema_transition","evidenceVersion"]) assert.match(registry,new RegExp(value));
assert.doesNotMatch(registry,/process\.env\.(?:MIGRATION_PATH|SQL_FILE)|glob|wildcard/i);
for(const token of ["EXPECTED_SHA","origin/main","status --porcelain","RUNTIME_TENANCY_MODE","DATABASE_SCHEMA_MODE","--pull=never","org.opencontainers.image.revision","pre-apply-diff.raw.sql","ABSENT_COMPATIBLE","ALREADY_APPLIED","partial or divergent"]) assert.ok(preview.includes(token),token);
assert.match(preview,/node scripts\/schema-diff-filter\.mjs \\\n\s+"\$evidence\/pre-apply-diff\.raw\.sql" \\\n\s+"\$evidence\/pre-apply-diff\.sql" \\\n\s+pre/);
assert.doesNotMatch(preview,/cp "\$evidence\/pre-apply-diff\.raw\.sql"|rg -n .*incident_/);
assert.doesNotMatch(preview,/db push|migrate deploy|CREATE TABLE|ALTER TABLE/);
for(const token of ["PRODUCTION_SCHEMA_APPLY","API_IMAGE","origin/main","status --porcelain","RUNTIME_TENANCY_MODE","DATABASE_SCHEMA_MODE","BACKUP_RESULT_FILE","PREFLIGHT_RESULT_FILE","BEGIN;","ON_ERROR_STOP","ALREADY_APPLIED","post-apply-diff.sql"]) assert.ok(apply.includes(token),token);
assert.doesNotMatch(apply,/IF NOT EXISTS|GRANT|ALTER OWNER|DROP|TRUNCATE/);
for(const token of ["MODE","dry-run","PREPARE_DEFAULT_TENANT","APPROVED_TEMPORARY_ROLE","origin/main","status --porcelain","RUNTIME_TENANCY_MODE","DATABASE_SCHEMA_MODE","default-only","EXPECTED_AGGREGATE_HASH","dry-run-result.tsv","--pull=never","operator_uid=$(id -u)","operator_gid=$(id -g)","--user \"$operator_uid:$operator_gid\""]) assert.ok(prepare.includes(token),token);
assert.doesNotMatch(prepare,/docker compose|deploy|seed|migrate|production\.env|restart/);
for(const name of ["TenantStatus","TenantMembershipStatus","TenantRole"]) assert.ok(catalog.includes(name)&&validator.includes(name),name);
for(const name of ["TenantMembership_version_positive","TenantMembership_lifecycle_coherent"]) assert.ok(validator.includes(name),name);
for (const token of ['--no-align', '--tuples-only', '--field-separator=$\'\\t\'', '--pset=pager=off', '===== CATALOG QUERY FAILED =====', 'CATALOG_DETAIL_SQL_TYPE=', 'CATALOG_DETAIL_TYPE_MISMATCH:', 'FK_TSV_META', 'CATALOG_FK_DETAIL_INCOMPLETE', 'FK_DETAIL[', 'od -An -tx1c', 'control-plane-catalog-validate.mjs']) assert.ok(operationPostgres.includes(token), token);
for (const token of ['HOST_UID="$(id -u)"', 'HOST_GID="$(id -g)"', '--user "$HOST_UID:$HOST_GID"', "stat -c '%u:%g %a %n'", 'dry-run-result.tsv', 'metadata.tsv', 'result.tsv', 'apply.tsv', 'reconciliation.tsv', 'HARNESS_CHECKPOINT', 'HARNESS_FAIL', 'dry_run_completed', 'evidence_permissions_pass', 'dry_run_hash_pass', 'apply_start', 'apply_completed', 'idempotent_reapply_start', 'idempotency_pass', 'evidence-attempt-1', 'evidence-attempt-2']) assert.ok(operationPostgres.includes(token), token);
assert.match(operationPostgres, /attempt_one_files=\(metadata\.tsv dry-run-result\.tsv result\.tsv apply\.tsv reconciliation\.tsv\)/);
assert.match(operationPostgres, /attempt_two_files=\(metadata\.tsv result\.tsv apply\.tsv reconciliation\.tsv\)/);
assert.doesNotMatch(operationPostgres.match(/attempt_two_files=\([^\n]+/)?.[0] || "", /dry-run-result\.tsv/);
for (const token of ['IDEMPOTENT_AGGREGATE_HASH_MATCH=PASS', 'SECOND_TENANT_COUNT=', 'SECOND_MEMBERSHIP_COUNT=', 'SECOND_USER_COUNT=', 'TENANCY_CONTROL_PLANE_OPERATION_POSTGRES=PASS']) assert.ok(operationPostgres.includes(token), token);
assert.doesNotMatch(prepare + operationPostgres, /chmod\s+(?:777|666|644)\b|umask\s+000\b/);
assert.doesNotMatch(operationPostgres, /rm\s+-f\s+[^\n]*result\.tsv/);
assert.match(prepare, /run_runner\(\)\{ docker run[^\n]*--user "\$operator_uid:\$operator_gid"[\s\S]*-v "\$evidence:\/evidence"/);
assert.match(operationPostgres, /runner\(\)\{ run_api "\$pathurl" --user "\$HOST_UID:\$HOST_GID"[\s\S]*-v "\$evidence:\/evidence"/);
assert.match(operationPostgres, /if ! docker exec -i "\$path" psql[\s\S]*--no-align[\s\S]*--tuples-only[\s\S]*--field-separator=\$'\\t'[\s\S]*--pset=pager=off[\s\S]*<scripts\/control-plane-catalog\.sql >"\$catalog_file"; then[\s\S]*===== CATALOG QUERY FAILED =====[\s\S]*exit 1[\s\S]*fi[\s\S]*awk -F '\\t'[\s\S]*if ! node scripts\/control-plane-catalog-validate\.mjs/);
assert.doesNotMatch(operationPostgres, /column -t|\bcut\b|\bfold\b|\$\([^)]*control-plane-catalog|CATALOG=.*control-plane-catalog/);
assert.doesNotMatch(operationPostgres, /\brg\b/);
assert.match(compose,/TENANCY_MODE:\s*disabled/); assert.doesNotMatch(compose,/TENANCY_MODE:\s*default-only/);
assert.doesNotMatch(deploy,/prepareDefaultTenant|tenant-default-prepare/);
assert.equal(spawnSync("bash",[resolve(root,"scripts/production-tenant-default-prepare.sh")],{env:{...process.env,MODE:"apply"},encoding:"utf8"}).status,1);
assert.doesNotMatch(read("apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql"),/IF NOT EXISTS|DROP|TRUNCATE/);

const incidentTables = [
  "incident_20260718_client_enrichment_audit", "incident_20260718_client_map",
  "incident_20260718_june_client_source", "incident_20260718_recovery_audit",
  "incident_20260719_erp_code_enrichment_audit", "incident_20260719_erp_partner_client_map",
  "incident_20260719_orphan_productprice_audit", "incident_20260719_product_snapshot_map"
];
const scratch=mkdtempSync(join(tmpdir(),"control-plane-filter-"));
const filter=(sql,mode="pre")=>{ const input=join(scratch,"input.sql"),output=join(scratch,"output.sql"); writeFileSync(input,sql); const result=spawnSync(process.execPath,[resolve(root,"scripts/schema-diff-filter.mjs"),input,output,mode],{encoding:"utf8"}); return {...result,output:result.status===0?readFileSync(output,"utf8"):null}; };
const incidentDrops=incidentTables.map(name=>`DROP TABLE "${name}";`).join("\n");
const approved='CREATE TYPE "TenantStatus" AS ENUM (\'active\', \'suspended\');\nCREATE TABLE "Tenant" ("id" TEXT NOT NULL);';
assert.equal(filter(`${incidentDrops}\n${approved}`).status,0); // positive A
const onlyIncidents=filter(incidentDrops); assert.equal(onlyIncidents.status,0); assert.equal(onlyIncidents.output.trim(),""); // positive B
for(const sql of [
  'DROP TABLE "incident_20990101_unknown";',
  `ALTER TABLE "${incidentTables[0]}" ADD COLUMN "bad" TEXT;`,
  'ALTER TABLE "User" DROP COLUMN "email";',
  'TRUNCATE TABLE "User";',
  'CREATE TABLE "NotApproved" ("id" TEXT);'
]) assert.notEqual(filter(sql).status,0,sql);

// A failed official filter must leave raw evidence and must never publish preview PASS.
const fakeBin=join(scratch,"bin"), evidenceRoot=join(scratch,"evidence"); mkdirSync(fakeBin); mkdirSync(evidenceRoot);
const sha="5c2a43a3c9537b26813912f54eda9ee73c5da0a7", migration="20260802120000_tenancy_control_plane";
writeFileSync(join(fakeBin,"git"),`#!/bin/sh\ncase "$1 $2" in "rev-parse HEAD"|"rev-parse origin/main") echo ${sha};; "status --porcelain") :;; *) exit 1;; esac\n`);
writeFileSync(join(fakeBin,"docker"),`#!/bin/sh\nif [ "$1" = image ] && [ "$2" = inspect ]; then case "$*" in *--format*) echo ${sha};; esac; exit 0; fi\nif [ "$1" = exec ]; then case "$*" in *current_database*) printf 'gesto\\tpostgres\\n';; *control-plane-catalog*) :;; esac; exit 0; fi\nif [ "$1" = run ]; then printf '%s\\n' 'DROP TABLE "incident_20990101_unknown";'; exit 0; fi\nexit 1\n`);
chmodSync(join(fakeBin,"git"),0o755); chmodSync(join(fakeBin,"docker"),0o755);
const failedPreview=spawnSync("bash",[resolve(root,"scripts/production-tenancy-control-plane-preview.sh")],{cwd:root,encoding:"utf8",env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`,MIGRATION_ID:migration,EXPECTED_SHA:sha,API_IMAGE:`gest-o-api:${sha}`,DATABASE_URL:"postgresql://unused",PRODUCTION_DB_CONTAINER_EXPECTED:"db",PRODUCTION_DB_NAME_EXPECTED:"gesto",RUNTIME_TENANCY_MODE:"disabled",DATABASE_SCHEMA_MODE:"external",SCHEMA_EVIDENCE_DIR:evidenceRoot}});
assert.notEqual(failedPreview.status,0);
const failedEvidence=join(evidenceRoot,sha,"migrations",migration);
assert.ok(readFileSync(join(failedEvidence,"pre-apply-diff.raw.sql"),"utf8").includes("incident_20990101_unknown"));
assert.equal(spawnSync("test",["-e",join(failedEvidence,"preview-result.tsv")]).status,1);
rmSync(scratch,{recursive:true,force:true});
console.log("tenancy control-plane operation static safety passed");
