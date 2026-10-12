#!/usr/bin/env node
// Reads the captured output of preview-cleanup-remote.sh and turns its strict markers into a job
// summary and annotations. Only allowlisted tokens are echoed back: nothing else from the remote
// output reaches the summary or a workflow command.
//
// Exit codes: 0 = PASS or PRESERVED (preserved projects become a ::warning::, not a failure);
// 1 = FAIL, ssh failure or missing/invalid final marker.

import { appendFileSync, readFileSync } from 'node:fs';

const [outputPath, sshExitText, summaryPath] = process.argv.slice(2);
if (!outputPath || sshExitText === undefined || !summaryPath) {
  console.error('usage: preview-cleanup-result.mjs OUTPUT SSH_EXIT SUMMARY_PATH');
  process.exit(2);
}
const sshExit = Number(sshExitText);
if (!Number.isInteger(sshExit) || sshExit < 0 || sshExit > 255) process.exit(2);

const SAFE = /^[A-Za-z0-9_.-]+$/;
const PROJECT = /^gesto-pr-[0-9]+-[0-9]+-[0-9]+$/;
const lines = readFileSync(outputPath, 'utf8').split(/\r?\n/);

const removed = [];
const preserved = [];
const errors = [];
let lastReason = 'unknown';
let nginx = 'NOT_REPORTED';
let final = null;

for (const line of lines) {
  let match;
  if ((match = line.match(/^PREVIEW_(?:IMAGE_RESULT|ORPHAN_CLEANUP)=PRESERVED reason=([A-Za-z0-9_.-]+)(?: field=([A-Za-z0-9_.-]+))?/))) {
    lastReason = match[2] ? `${match[1]} field=${match[2]}` : match[1];
  } else if ((match = line.match(/^PREVIEW_ORPHAN_CLEANUP=PASS project=(\S+)$/)) && PROJECT.test(match[1])) {
    removed.push(match[1]);
  } else if ((match = line.match(/^PREVIEW_PROJECT_CLEANUP=PRESERVED project=(\S+)$/)) && PROJECT.test(match[1])) {
    preserved.push({ project: match[1], reason: lastReason });
    lastReason = 'unknown';
  } else if ((match = line.match(/^PREVIEW_PROJECT_CLEANUP=ERROR project=(\S+) reason=(\S+)$/)) && PROJECT.test(match[1]) && SAFE.test(match[2])) {
    errors.push({ project: match[1], reason: match[2] });
  } else if ((match = line.match(/^PREVIEW_NGINX_ROUTE=(REMOVED|PRESERVED)\b/))) {
    nginx = match[1];
  } else if ((match = line.match(/^PREVIEW_CLEANUP_RESULT=(PASS|PRESERVED|FAIL)\b/))) {
    final = match[1];
  }
}

let result = final ?? 'ERROR';
let detail = '';
if (sshExit !== 0) {
  result = 'ERROR';
  detail = `ssh/remote exit ${sshExit}`;
} else if (!final) {
  detail = 'final marker PREVIEW_CLEANUP_RESULT missing';
} else if (final === 'PASS' && preserved.length > 0) {
  result = 'ERROR';
  detail = 'PASS reported with preserved projects';
}

const summary = [
  '## Preview Cleanup',
  '',
  `- Resultado: \`${result}\`${detail ? ` (${detail})` : ''}`,
  `- Projetos removidos: ${removed.length}${removed.length ? ` (${removed.map((p) => `\`${p}\``).join(', ')})` : ''}`,
  `- Projetos preservados: ${preserved.length}`,
  ...preserved.map(({ project, reason }) => `  - \`${project}\`: \`${reason}\``),
  ...(errors.length ? [`- Erros inesperados: ${errors.length}`, ...errors.map(({ project, reason }) => `  - \`${project}\`: \`${reason}\``)] : []),
  `- Rota do nginx: \`${nginx}\``,
  '',
];
appendFileSync(summaryPath, `${summary.join('\n')}\n`);

if (preserved.length > 0) {
  const list = preserved.map(({ project, reason }) => `${project} (${reason})`).join('; ');
  console.log(`::warning title=Preview Cleanup::${preserved.length} projeto(s) preservado(s): ${list}. Veja o resumo do job.`);
}
if (result === 'FAIL' || result === 'ERROR') {
  console.log(`::error title=Preview Cleanup::Resultado ${result}${detail ? `: ${detail}` : ''}. Veja o log e o resumo do job.`);
  process.exit(1);
}
console.log(`PREVIEW_CLEANUP_SUMMARY result=${result} removed=${removed.length} preserved=${preserved.length}`);
