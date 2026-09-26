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

// 1b. Real bash execution test simulating dirty worktree and SHA drift scenarios
const mockExecutionWrapper = (mockEnv) => {
  const harness = `
set -Eeuo pipefail
cd() { :; }
git() {
  case "$*" in
    "fetch origin main") return 0 ;;
    "status --porcelain") echo "\${MOCK_WORKTREE_STATUS:-}" ;;
    "rev-parse HEAD") echo "\${MOCK_LOCAL_SHA:-1111111111111111111111111111111111111111}" ;;
    "rev-parse origin/main") echo "\${MOCK_REMOTE_SHA:-1111111111111111111111111111111111111111}" ;;
    *) return 0 ;;
  esac
}
${script}
`;
  return spawnSync("bash", ["-c", harness], {
    env: { ...process.env, ...mockEnv },
    encoding: "utf8",
  });
};

// Scenario A: Dirty worktree
const dirtyRun = mockExecutionWrapper({
  MOCK_WORKTREE_STATUS: " M apps/api/src/server.ts\n?? un-tracked.txt",
  MOCK_LOCAL_SHA: "1111111111111111111111111111111111111111",
  MOCK_REMOTE_SHA: "1111111111111111111111111111111111111111",
});
assert.equal(dirtyRun.status, 1, "Drift execution with dirty worktree must exit with code 1");
assert.doesNotMatch(dirtyRun.stderr, /printf:.*invalid option/i, "printf must not throw invalid option error");
assert.match(dirtyRun.stderr, /\[CRITICAL\] Drift detectado na VPS em \/apps\/gest-o!/);
assert.match(dirtyRun.stderr, /--- Working tree em \/apps\/gest-o não está limpo ---/);
assert.match(dirtyRun.stderr, /M apps\/api\/src\/server\.ts/);
assert.match(dirtyRun.stderr, /\?\? un-tracked\.txt/);

// Scenario B: SHA drift
const shaDriftRun = mockExecutionWrapper({
  MOCK_WORKTREE_STATUS: "",
  MOCK_LOCAL_SHA: "1111111111111111111111111111111111111111",
  MOCK_REMOTE_SHA: "2222222222222222222222222222222222222222",
});
assert.equal(shaDriftRun.status, 1, "Drift execution with SHA drift must exit with code 1");
assert.doesNotMatch(shaDriftRun.stderr, /printf:.*invalid option/i, "printf must not throw invalid option error");
assert.match(shaDriftRun.stderr, /\[CRITICAL\] Drift detectado na VPS em \/apps\/gest-o!/);
assert.match(shaDriftRun.stderr, /--- Divergência de SHA entre HEAD local e origin\/main ---/);
assert.match(shaDriftRun.stderr, /HEAD local:\s+1111111111111111111111111111111111111111/);
assert.match(shaDriftRun.stderr, /origin\/main:\s+2222222222222222222222222222222222222222/);

// Scenario C: Both dirty worktree and SHA drift
const bothDriftRun = mockExecutionWrapper({
  MOCK_WORKTREE_STATUS: " M package.json",
  MOCK_LOCAL_SHA: "1111111111111111111111111111111111111111",
  MOCK_REMOTE_SHA: "2222222222222222222222222222222222222222",
});
assert.equal(bothDriftRun.status, 1, "Drift execution with both dirty worktree and SHA drift must exit with code 1");
assert.doesNotMatch(bothDriftRun.stderr, /printf:.*invalid option/i, "printf must not throw invalid option error");
assert.match(bothDriftRun.stderr, /--- Working tree em \/apps\/gest-o não está limpo ---/);
assert.match(bothDriftRun.stderr, /--- Divergência de SHA entre HEAD local e origin\/main ---/);

// Scenario D: Clean worktree and synced SHA
const cleanRun = mockExecutionWrapper({
  MOCK_WORKTREE_STATUS: "",
  MOCK_LOCAL_SHA: "1111111111111111111111111111111111111111",
  MOCK_REMOTE_SHA: "1111111111111111111111111111111111111111",
});
assert.equal(cleanRun.status, 0, "Clean drift execution must exit with code 0");
assert.match(cleanRun.stdout, /\[OK\] VPS working tree limpo e sincronizado com origin\/main/);

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
