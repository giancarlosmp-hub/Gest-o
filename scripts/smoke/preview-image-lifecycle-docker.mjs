import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { waitForReadyFile } from './lib/wait-for-ready-file.mjs';
import { runBounded, terminateAndWait } from './lib/managed-process.mjs';

const root = process.cwd();
if (spawnSync('docker', ['compose', 'version']).status !== 0) {
  console.log('PREVIEW_IMAGE_DOCKER=SKIP reason=docker_compose_unavailable');
  process.exit(77);
}
const canCreateContainers = (() => {
  const probeName = `gesto-probe-${process.pid}`;
  const res = spawnSync('docker', ['create', '--name', probeName, 'scratch'], { stdio: 'ignore' });
  if (res.status === 0) {
    spawnSync('docker', ['rm', '-f', probeName], { stdio: 'ignore' });
    return true;
  }
  return false;
})();
const dir = mkdtempSync(join(tmpdir(), 'gesto-preview-images-'));
const modeFile = join(dir, 'mode');
const portFile = join(dir, 'port');
writeFileSync(modeFile, 'ok');
const server = spawn(process.execPath, [join(root, 'scripts/smoke/preview-github-api-mock.mjs'), modeFile, portFile], { stdio: ['ignore', 'ignore', 'pipe'] });
let serverStderr = '';
server.stderr.on('data', chunk => { serverStderr += chunk; });
let disposePromise;
const dispose = () => disposePromise ??= (async () => {
  const errors = [];
  try { await terminateAndWait(server, { timeoutMs: 3000 }); } catch (error) { errors.push(error); }
  const bounded = (command, args) => { try { runBounded(command, args, { timeoutMs: 10000, stdio: 'ignore' }); } catch (error) { errors.push(error); } };
  // Every identity below is unique to this synthetic process. No broad prune.
  const stoppedName = `gesto-synthetic-stopped-${process.pid}`;
  if (spawnSync('docker', ['container', 'inspect', stoppedName], { stdio: 'ignore', timeout: 3000 }).status === 0) bounded('docker', ['rm', '-f', stoppedName]);
  if (existsSync(join(dir, 'docker-compose.yml')) && existsSync(join(dir, 'docker-compose.preview.yml'))) {
    for (const project of ['gesto-pr-42-100-1', 'gesto-pr-42-100-2']) bounded('docker', ['compose', '-p', project, '-f', join(dir, 'docker-compose.yml'), '-f', join(dir, 'docker-compose.preview.yml'), 'down', '-v', '--remove-orphans']);
  }
  for (const service of ['api', 'web']) {
    const tags = ['one', 'two', 'rerun', 'failure'].map(tag => `gesto-synthetic-${service}:${tag}`).filter(tag => spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore', timeout: 3000 }).status === 0);
    if (tags.length) bounded('docker', ['image', 'rm', ...tags]);
  }
  rmSync(dir, { recursive: true, force: true });
  return errors;
})();
let interrupted = '';
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; process.exitCode = 128; void dispose(); });
let originalError;
try {
const port = await waitForReadyFile({ child: server, path: portFile, timeoutMs: 5000, stderr: () => serverStderr });
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: options.cwd || dir, encoding: 'utf8', env: { ...process.env, ...options.env } });
const docker = (...args) => { const result = run('docker', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const identity = { PREVIEW_OWNER_REPOSITORY: 'owner/repo', PREVIEW_OWNER_PR: '42', PREVIEW_OWNER_RUN_ID: '100', PREVIEW_OWNER_RUN_ATTEMPT: '1', PREVIEW_OWNER_WORKFLOW: 'Preview-Deploy', EXPECTED_PREVIEW_SHA: 'b'.repeat(40), COMPOSE_PROJECT_NAME: 'gesto-pr-42-100-1', GITHUB_TOKEN: 'synthetic', GITHUB_API_URL: `http://127.0.0.1:${port}`, PROTECTED_IMAGE_EVIDENCE_ROOTS: join(dir, 'no-evidence') };
const labels = (service, attempt = '1', project = identity.COMPOSE_PROJECT_NAME) => Object.entries({ repository: 'owner/repo', pr: '42', 'run-id': '100', 'run-attempt': attempt, workflow: 'Preview-Deploy', commit: 'b'.repeat(40), service, project }).map(([key, value]) => `LABEL com.gesto.preview.${key}="${value}"`).join('\n');
// Build from stdin explicitly so the fixture has no network dependency.
for (const service of ['api', 'web']) {
  const dockerfile = `FROM scratch\n${labels(service)}\nCMD ["/synthetic"]\n`;
  const built = spawnSync('docker', ['build', '-q', '-t', `gesto-synthetic-${service}:one`, '-t', `gesto-synthetic-${service}:two`, '-'], { input: dockerfile, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
}
const composeFor = (suffix, attempt = '1', project = identity.COMPOSE_PROJECT_NAME) => `services:\n${['api','web'].map(service => `  ${service}:\n    image: gesto-synthetic-${service}:${suffix}\n    labels:\n${Object.entries({ repository:'owner/repo', pr:'42', 'run-id':'100', 'run-attempt':attempt, workflow:'Preview-Deploy', commit:'b'.repeat(40), project }).map(([key,value]) => `      com.gesto.preview.${key}: "${value}"`).join('\n')}`).join('\n')}\n`;
writeFileSync(join(dir, 'docker-compose.yml'), composeFor('one'));
writeFileSync(join(dir, 'docker-compose.preview.yml'), 'services: {}\n');
const manifest = join(dir, 'manifest.json');
let result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'record', manifest], { env: identity });
assert.equal(result.status, 0, result.stderr);
assert.equal((result.stdout.match(/PREVIEW_IMAGE_REFERENCE service=(api|web) candidates=1 kind=(full_id|abbreviated_id|tag_or_reference) length=[0-9]+/g) || []).length, 2, 'both Compose references are resolved through Docker inspect');
const recorded = JSON.parse(readFileSync(manifest));
assert.equal(recorded.images.length, 2);
assert.ok(recorded.images.every(image => image.tags.length === 2), 'multiple tags are grouped under each IMAGE ID');
// The authenticated run revision intentionally differs from the checked-out PR
// head. The association's head SHA proves the build commit explicitly.
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'authorize', manifest], { env: identity });
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.match(result.stdout, /PREVIEW_IMAGE_AUTHORIZATION=PASS/);

