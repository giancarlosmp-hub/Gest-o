import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
if (spawnSync('docker', ['compose', 'version']).status !== 0) {
  console.log('PREVIEW_IMAGE_DOCKER=SKIP reason=docker_compose_unavailable');
  process.exit(77);
}
const dir = mkdtempSync(join(tmpdir(), 'gesto-preview-images-'));
const modeFile = join(dir, 'mode');
const portFile = join(dir, 'port');
writeFileSync(modeFile, 'ok');
writeFileSync(join(dir, 'server.mjs'), `
import http from 'node:http'; import {readFileSync,writeFileSync} from 'node:fs';
const [modeFile,portFile]=process.argv.slice(2);
const server=http.createServer((req,res)=>{const mode=readFileSync(modeFile,'utf8').trim();if(mode==='error'){res.writeHead(503);return res.end('{}')}
let body;if(req.url.includes('/pulls/'))body={state:mode==='open'?'open':'closed',head:{sha:'${'b'.repeat(40)}',ref:'feature'}};else if(req.url.includes('/actions/runs/100/attempts/')){const requested=Number(req.url.match(/attempts\/(\d+)/)?.[1]);body={status:'completed',conclusion:mode==='cancelled'?'cancelled':'success',run_attempt:mode==='attempt' ? requested+1:requested,head_sha:'${'a'.repeat(40)}',head_branch:'feature',workflow_id:7,name:'Preview Deploy',path:mode==='path'?'.github/workflows/other.yml':'.github/workflows/preview.yml',event:'pull_request',pull_requests:[{number:42,head:{sha:mode==='head'?'${'c'.repeat(40)}':'${'b'.repeat(40)}'}}]};}else if(req.url.includes('/actions/workflows/7'))body={path:'.github/workflows/preview.yml'};else body=mode==='incomplete'?{}:{workflow_runs:[]};res.setHeader('content-type','application/json');res.end(JSON.stringify(body))});
server.listen(0,'127.0.0.1',()=>writeFileSync(portFile,String(server.address().port)));`);
const server = spawn(process.execPath, [join(dir, 'server.mjs'), modeFile, portFile], { stdio: 'ignore' });
for (let i = 0; i < 100; i++) { try { if (readFileSync(portFile, 'utf8')) break; } catch {} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
const port = readFileSync(portFile, 'utf8');
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
docker('compose', '-p', identity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'create');
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
docker('compose', '-p', rerunIdentity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'create');
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
docker('compose', '-p', identity.COMPOSE_PROJECT_NAME, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'create');
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
writeFileSync(modeFile, 'ok');
const protectedContainer = docker('create', '--name', `gesto-synthetic-stopped-${process.pid}`, failureImages.find(image => image.labels.service === 'api').image_id);
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.notEqual(result.status, 0); assert.match(result.stderr, /container_reference_present/);
assert.ok(failureImages.every(image => spawnSync('docker', ['image', 'inspect', image.image_id]).status === 0), 'stopped container preserves the entire pair');
docker('rm', protectedContainer);
result = run(process.execPath, [join(root, 'scripts/preview-image-lifecycle.mjs'), 'cleanup', failureManifest], { env: identity });
assert.equal(result.status, 0, result.stderr + result.stdout);
server.kill();
console.log('PREVIEW_IMAGE_DOCKER=PASS lifecycle=complete distinct_run_and_build_sha=pass rerun_same_id_incremented_attempt=pass identity_divergence=preserved idempotence=pass github_failure=preserved reopened=preserved cancelled=preserved stopped_container=preserved');
