import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preview = readFileSync(".github/workflows/preview.yml", "utf8");
const production = readFileSync("docker-compose.production.yml", "utf8");
const seed = preview.indexOf("=== PREVIEW SEED ===");
const validate = preview.indexOf("=== CERTIFY PREVIEW DATASET ===");
const enable = preview.indexOf("Enable only after seed certification");
const request = preview.indexOf("REAL GET /clients SHADOW PROOF");
assert.ok(seed >= 0 && seed < validate && validate < enable && enable < request, "preview must order seed -> validate -> enable -> request");
for (const marker of ["TENANT_READ_PREVIEW_SEED=PASS", "TENANT_READ_PREVIEW_DATASET=PASS", "TENANT_READ_PREVIEW_SHADOW=MATCH", "DEFAULT_TENANT_ID=tenant-default-v1", '"result":"MATCH"', '"result":"MISMATCH"']) assert.ok(preview.includes(marker), `missing ${marker}`);
assert.ok(!preview.includes("set -x"), "preview must not trace credentials");
assert.match(preview, /TENANT_READ_PILOT_ENABLED=false/);
assert.match(preview, /TENANCY_MODE=disabled/);
assert.match(production, /TENANCY_MODE:\s*(?:"disabled"|disabled)/);
assert.match(production, /TENANT_READ_PILOT_ENABLED:\s*"false"/);
console.log("tenant read pilot preview workflow safety: PASS");
