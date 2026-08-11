import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./preflightPlanLedger.ts", import.meta.url), "utf8");
for (const operation of ["registerEvidence", "registerPlan", "appendEvent", "lookupEvidence", "lookupPlan"])
  assert.match(source, new RegExp(`${operation}\\(`));
assert.doesNotMatch(source, /from\s+["'][^"']*prisma|DATABASE_URL|new URL\s*\(\s*["']postgres/i);
console.log("PREFLIGHT_PLAN_LEDGER_CONTRACT=PASS");
