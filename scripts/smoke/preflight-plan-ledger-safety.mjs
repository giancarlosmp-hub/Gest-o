import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("./sql/preflight-plan-ledger-candidate.sql", import.meta.url), "utf8");
const sh = readFileSync(new URL("./preflight-plan-ledger-postgres.sh", import.meta.url), "utf8");
for (const table of ["tenant_preflight_evidence_registry", "tenant_backfill_plan_ledger", "tenant_backfill_plan_event"])
  assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
assert.match(sql, /SECURITY DEFINER SET search_path=pg_catalog,public/g);
assert.match(sql, /CHECK \(dry_run_only\)/);
assert.match(sql, /CHECK \(NOT apply_authorized\)/);
assert.match(sql, /BEFORE UPDATE OR DELETE/g);
assert.doesNotMatch(sql, /IF (?:NOT )?EXISTS/i);
assert.doesNotMatch(sql, /name|email|document|token|credential|connection_string|payload|report_json|plan_json/i);
for (const required of ["postgres:16", "docker exec -i", "psql -X", "ON_ERROR_STOP=1", "PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS"])
  assert.ok(sh.includes(required), `missing harness control: ${required}`);
const executableLines = sh.split("\n").filter((line) => !/^\s*#/.test(line));
assert.ok(!executableLines.some((line) => /(^|[;&|]\s*|\$\(|`|\bcommand\s+)(rg)(?=\s|$)/.test(line)), "harness must not execute ripgrep");
assert.ok(!executableLines.some((line) => /(^|[;&|]\s*|\$\(|`|\bcommand\s+)(jq)(?=\s|$)/.test(line)), "harness path must not execute jq");
assert.doesNotMatch(sh, /\beval\b/);
assert.match(sh, /FROM pg_catalog\.pg_roles WHERE rolname='preflight_plan_ledger_writer'/);
assert.match(sh, /FROM information_schema\.table_privileges/);
assert.doesNotMatch(sh, /information_schema\.role_table_grants/);
const closedGrantInventory = /WHERE table_schema = 'public'\s+AND table_name IN \(\s+'tenant_preflight_evidence_registry',\s+'tenant_backfill_plan_ledger',\s+'tenant_backfill_plan_event'\s+\)\s+AND grantee = 'preflight_plan_ledger_writer'/;
assert.match(sh, closedGrantInventory);
assert.doesNotMatch(sh, /table_name\s+(?:NOT\s+)?LIKE|table_name\s*~|table_name\s+SIMILAR\s+TO/i);
const catalogGeneratedAt = sh.indexOf("SQL\nHARNESS_STEP=DDL_CATALOG");
const catalogPassAt = sh.indexOf("echo DDL_CATALOG=PASS");
const concurrencyStartsAt = sh.indexOf("h1=$(printf");
assert.ok(catalogGeneratedAt >= 0 && catalogPassAt > catalogGeneratedAt && concurrencyStartsAt > catalogPassAt, "catalog generation, validation pass and concurrency must be ordered");
let previousCheck = catalogGeneratedAt;
for (const [description, check] of [
  ["validate literal FOREIGN KEY catalog entry", `grep -Fq 'FOREIGN KEY' \"$tmp/catalog\"`],
  ["validate literal TRIGGER catalog entry", `grep -Fq 'TRIGGER' \"$tmp/catalog\"`],
  ["validate exactly one writer role from pg_roles", `grep -Fxc 'ROLE|preflight_plan_ledger_writer' \"$tmp/catalog\"`],
  ["validate exact evidence registry writer grant", `grep -Fxc 'GRANT|tenant_preflight_evidence_registry|preflight_plan_ledger_writer|SELECT' \"$tmp/catalog\"`],
  ["validate exact plan ledger writer grant", `grep -Fxc 'GRANT|tenant_backfill_plan_ledger|preflight_plan_ledger_writer|SELECT' \"$tmp/catalog\"`],
  ["validate exact plan event writer grant", `grep -Fxc 'GRANT|tenant_backfill_plan_event|preflight_plan_ledger_writer|SELECT' \"$tmp/catalog\"`],
  ["validate writer grant set cardinality", `grep -Fc 'GRANT|' \"$tmp/catalog\"`],
]) {
  const commandDescription = `HARNESS_COMMAND='${description}'`;
  const descriptionAt = sh.indexOf(commandDescription, previousCheck);
  const stepAt = sh.lastIndexOf("HARNESS_STEP=DDL_CATALOG", descriptionAt);
  const checkAt = sh.indexOf(check, descriptionAt);
  assert.ok(stepAt > previousCheck && stepAt < descriptionAt, `missing independent HARNESS_STEP for ${description}`);
  assert.ok(descriptionAt > previousCheck, `missing independent HARNESS_COMMAND for ${description}`);
  assert.ok(checkAt > descriptionAt && checkAt < catalogPassAt, `missing ordered literal grep for ${description}`);
  previousCheck = checkAt;
}
assert.doesNotMatch(sh, /grep\s+-(?![^\n]*F)[^\n]*\"\$tmp\/catalog\"/, "catalog grep must use fixed-string matching");
assert.match(sh, /HARNESS_RESULT=FAIL[\s\S]*EXIT_CODE=%s/);
assert.doesNotMatch(sh, /continue-on-error|\|\| true|\|\| :|exit 77|SKIP/);

// Preserve the fully diagnosed two-backend proof after the successful catalog gate.
const evidenceLaunchAt = sh.indexOf("HARNESS_COMMAND='launch two identical evidence registrations'");
const evidenceWaitAt = sh.indexOf("HARNESS_COMMAND='wait for both identical evidence registrations'");
const evidenceExitValidationAt = sh.indexOf("HARNESS_COMMAND='validate identical evidence process exit codes'");
const evidenceResultValidationAt = sh.indexOf("HARNESS_COMMAND='validate one registered and one idempotent replay result'");
const evidencePassAt = sh.indexOf("echo IDENTICAL_EVIDENCE_CONCURRENCY=PASS");
const evidenceCheckpointAt = sh.indexOf("echo CHECKPOINT=IDENTICAL_EVIDENCE_CONCURRENCY");
assert.ok(catalogPassAt < evidenceLaunchAt && evidenceLaunchAt < evidenceWaitAt && evidenceWaitAt < evidenceExitValidationAt && evidenceExitValidationAt < evidenceResultValidationAt && evidenceResultValidationAt < evidencePassAt && evidencePassAt < evidenceCheckpointAt);
assert.match(sh, /HARNESS_STEP=IDENTICAL_EVIDENCE_CONCURRENCY\s+HARNESS_COMMAND='launch two identical evidence registrations'\s+HARNESS_RESULT=RUNNING/);
assert.match(sh, /run_sql "\$evcall" "\$tmp\/evidence-1\.out" "\$tmp\/evidence-1\.err" &\s+evidence_pid_1=\$!/);
assert.match(sh, /run_sql "\$evcall" "\$tmp\/evidence-2\.out" "\$tmp\/evidence-2\.err" &\s+evidence_pid_2=\$!/);
assert.match(sh, /if wait "\$evidence_pid_1"; then evidence_exit_1=0; else evidence_exit_1=\$\?; fi/);
assert.match(sh, /if wait "\$evidence_pid_2"; then evidence_exit_2=0; else evidence_exit_2=\$\?; fi/);
assert.match(sh, /IDENTICAL_EVIDENCE_EXIT_1=%s\\nIDENTICAL_EVIDENCE_EXIT_2=%s\\nIDENTICAL_EVIDENCE_PROCESSES=WAITED/);
assert.match(sh, /safe_sqlstate\(\)[\s\S]*IDENTICAL_EVIDENCE_BACKEND_%s_SQLSTATE=%s/);
assert.match(sh, /if \[\[ \$evidence_exit_1 -ne 0 \|\| \$evidence_exit_2 -ne 0 \]\]; then[\s\S]*exit "\$evidence_exit_/);
assert.match(sh, /grep -Fxc 'REGISTERED' "\$tmp\/evidence-1\.out"/);
assert.match(sh, /grep -Fxc 'REGISTERED' "\$tmp\/evidence-2\.out"/);
assert.match(sh, /grep -Fxc 'IDEMPOTENT_REPLAY' "\$tmp\/evidence-1\.out"/);
assert.match(sh, /grep -Fxc 'IDEMPOTENT_REPLAY' "\$tmp\/evidence-2\.out"/);
assert.match(sh, /wc -l < "\$tmp\/evidence-1\.out"[\s\S]*wc -l < "\$tmp\/evidence-2\.out"[\s\S]*-eq 2/);

for (const [step, command] of [
  ["CONFLICTING_EVIDENCE_CONCURRENCY", "launch and wait for conflicting evidence registrations"],
  ["IDENTICAL_PLAN_CONCURRENCY", "launch and wait for two identical plan registrations"],
  ["CONFLICTING_PLAN_CONCURRENCY", "launch and wait for conflicting plan registrations"],
  ["CRASH_ROLLBACK_RESUME", "rollback synthetic evidence and plan transaction and validate absence"],
  ["APPEND_ONLY_NEGATIVE_PROOFS", "validate writer UPDATE and DELETE operations fail with SQLSTATE 42501"],
  ["TEARDOWN_TRANSACTIONAL", "rollback candidate teardown and validate objects remain"],
  ["TEARDOWN_REAL", "remove candidate ledger objects"],
  ["BASELINE_COMPARISON", "compare public catalog before and after teardown"],
  ["FINAL", "emit final PostgreSQL ledger proof result"],
]) assert.match(sh, new RegExp(`HARNESS_STEP=${step}\\s+HARNESS_COMMAND='${command}'`));
assert.match(sh, /conflict_evidence_pid_1=\$![\s\S]*conflict_evidence_pid_2=\$![\s\S]*wait "\$conflict_evidence_pid_1"[\s\S]*wait "\$conflict_evidence_pid_2"/);
assert.match(sh, /plan_pid_1=\$![\s\S]*plan_pid_2=\$![\s\S]*wait "\$plan_pid_1"[\s\S]*wait "\$plan_pid_2"/);
assert.match(sh, /conflict_plan_pid_1=\$![\s\S]*conflict_plan_pid_2=\$![\s\S]*wait "\$conflict_plan_pid_1"[\s\S]*wait "\$conflict_plan_pid_2"/);
assert.match(sh, /grep -Fc '23505'/);
assert.match(sh, /UPDATE public\.tenant_preflight_evidence_registry SET evidence_hash=/);
assert.match(sh, /UPDATE public\.tenant_backfill_plan_ledger SET plan_hash=/);
assert.match(sh, /UPDATE public\.tenant_backfill_plan_ledger SET apply_authorized=true/);
assert.match(sh, /DELETE FROM public\.tenant_preflight_evidence_registry/);
assert.match(sh, /DELETE FROM public\.tenant_backfill_plan_ledger/);
assert.match(sh, /DELETE FROM public\.tenant_backfill_plan_event/);
assert.match(sh, /BEGIN; SET ROLE preflight_plan_ledger_writer;[\s\S]*plan-crash[\s\S]*ROLLBACK;/);
assert.match(sh, /printf 'BEGIN; %s ROLLBACK;/);
assert.match(sh, /printf '%s\\n' "\$teardown" \| "\$\{psql\[@\]\}"/);
assert.match(sh, /cmp "\$tmp\/before" "\$tmp\/after"/);
assert.ok(sh.lastIndexOf("PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS") > sh.indexOf("HARNESS_STEP=FINAL"));
console.log("PREFLIGHT_PLAN_LEDGER_SAFETY=PASS");
