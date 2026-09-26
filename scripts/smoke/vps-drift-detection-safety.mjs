import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

// 1. Verify vps-drift-detection.yml
const driftWorkflowPath = resolve(root, ".github/workflows/vps-drift-detection.yml");
const driftContent = readFileSync(driftWorkflowPath, "utf8");

// Assert schedule cron exists (06:00 BRT = 09:00 UTC)
assert.match(driftContent, /cron:\s*['"]0 9 \* \* \*['"]/);
assert.match(driftContent, /workflow_dispatch:/);

// Extract the script
const scriptMatch = driftContent.match(/script:\s*\|([\s\S]+)$/m);
assert.ok(scriptMatch, "script block must exist in vps-drift-detection.yml");
const script = scriptMatch[1];

// Validate bash syntax
const bashCheck = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
assert.equal(bashCheck.status, 0, `vps-drift-detection remote script bash -n failed: ${bashCheck.stderr}`);

// Validate strictly read-only commands
assert.match(script, /git status --porcelain/);
assert.match(script, /git rev-parse HEAD/);
assert.match(script, /git rev-parse origin\/main/);
assert.match(script, /git fetch origin main/);

// Confirm NO mutating git commands exist
const forbiddenMutations = [
  /git\s+stash/i,
  /git\s+reset/i,
  /git\s+clean/i,
  /git\s+pull/i,
  /git\s+checkout\s+--/i,
  /git\s+restore/i,
  /git\s+update-ref/i,
  /git\s+commit/i,
  /git\s+push/i,
];

for (const pattern of forbiddenMutations) {
  assert.doesNotMatch(script, pattern, `Read-only drift script must not contain mutating command matching: ${pattern}`);
}

// 2. Verify Protection 1 explicit error messaging in prepare-production-recovery-backup.sh and workflow
const prepBackupScriptPath = resolve(root, "scripts/prepare-production-recovery-backup.sh");
const prepBackupScriptContent = readFileSync(prepBackupScriptPath, "utf8");
assert.match(prepBackupScriptContent, /\[CRITICAL\] Working tree em .* não está limpo\. Backup abortado\./);
assert.match(prepBackupScriptContent, /git status --porcelain/);
assert.match(prepBackupScriptContent, /Investigue antes de descartar\. Ver runbook: docs\/OPERACAO\.md/);

const prepBackupWorkflowPath = resolve(root, ".github/workflows/prepare-production-recovery-backup.yml");
const prepBackupWorkflowContent = readFileSync(prepBackupWorkflowPath, "utf8");
assert.match(prepBackupWorkflowContent, /\[CRITICAL\] Working tree em \/apps\/gest-o não está limpo\. Backup abortado\./);
assert.match(prepBackupWorkflowContent, /git status --porcelain/);
assert.match(prepBackupWorkflowContent, /Investigue antes de descartar\. Ver runbook: docs\/OPERACAO\.md/);

console.log("VPS Drift Detection & Worktree Safety Check: PASS");
