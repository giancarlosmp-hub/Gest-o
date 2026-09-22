#!/usr/bin/env node

import { readFileSync, appendFileSync } from 'node:fs';

const [outputPath, sshExitText, githubOutputPath] = process.argv.slice(2);
if (!outputPath || !sshExitText || !githubOutputPath) {
  console.error('usage: preview-authorization-diagnostic-result.mjs OUTPUT SSH_EXIT GITHUB_OUTPUT');
  process.exit(2);
}

const sshExit = Number(sshExitText);
if (!Number.isInteger(sshExit) || sshExit < 0 || sshExit > 255) process.exit(2);

const lines = readFileSync(outputPath, 'utf8').split(/\r?\n/);
const last = (pattern) => lines.map((line) => line.match(pattern)).filter(Boolean).at(-1);
const started = Boolean(last(/^PREVIEW_AUTH_DIAGNOSTIC_REMOTE_STARTED=YES$/));
const resultMatch = last(/^PREVIEW_AUTH_DIAGNOSTIC_RESULT=(PASS|PRESERVED|ERROR) reason=([A-Za-z0-9_.-]+)(?: field=([A-Za-z0-9_.-]+))?$/);
const exitMatch = last(/^PREVIEW_AUTH_DIAGNOSTIC_EXIT_CODE=(0|[1-9][0-9]{0,2}|NOT_EXECUTED|UNKNOWN)$/);
const cleanupMatch = last(/^PREVIEW_AUTH_DIAGNOSTIC_CLEANUP_EXECUTED=NO$/);
const temporaryMatch = last(/^PREVIEW_AUTH_DIAGNOSTIC_TEMP_CLEANUP=(REMOVED|FAILED|REFUSED)$/);

let result = resultMatch?.[1] ?? 'ERROR';
let reason = resultMatch?.[2] ?? (started ? 'missing_or_invalid_remote_result' : 'ssh_failed_before_remote_execution');
let field = resultMatch?.[3] ?? '';
let authorizeExit = exitMatch?.[1] ?? (started ? 'UNKNOWN' : 'NOT_EXECUTED');

// A successful diagnostic record is valid only as a complete, non-mutating record.
if (!resultMatch || !exitMatch || !cleanupMatch) {
  result = 'ERROR';
  reason = started ? 'missing_or_invalid_remote_result' : 'ssh_failed_before_remote_execution';
  field = '';
}
if (result === 'PASS' && authorizeExit !== '0') {
  result = 'ERROR'; reason = 'invalid_remote_result'; field = '';
}
if (result === 'PRESERVED' && (authorizeExit === '0' || authorizeExit === 'NOT_EXECUTED' || authorizeExit === 'UNKNOWN')) {
  result = 'ERROR'; reason = 'invalid_remote_result'; field = '';
}

const values = {
  result,
  reason,
  field: field || 'NOT_AVAILABLE',
  authorize_exit_code: authorizeExit,
  cleanup_executed: 'NO',
  temporary_cleanup: temporaryMatch?.[1] ?? 'NOT_PROVEN',
  ssh_exit_code: String(sshExit),
};
appendFileSync(githubOutputPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
