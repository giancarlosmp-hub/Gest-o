import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../apps/api/src/tenancy/preflightGatedBackfillPlan.ts", import.meta.url), "utf8");
const harness = fs.readFileSync(new URL("./preflight-gated-backfill-plan-postgres.sh", import.meta.url), "utf8");
for (const forbidden of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bCREATE\s+TABLE\b/i, /authorize.*apply/i]) assert.doesNotMatch(source, forbidden);
assert.match(source, /dryRunOnly: true/);
assert.match(source, /applyAuthorized: false/);
assert.doesNotMatch(source, /process\.env\.DATABASE_URL|@prisma\/client/);

assert.match(harness, /POSTGRES_DB=gated_plan/);
assert.match(harness, /docker exec -i "\$name" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d gated_plan -c 'SELECT 1;'/);
assert.match(harness, /for readiness_attempt in \$\(seq 1 60\); do/);
assert.match(harness, /readiness_exit=\$\?/);
assert.match(harness, /wc -l < "\$tmp\/readiness\.out"/);
assert.match(harness, /grep -Fqx '1' "\$tmp\/readiness\.out"/);
assert.match(harness, /HARNESS_STEP=database_readiness\s+HARNESS_COMMAND='wait for gated_plan SQL readiness'/);
const loopEndAt = harness.indexOf('[[ "$readiness_ready" == true ]]');
const finalConnectionAt = harness.indexOf("HARNESS_COMMAND='validate final independent gated_plan SQL connection'");
const readinessPassAt = harness.indexOf("GATED_PLAN_DATABASE_READINESS=PASS");
const extensionAt = harness.indexOf("CREATE EXTENSION pgcrypto");
const factsAt = harness.indexOf("CREATE TABLE facts");
const fixtureAt = harness.indexOf("INSERT INTO facts");
const baselineAt = harness.indexOf("before=$(dataset_hash)");
assert.ok(loopEndAt >= 0 && loopEndAt < finalConnectionAt && finalConnectionAt < readinessPassAt && readinessPassAt < extensionAt && readinessPassAt < factsAt && readinessPassAt < fixtureAt && readinessPassAt < baselineAt);
assert.match(harness, /readiness-final\.out[\s\S]*final_readiness_exit=\$\?[\s\S]*\[\[ \$final_readiness_exit -eq 0 \]\][\s\S]*wc -l < "\$tmp\/readiness-final\.out"[\s\S]*grep -Fqx '1' "\$tmp\/readiness-final\.out"/);
assert.match(harness, /\[\[ -z "\$\{DATABASE_URL:-\}" && -z "\$\{TEST_DATABASE_URL:-\}" \]\]/);
assert.doesNotMatch(harness, /-d postgres(?:\s|$)|CREATE DATABASE\s+gated_plan|pg_isready|continue-on-error|\|\| true|\|\| :|\beval\b|exit 77|SKIP|set -x|\brg\b|\bjq\b/i);
assert.match(harness, /BEGIN TRANSACTION READ ONLY;/g);
assert.ok(harness.lastIndexOf("PREFLIGHT_GATED_BACKFILL_POSTGRES=PASS") > harness.indexOf("HARNESS_STEP=final") && harness.indexOf("HARNESS_STEP=final") > baselineAt);

const readinessDecision = (exitCode, stdout, database) => exitCode === 0 && stdout === "1\n" && database === "gated_plan";
assert.equal(readinessDecision(0, "1\n", "gated_plan"), true);
for (const rejected of [
  [1, "1\n", "gated_plan"], [0, "", "gated_plan"], [0, "1\n1\n", "gated_plan"],
  [0, "0\n", "gated_plan"], [0, "SELECT 1\n1\n", "gated_plan"], [0, "1\n", "postgres"],
]) assert.equal(readinessDecision(...rejected), false);
console.log("PREFLIGHT_GATED_BACKFILL_PLAN_SAFETY=PASS");
