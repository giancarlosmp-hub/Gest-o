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
assert.match(sh, /WHERE table_schema = 'public'\s+AND \(\s+table_name LIKE 'tenant_%ledger%'\s+OR table_name = 'tenant_preflight_evidence_registry'\s+\)/);
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
console.log("PREFLIGHT_PLAN_LEDGER_SAFETY=PASS");
