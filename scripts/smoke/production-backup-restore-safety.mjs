import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = new URL("./production-backup-restore-postgres.sh", import.meta.url);
const source = readFileSync(file, "utf8");
const absent = [
  "/root/demetra-env/production.env", "docker system prune", "docker volume prune",
  "compose down -v", "-p 5432", "--publish", "--network gest-o_default",
  "gest-o-db-clean-v2-20260717", "DATABASE_URL=postgres", "docker volume rm",
];
for (const value of absent) assert.ok(!source.includes(value), `referência proibida: ${value}`);
for (const pattern of [
  /--pull=never/, /docker network create --internal/, /TARGET_CONTAINER=.*RANDOM|TARGET_CONTAINER=.*SAFE_ID/,
  /trap cleanup EXIT ERR INT TERM/, /sha256sum -c/, /pg_restore --list/,
  /TARGET_DB="gesto_restore_\$RANDOM"/, /--tmpfs \/var\/lib\/postgresql\/data/,
  /result\.tsv/, /variável externa proibida/, /docker network rm/, /docker rm -f/,
]) assert.match(source, pattern);
assert.ok(source.lastIndexOf('>"$EVIDENCE_DIR/result.tsv"') > source.indexOf("segunda conexão falhou"));
assert.ok(!/echo .*\$ADMIN_PASSWORD|printf .*\$ADMIN_PASSWORD/.test(source), "senha não pode ser impressa");
assert.ok(!/docker (run|create)[^\n]*(--publish|-p[ =])/.test(source), "porta não pode ser publicada");
console.log("PASS: guardrails estáticos do restore descartável validados");
