import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../apps/api/src/tenancy/preflightGatedBackfillPlan.ts", import.meta.url), "utf8");
for (const forbidden of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bCREATE\s+TABLE\b/i, /authorize.*apply/i]) assert.doesNotMatch(source, forbidden);
assert.match(source, /dryRunOnly: true/);
assert.match(source, /applyAuthorized: false/);
assert.doesNotMatch(source, /process\.env\.DATABASE_URL|@prisma\/client/);
console.log("PREFLIGHT_GATED_BACKFILL_PLAN_SAFETY=PASS");
