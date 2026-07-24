import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/run-erp-audit-candidate.sh";
const source = readFileSync(file, "utf8");
assert.equal(spawnSync("bash", ["-n", file]).status, 0, "script deve ter sintaxe bash válida");
for (const required of ["set -Eeuo pipefail", "ERP_CODE", "DRY_RUN", "CONFIRM", "flock -n", "CANDIDATE_CREATED", "PGOPTIONS", "docker create", "docker start -a", "statement_timeout", "candidate-$RUN_ID"]) {
  assert.ok(source.includes(required), `script deve conter ${required}`);
}
for (const forbidden of ["docker compose down", "docker volume rm", "migrate reset", "--apply", "crm:repair", "prisma:seed", "node apps/api/dist/server.js", "docker run -d", "--network-alias api"]) {
  assert.ok(!source.includes(forbidden), `script não deve conter ${forbidden}`);
}
assert.match(source, /if \[\[ "\$CANDIDATE_CREATED" == 1 \]\]/);
assert.match(source, /\[\[ "\$\(docker inspect --format '\{\{\.State\.Status\}\}' "\$CANDIDATE"\)" == exited \]\]/);
console.log("erp audit candidate script smoke ok");
