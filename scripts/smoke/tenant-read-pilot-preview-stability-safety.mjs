import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/preview.yml", "utf8");
const ci = readFileSync(".github/workflows/docker-compose-ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

const datasetGate = ci.indexOf("Prove tenant read pilot preview dataset");
const stabilityGate = ci.indexOf("Prove tenant read pilot preview stability contract");
const generalSmoke = ci.indexOf("Prove synthetic PostgreSQL 16 backup restore");
assert.ok(datasetGate >= 0 && stabilityGate > datasetGate && generalSmoke > stabilityGate, "stability gate must follow the dataset gate and precede general smokes");
const stabilityStep = ci.slice(stabilityGate, ci.indexOf("\n      - name:", stabilityGate + 1));
assert.match(stabilityStep, /run: npm run test:tenant-read-pilot-preview-stability/);
assert.doesNotMatch(stabilityStep, /continue-on-error|\bif\s*:|SKIP|exit\s+77|\|\|\s*true|set\s+-x/i);

const command = packageJson.scripts["test:tenant-read-pilot-preview-stability"];
assert.match(command, /tenantReadPilot\.http\.test\.ts/);
assert.match(command, /tenant-read-pilot-safety\.mjs/);
assert.match(command, /tenant-read-pilot-preview-safety\.mjs/);
assert.match(command, /tenant-read-pilot-preview-stability-safety\.mjs/);

for (const checkpoint of [
  "TENANT_READ_PREVIEW_SEED=PASS",
  "TENANT_READ_PREVIEW_DATASET=PASS",
  "TENANT_READ_PREVIEW_LOGIN_HTTP=",
  "TENANT_READ_PREVIEW_TOKEN=ACQUIRED",
  "TENANT_READ_PREVIEW_REQUEST_IDS=ACQUIRED",
  "TENANT_READ_PREVIEW_SHADOW=MATCH",
  "TENANT_READ_PREVIEW_STABILITY_CYCLES=10",
  "TENANT_READ_PREVIEW_STABILITY_REQUESTS=40",
  "TENANT_READ_PREVIEW_STABILITY_MATCH=40",
  "TENANT_READ_PREVIEW_STABILITY_MISMATCH=0",
  "TENANT_READ_PREVIEW_STABILITY=PASS",
]) assert.ok(workflow.includes(checkpoint), `missing checkpoint: ${checkpoint}`);

assert.match(workflow, /STABILITY_CYCLES=10/);
assert.match(workflow, /REQUESTS_PER_CYCLE=4/);
assert.match(workflow, /for cycle in \$\(seq 1 "\$STABILITY_CYCLES"\)/);
assert.match(workflow, /logs --since "\$SHADOW_SINCE" --until "\$SHADOW_UNTIL" api/);
assert.match(workflow, /TENANT_READ_PREVIEW_STABILITY=\{/);
assert.match(workflow, /rollback_preview_pilot/);
assert.doesNotMatch(workflow, /-H\s+['"]?X-Request-Id:/i);
assert.doesNotMatch(workflow, /continue-on-error|\|\| true|exit 77|set -x/);
console.log("TENANT_READ_PREVIEW_STABILITY_STATIC_GATE=PASS");
