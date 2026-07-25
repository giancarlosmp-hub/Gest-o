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
for (const forbiddenCredential of ["POSTGRES_USER", "POSTGRES_PASSWORD", "DATABASE_URL"]) {
  assert.ok(!source.includes(forbiddenCredential), `backup não deve depender de ${forbiddenCredential}`);
}
assert.match(source, /DB_NAME="\$\{DB_NAME:-\}"/);
assert.match(source, /DB_NAME="\$\{DB_NAME:-salesforce_pro\}"/);
assert.match(source, /sed -n 's\/\^POSTGRES_DB=\/\/p'/);
assert.match(source, /docker exec -u postgres "\$DB_CONTAINER" \\\n+  psql -U postgres -d "\$DB_NAME"/);
assert.match(source, /docker exec -u postgres "\$DB_CONTAINER" \\\n+  pg_dump -U postgres -d "\$DB_NAME"/);
assert.ok(source.indexOf("psql -U postgres") < source.indexOf("pg_dump -U postgres"), "peer deve ser validado antes do dump");
assert.match(source, /if \[\[ "\$CANDIDATE_CREATED" == 1 \]\]/);
assert.match(source, /\[\[ "\$\(docker inspect --format '\{\{\.State\.Status\}\}' "\$CANDIDATE"\)" == exited \]\]/);
console.log("erp audit candidate script smoke ok");
