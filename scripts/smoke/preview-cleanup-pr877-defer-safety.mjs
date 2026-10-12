import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/preview-cleanup.yml', 'utf8');
assert.match(workflow, /pull_request:\s*\n\s*types: \[closed\]/);
assert.doesNotMatch(workflow, /workflow_dispatch/);

const deferStart = workflow.indexOf('  defer-cleanup-pr-877:');
const cleanupStart = workflow.indexOf('  cleanup-preview:');
assert.ok(deferStart >= 0 && cleanupStart > deferStart, 'defer job must be explicit and precede the normal cleanup job');
const deferred = workflow.slice(deferStart, cleanupStart);
const cleanup = workflow.slice(cleanupStart);

assert.match(deferred, /if: github\.event\.pull_request\.number == 877/);
assert.match(deferred, /PREVIEW_CLEANUP_RESULT=DEFERRED/);
assert.match(deferred, /PREVIEW_CLEANUP_EXECUTED=NO/);
assert.match(deferred, /PREVIEW_CLEANUP_REASON=PR_877_NETWORK_CAPACITY_INCIDENT/);
assert.doesNotMatch(deferred, /actions\/checkout|appleboy|ssh|scp|secrets\.|VPS_|CLEANUP_RUNNER|docker|compose|PREVIEW_CLEANUP_RESULT=(?:PASS|COMPLETED)/i);

assert.match(cleanup, /if: github\.event\.pull_request\.number != 877/);
assert.match(cleanup, /uses: actions\/checkout@v4/);
assert.match(cleanup, /uses: appleboy\/scp-action@v0\.1\.7/);
// Execution moved from appleboy/ssh-action to OpenSSH so the remote output is captured and parsed.
assert.doesNotMatch(cleanup, /appleboy\/ssh-action/);
assert.match(cleanup, /ssh -i "\$key_file" -p 22022[\s\S]*'bash -s' < "\$request_file" > "\$remote_output"/);
assert.match(cleanup, /::stop-commands::[\s\S]*cat "\$remote_output"[\s\S]*node scripts\/preview-cleanup-result\.mjs "\$remote_output" "\$ssh_rc" "\$GITHUB_STEP_SUMMARY"/);
assert.match(cleanup, /bash "\$CLEANUP_RUNNER"/);
assert.doesNotMatch(cleanup, /continue-on-error|\|\|\s*true|exit\s+77|SKIP/i);

console.log('PREVIEW_CLEANUP_PR877_DEFER=PASS vps_access=0 cleanup_executed=NO other_prs=UNCHANGED');
