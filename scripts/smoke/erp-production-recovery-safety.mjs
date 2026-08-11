import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const workflow = read(".github/workflows/erp-production-recovery.yml");
const recovery = read("scripts/erp-production-recovery.sh");
const deploy = read(".github/workflows/deploy-production.yml");

for (const expected of [
  "workflow_dispatch:", "confirm:", "RESTORE_ERP_AUTOMATIC_SYNC", "expected_main_sha:",
  "environment: production-cutover", "group: erp-production-recovery", "cancel-in-progress: false",
  "appleboy/ssh-action@v1.2.0", "secrets.SSH_HOST || secrets.VPS_HOST",
  "secrets.SSH_USER || secrets.VPS_USER", "secrets.SSH_KEY || secrets.VPS_KEY",
  "secrets.SSH_PORT || secrets.VPS_PORT", "git pull --ff-only origin main",
  "secrets.AUTH_TEST_EMAIL", "secrets.AUTH_TEST_PASSWORD",
]) assert.match(workflow, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const inputs = workflow.slice(workflow.indexOf("inputs:"), workflow.indexOf("permissions:"));
assert.doesNotMatch(inputs, /secret|password|token|key:/i, "workflow inputs must never transport secrets");
for (const secretFamily of ["SSH_HOST", "VPS_HOST", "SSH_USER", "VPS_USER", "SSH_KEY", "VPS_KEY", "SSH_PORT"])
  assert.match(deploy, new RegExp(secretFamily), `official deploy must establish SSH secret ${secretFamily}`);

for (const expected of [
  "/root/demetra-env/.env", "/root/demetra-env/production.env", "ERP_ENV_RECOVERY_SOURCE=NOT_AVAILABLE",
  "install -o root -g root -m 600", "legacy_copy", "ERP_SYNC_SCHEDULER_ENABLED=true", "mktemp",
  "bash -n", "erp-scheduler-before-", "restore_env", "ERP_RECOVERY_ROLLBACK=COMPLETED",
  "up -d --no-deps --no-build --force-recreate api", "trigger:'scheduler'", "startedAt:{gt:since}",
  "ERP_AUTOMATIC_TRIGGER=scheduler", "ERP_AUTOMATIC_SYNC=PASS", "ERP_SYNC_LOCK=RELEASED",
  "ERP_SYNC_ENV_PERSISTENCE=PASS", "ERP_SCHEDULER_INITIALIZED=PASS", "ERP_NEXT_RUN_AT=PRESENT",
]) assert.ok(recovery.includes(expected), `recovery contract is missing: ${expected}`);

assert.ok(recovery.indexOf('install -o root -g root -m 600 "$tmp_env" "$ENV_FILE"') > -1);
assert.doesNotMatch(recovery, /\bmv\s+[^\n]*LEGACY_ENV_FILE/, "legacy source must be preserved");
assert.doesNotMatch(recovery, /docker\s+compose[^\n]*(?:\sdown\b|\sdown\s+-v)|docker\s+(?:system\s+prune|volume\s+rm)/);
assert.doesNotMatch(recovery, /prisma\s+(?:migrate|db\s+push)|docker-compose\.yml/);
assert.doesNotMatch(recovery, /(?:up|stop|rm)[^\n]*(?:\bweb\b|\bdb\b)/, "recovery must mutate only the API service");

for (const doc of ["docs/STATUS_ATUAL.md", "docs/DOCUMENTO_MESTRE.md", "docs/OPERACAO.md", "docs/DEPLOY_GUIDE.md", "docs/investigations/inc-erp-5050-automatic-sync-recurrence-2026-08.md"])
  assert.match(read(doc), /ERP Production Recovery/, `${doc} must document the recovery channel`);

const shell = spawnSync("bash", ["-n", resolve(root, "scripts/erp-production-recovery.sh")], { encoding: "utf8" });
assert.equal(shell.status, 0, shell.stderr);
const match = workflow.match(/          script: \|\n([\s\S]+)$/);
assert.ok(match, "SSH script block must exist");
const extracted = match[1].split("\n").map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");
const temp = mkdtempSync(join(tmpdir(), "erp-recovery-workflow-"));
const script = join(temp, "remote.sh"); writeFileSync(script, extracted);
const workflowShell = spawnSync("bash", ["-n", script], { encoding: "utf8" });
rmSync(temp, { recursive: true, force: true });
assert.equal(workflowShell.status, 0, workflowShell.stderr);

const contract = spawnSync(process.execPath, [resolve(root, "scripts/smoke/erp-production-recovery-contract.mjs")], { encoding: "utf8" });
assert.equal(contract.status, 0, `${contract.stdout}\n${contract.stderr}`);

console.log("ERP production recovery safety: PASS");
