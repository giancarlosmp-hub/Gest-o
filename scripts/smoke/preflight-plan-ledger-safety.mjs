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
assert.doesNotMatch(sh, /\|\| true|exit 77|SKIP/);
console.log("PREFLIGHT_PLAN_LEDGER_SAFETY=PASS");
