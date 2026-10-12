import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Saídas fictícias do preview-cleanup-remote.sh; nenhum host, IP ou dado real.
const dir = mkdtempSync(join(tmpdir(), 'gesto-cleanup-result-'));
let caseIndex = 0;
const parse = (output, sshExit = 0) => {
  caseIndex += 1;
  const outputPath = join(dir, `output-${caseIndex}.txt`);
  const summaryPath = join(dir, `summary-${caseIndex}.md`);
  writeFileSync(outputPath, output);
  writeFileSync(summaryPath, '');
  const result = spawnSync(process.execPath, ['scripts/preview-cleanup-result.mjs', outputPath, String(sshExit), summaryPath], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, summary: readFileSync(summaryPath, 'utf8') };
};
const annotations = stdout => stdout.split('\n').filter(line => line.startsWith('::'));

// Tudo removido: verde, sem aviso.
let parsed = parse([
  'PREVIEW_IMAGE_AUTHORIZATION=PASS project=gesto-pr-42-100-1 images=2',
  'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-1',
  'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-101-1',
  'PREVIEW_NGINX_ROUTE=REMOVED pr=42',
  'PREVIEW_CLEANUP_RESULT=PASS removed=2 preserved=0',
].join('\n'));
assert.equal(parsed.status, 0, parsed.stderr);
assert.deepEqual(annotations(parsed.stdout), []);
assert.match(parsed.summary, /Resultado: `PASS`/);
assert.match(parsed.summary, /Projetos removidos: 2 \(`gesto-pr-42-100-1`, `gesto-pr-42-101-1`\)/);
assert.match(parsed.summary, /Rota do nginx: `REMOVED`/);

// Preservado: continua verde (exit 0), mas com ::warning:: e o motivo de cada projeto no resumo.
parsed = parse([
  'PREVIEW_IMAGE_RESULT=PRESERVED reason=pr_commit_not_in_pull_request pr=42 run_id=100',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1',
  'PREVIEW_ORPHAN_CLEANUP=PRESERVED reason=trusted_compose_files_missing project=gesto-pr-42-100-2',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-2',
  'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-101-1',
  'PREVIEW_NGINX_ROUTE=PRESERVED reason=active_preview_resources_or_errors_remain pr=42',
  'PREVIEW_CLEANUP_RESULT=PRESERVED removed=1 preserved=2',
].join('\n'));
assert.equal(parsed.status, 0, 'preservação é aviso amarelo, não falha');
const warnings = annotations(parsed.stdout);
assert.equal(warnings.length, 1);
assert.match(warnings[0], /^::warning title=Preview Cleanup::2 projeto\(s\) preservado\(s\): gesto-pr-42-100-1 \(pr_commit_not_in_pull_request\); gesto-pr-42-100-2 \(trusted_compose_files_missing\)\./);
assert.match(parsed.summary, /`gesto-pr-42-100-1`: `pr_commit_not_in_pull_request`/);
assert.match(parsed.summary, /Rota do nginx: `PRESERVED`/);

// Motivo com campo (identidade divergente) aparece completo.
parsed = parse([
  'PREVIEW_IMAGE_RESULT=PRESERVED reason=authenticated_run_identity_diverged field=run_attempt pr=42 run_id=100 expected=1 observed=2',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1',
  'PREVIEW_CLEANUP_RESULT=PRESERVED removed=0 preserved=1',
].join('\n'));
assert.equal(parsed.status, 0);
assert.match(annotations(parsed.stdout)[0], /gesto-pr-42-100-1 \(authenticated_run_identity_diverged field=run_attempt\)/);

// Erro inesperado do runner: vermelho.
parsed = parse([
  'PREVIEW_PROJECT_CLEANUP=ERROR project=gesto-pr-42-100-1 reason=unexpected_authorization_failure',
  'PREVIEW_CLEANUP_RESULT=FAIL reason=unexpected_system_errors count=1',
].join('\n'), 1);
assert.equal(parsed.status, 1);
assert.match(annotations(parsed.stdout).at(-1), /^::error title=Preview Cleanup::/);
assert.match(parsed.summary, /Erros inesperados: 1/);

// Sem marcador final (runner interrompido) ou falha de ssh: vermelho, nunca verde silencioso.
parsed = parse('PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-1\n');
assert.equal(parsed.status, 1);
assert.match(parsed.summary, /final marker PREVIEW_CLEANUP_RESULT missing/);
parsed = parse('PREVIEW_CLEANUP_RESULT=PASS removed=0 preserved=0\n', 255);
assert.equal(parsed.status, 1);
assert.match(parsed.summary, /ssh\/remote exit 255/);
parsed = parse('PREVIEW_ORPHAN_SCOPE=REJECTED_PROJECT\n', 1);
assert.equal(parsed.status, 1, 'projeto fora do escopo do PR faz o runner parar e o job ficar vermelho');

// PASS contraditório com projeto preservado não vira verde.
parsed = parse([
  'PREVIEW_IMAGE_RESULT=PRESERVED reason=pr_commit_list_truncated pr=42 commits=300',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1',
  'PREVIEW_CLEANUP_RESULT=PASS removed=0 preserved=0',
].join('\n'));
assert.equal(parsed.status, 1);

// Saída remota não injeta comandos: só tokens da lista de permitidos chegam às anotações e ao resumo.
parsed = parse([
  '::error::injected-from-remote',
  'PREVIEW_IMAGE_RESULT=PRESERVED reason=x::warning::y',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-42-100-1::error::z',
  'PREVIEW_PROJECT_CLEANUP=PRESERVED project=../../etc',
  'PREVIEW_ORPHAN_CLEANUP=PASS project=gesto-pr-42-100-1',
  'PREVIEW_CLEANUP_RESULT=PASS removed=1 preserved=0',
].join('\n'));
assert.equal(parsed.status, 0);
assert.deepEqual(annotations(parsed.stdout), []);
assert.doesNotMatch(parsed.stdout + parsed.summary, /injected|::error::z|etc/);

console.log('PREVIEW_CLEANUP_RESULT_PARSER=PASS warning_on_preserved=pass red_on_fail=pass missing_marker=fail_closed injection=blocked');
