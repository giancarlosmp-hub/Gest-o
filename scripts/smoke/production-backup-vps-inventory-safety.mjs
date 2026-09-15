import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../diagnose-production-disk-capacity.sh", import.meta.url), "utf8");

for (const required of [
  "/root/backups",
  "/var/backups/gest-o/automatic",
  "/var/log/gest-o/backup",
  "findmnt -T",
  "df -Pk",
  "df -Pi",
  "device=%D",
  "inode=%i",
  "latest_state=symlink_rejected",
  "crontab -l",
  "root_crontab_backup_entry_line=",
  "systemctl list-timers --all",
]) assert.ok(source.includes(required), `inventário obrigatório ausente: ${required}`);

for (const forbidden of [
  "docker system prune",
  "docker builder prune",
  "docker volume prune",
  "docker image prune",
  "rm -",
  "source /root/demetra-env",
  "cat /root/demetra-env",
  "printenv",
]) assert.ok(!source.includes(forbidden), `operação proibida no inventário: ${forbidden}`);

assert.match(source, /\$1=="FORMAT"[\s\S]*\$1=="SHA"/);
assert.doesNotMatch(source, /cat\s+[^\n]*(result\.tsv|\.env|\.sql|\.dump)/);
console.log("PASS: inventário VPS cobre destinos, latest e schedulers sem mutação ou conteúdo protegido");
