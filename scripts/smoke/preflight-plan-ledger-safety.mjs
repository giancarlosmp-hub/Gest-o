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
const catalogGeneratedAt = sh.indexOf("SQL\nHARNESS_STEP=DDL_CATALOG");
const concurrencyStartsAt = sh.indexOf("h1=$(printf");
assert.ok(catalogGeneratedAt >= 0 && concurrencyStartsAt > catalogGeneratedAt, "catalog checks must precede concurrency");
let previousCheck = catalogGeneratedAt;
for (const literal of ["FOREIGN KEY", "TRIGGER", "preflight_plan_ledger_writer"]) {
  const commandDescription = `HARNESS_COMMAND='validate literal ${literal} catalog entry'`;
  const descriptionAt = sh.indexOf(commandDescription, previousCheck);
  const checkAt = sh.indexOf(`grep -Fq '${literal}' \"$tmp/catalog\"`, descriptionAt);
  assert.ok(descriptionAt > previousCheck, `missing independent HARNESS_COMMAND for ${literal}`);
  assert.ok(checkAt > descriptionAt && checkAt < concurrencyStartsAt, `missing ordered literal grep for ${literal}`);
  previousCheck = checkAt;
}
assert.doesNotMatch(sh, /grep\s+-(?![^\n]*F)[^\n]*\"\$tmp\/catalog\"/, "catalog grep must use fixed-string matching");
assert.match(sh, /HARNESS_RESULT=FAIL[\s\S]*EXIT_CODE=%s/);
assert.doesNotMatch(sh, /continue-on-error|\|\| true|\|\| :|exit 77|SKIP/);
console.log("PREFLIGHT_PLAN_LEDGER_SAFETY=PASS");