// A legitimate GitHub re-run keeps run_id=100, records attempt=2 everywhere,
// and is authenticated through its immutable attempt endpoint.
const rerunIdentity = { ...identity, PREVIEW_OWNER_RUN_ATTEMPT: '2', COMPOSE_PROJECT_NAME: 'gesto-pr-42-100-2' };
for (const service of ['api', 'web']) {
  const dockerfile = `FROM scratch\n${labels(service, '2', rerunIdentity.COMPOSE_PROJECT_NAME)}\nCMD ["/synthetic"]\n`;
  const built = spawnSync('docker', ['build', '-q', '-t', `gesto-synthetic-${service}:rerun`, '-'], { input: dockerfile, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
}
writeFileSync(join(dir, 'docker-compose.yml'), composeFor('rerun', '2', rerunIdentity.COMPOSE_PROJECT_NAME));
const rerunManifest = join(dir, 'rerun.json');
let rerun = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'record', rerunManifest], { env: rerunIdentity });
assert.equal(rerun.status, 0, rerun.stderr);
rerun = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'authorize', rerunManifest], { env: rerunIdentity });
assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
docker('compose', '-p', rerunIdentity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'down', '-v');
rerun = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', rerunManifest], { env: rerunIdentity });
assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
writeFileSync(join(dir, 'docker-compose.yml'), composeFor('one'));
for (const [mode, field] of [['attempt','run_attempt'], ['head','run_pull_request_head_sha'], ['path','workflow_path']]) {
  writeFileSync(modeFile, mode);
  const divergent = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'authorize', manifest], { env: identity });
  assert.notEqual(divergent.status, 0, mode);
  assert.match(divergent.stderr, new RegExp(`authenticated_run_identity_diverged field=${field}`));
  if (mode === 'attempt') assert.match(divergent.stderr, /pr=42 run_id=100 expected=1 observed=2/);
}
writeFileSync(modeFile, 'ok');
docker('compose', '-p', identity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'down', '-v');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', manifest], { env: identity });
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.ok(recorded.images.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status !== 0), 'eligible images removed');
// Workflow-level idempotence: after manifest and resources are gone, there is no candidate to mutate.
assert.equal(spawnSync('test', ['-e', manifest]).status, 1);

// GitHub failure preserves a fresh synthetic pair before any deletion.
for (const service of ['api', 'web']) {
  const dockerfile = `FROM scratch\n${labels(service)}\nCMD ["/synthetic"]\n`;
  const built = spawnSync('docker', ['build', '-q', '-t', `gesto-synthetic-${service}:failure`, '-'], { input: dockerfile, encoding: 'utf8' }); assert.equal(built.status, 0, built.stderr);
}
writeFileSync(join(dir, 'docker-compose.yml'), composeFor('failure'));
const failureManifest = join(dir, 'failure.json');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'record', failureManifest], { env: identity }); assert.equal(result.status, 0, result.stderr);
docker('compose', '-p', identity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'down');
writeFileSync(modeFile, 'error');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.notEqual(result.status, 0); assert.match(result.stderr, /github_query_failed_503/);
const failureImages = JSON.parse(readFileSync(failureManifest)).images;
assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'GitHub failure preserves all images');
writeFileSync(modeFile, 'open');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.notEqual(result.status, 0); assert.match(result.stderr, /pr_not_closed/);
assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'reopened PR preserves all images');
writeFileSync(modeFile, 'cancelled');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.notEqual(result.status, 0); assert.match(result.stderr, /producer_run_not_successful/);
assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'cancelled producer preserves all images');
writeFileSync(modeFile, 'empty_prs_divergent_branch');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.notEqual(result.status, 0); assert.match(result.stderr, /run_pr_correlation_missing/);
assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'empty pull_requests with divergent branch preserves all images');
writeFileSync(modeFile, 'empty_prs');
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'authorize', failureManifest], { env: identity });
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.match(result.stdout, /PREVIEW_IMAGE_AUTHORIZATION=PASS/);
writeFileSync(modeFile, 'ok');
if (canCreateContainers) {
  const protectedContainer = docker('create', '--name', `gesto-synthetic-stopped-${process.pid}`, failureImages.find(image => image.labels.service === 'api').image_id);
  result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /container_reference_present/);
  assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'stopped container preserves the entire pair');
  docker('rm', protectedContainer);
}
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.equal(result.status, 0, result.stderr + result.stdout);
} catch (error) {
  originalError = error;
}
const teardownErrors = await dispose();
if (originalError) {
  if (teardownErrors.length) originalError.message += `; teardown_errors=${teardownErrors.map(error => error.message).join('|')}`;
  throw originalError;
}
if (interrupted) throw new Error(`harness_interrupted signal=${interrupted}`);
if (teardownErrors.length) throw new AggregateError(teardownErrors, 'preview harness teardown failed');
console.log('PREVIEW_IMAGE_DOCKER=PASS lifecycle=complete distinct_run_and_build_sha=pass rerun_same_id_incremented_attempt=pass identity_divergence=preserved idempotence=pass github_failure=preserved reopened=preserved cancelled=preserved stopped_container=preserved teardown=pass helper_exit=awaited');
