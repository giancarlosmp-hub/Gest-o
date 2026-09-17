import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const lifecycle = readFileSync('scripts/preview-image-lifecycle.mjs', 'utf8');
const planner = readFileSync('scripts/plan-legacy-preview-images.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/preview-cleanup.yml', 'utf8');
const composeCiWorkflow = readFileSync('.github/workflows/docker-compose-ci.yml', 'utf8');
const cleanupRunner = readFileSync('scripts/preview-cleanup-remote.sh', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/preview.yml', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const apiDockerfile = readFileSync('apps/api/Dockerfile', 'utf8');
const webDockerfile = readFileSync('apps/web/Dockerfile', 'utf8');

for (const marker of ['repository', 'pr', 'run-id', 'run-attempt', 'workflow', 'commit', 'service', 'project']) {
  assert.match(lifecycle, new RegExp(`['\"]?${marker.replace('-', '\\-')}`));
  assert.match(apiDockerfile, new RegExp(`com\\.gesto\\.preview\\.${marker}`));
  assert.match(webDockerfile, new RegExp(`com\\.gesto\\.preview\\.${marker}`));
}
for (const gate of ['pr_not_closed', 'producer_run_not_completed', 'producer_run_not_successful', 'github_auth_missing', 'github_query_failed', 'identity_\\$\\{key\\}_not_proven', 'authenticated_run_identity_diverged field=', 'run_pull_request_head_sha', 'pull_request_head_sha', 'workflow_path', 'workflow_id_path', 'head_ref', 'references_diverged_since_manifest', 'protected_tag_present', 'container_reference_present', 'container_reference_created_before_delete', 'production_container_reference', 'rollback_or_recovery_evidence_present', 'concurrent_run_']) assert.match(lifecycle, new RegExp(gate));
assert.match(lifecycle, /docker\('image', 'rm', \.\.\.removalReferences\)/);
assert.doesNotMatch(lifecycle, /image[^\n]*rm[^\n]*(?:--force|-f\b)|\bprune\b/);
assert.doesNotMatch(workflow, /docker rm -f|image prune|system prune|volume prune/);
assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress: false/);
assert.match(deployWorkflow, /concurrency:\s*\n\s*group: preview-pr-\$\{\{ github\.event\.pull_request\.number \}\}\s*\n\s*cancel-in-progress: false/);
const capacityAt = deployWorkflow.indexOf('bash scripts/preview-network-capacity-preflight.sh');
const buildAt = deployWorkflow.indexOf('build api web');
const firstRecordAt = deployWorkflow.indexOf('node scripts/preview-image-lifecycle.mjs record');
const runtimeAt = deployWorkflow.indexOf('up -d --no-build');
assert.ok(capacityAt >= 0 && capacityAt < buildAt && buildAt < firstRecordAt && firstRecordAt < runtimeAt, 'capacity must precede build and provenance must precede runtime creation');
assert.doesNotMatch(deployWorkflow, /up -d --build/);
assert.match(cleanupRunner, /preview-provenance[\s\S]*PREVIEW_RESOURCE_CLEANUP=ALREADY_ABSENT/, 'manifest must discover images after runtime resources disappear');
assert.match(cleanupRunner, /trusted_compose_files_missing/);
assert.match(cleanupRunner, /node "\$CLEANUP_SCRIPT" authorize "\$manifest_path"[\s\S]*docker compose[\s\S]*node "\$CLEANUP_SCRIPT" cleanup/, 'authenticated authorization must precede teardown and be repeated before image deletion');
assert.match(cleanupRunner, /actions\/runs\/\$\{owner_run\}\/attempts\/\$\{owner_attempt\}/, 'runner must authenticate the immutable producer attempt');
assert.match(lifecycle, /actions\/runs\/\$\{expectedBase\['run-id'\]\}\/attempts\/\$\{expectedBase\['run-attempt'\]\}/, 'lifecycle must not resolve a re-run through the latest-attempt endpoint');
assert.match(lifecycle, /field=\$\{field\} pr=\$\{expectedBase\.pr\} run_id=\$\{expectedBase\['run-id'\]\}/);
assert.match(lifecycle, /expected=\$\{expectedBase\['run-attempt'\]\} observed=/);
assert.doesNotMatch(cleanupRunner, /EXPECTED_PREVIEW_SHA="\$producer_sha"/, 'workflow run revision must not replace the built PR head revision');
assert.match(workflow, /bash "\$CLEANUP_RUNNER"/);
assert.match(composeCiWorkflow, /on:\s*\n\s*push:[\s\S]*\n\s*pull_request:/, 'cleanup shell gate must run for the existing push and pull_request triggers');
assert.match(composeCiWorkflow, /for iteration in 1 2; do[\s\S]*npm run test:preview-images:docker[\s\S]*PREVIEW_IMAGE_DOCKER_REPEATED=PASS iterations=2/, 'Docker lifecycle must run twice from disposable state');
const cleanupCiStepStart = composeCiWorkflow.indexOf('- name: Prove preview cleanup workflow shell');
const cleanupCiStepEnd = composeCiWorkflow.indexOf('\n      - name:', cleanupCiStepStart + 1);
assert.ok(cleanupCiStepStart >= 0 && cleanupCiStepEnd > cleanupCiStepStart, 'Docker Compose CI must contain a bounded cleanup shell gate');
const cleanupCiStep = composeCiWorkflow.slice(cleanupCiStepStart, cleanupCiStepEnd);
assert.match(cleanupCiStep, /run: npm run test:docker-cleanup-safety\s*$/, 'CI must invoke the exact cleanup safety command');
assert.doesNotMatch(cleanupCiStep, /continue-on-error|\|\|\s*true|exit\s+77|SKIP|warning/i, 'cleanup shell gate must fail closed');
assert.match(cleanupRunner, /set -euo pipefail/);
assert.doesNotMatch(cleanupRunner, /\|\s*head\b|\|\s*grep\s+-q\b|\|\|\s*true/);
assert.match(compose, /PREVIEW_OWNER_SERVICE_API/);
assert.match(compose, /PREVIEW_OWNER_SERVICE_WEB/);
for (const marker of ['NOT_PROVEN', 'PROTECTED', 'ELIGIBLE_FOR_HUMAN_REVIEW', 'github_rate_limit', 'expires_at', 'approval_hash_sha256', 'INDEPENDENT_PROVENANCE_MISSING', 'CONTAINER_REFERENCE']) assert.match(planner, new RegExp(marker));
assert.doesNotMatch(planner, /execFile|spawn|docker|\b(rm|prune)\b/);

// Semantic planner check: no authentication/network evidence is preserved, not selected.
const dir = mkdtempSync(join(tmpdir(), 'gesto-image-plan-'));
const id = `sha256:${'a'.repeat(64)}`;
const inventory = join(dir, 'inventory.json');
const evidence = join(dir, 'evidence.json');
writeFileSync(inventory, JSON.stringify({ images: [{ image_id: id, tags: ['legacy:a', 'legacy:b'], digests: [], containers: [] }] }));
writeFileSync(evidence, JSON.stringify({ repository: 'owner/repo', images: [{ image_id: id, repository: 'owner/repo', pr: 1, run_id: 2, run_attempt: 1, workflow: 'Preview Deploy', commit: 'b'.repeat(40), service: 'api', project: 'legacy' }] }));
const result = spawnSync('node', ['scripts/plan-legacy-preview-images.mjs', inventory, evidence], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '' } });
assert.equal(result.status, 0, result.stderr);
const output = JSON.parse(result.stdout);
assert.equal(output.images.length, 1, 'multiple tags remain one IMAGE ID');
assert.equal(output.images[0].decision, 'NOT_PROVEN');
assert.match(output.images[0].reasons.join(','), /github_auth_missing/);
assert.equal(output.reclaimable_bytes, 'NOT_MEASURED');

// Compose versions may return a tag or abbreviated ID. The recorder must ask
// Docker for the complete local identity, never pad or otherwise invent it.
const fakeBin = join(dir, 'bin');
await import('node:fs/promises').then(fs => fs.mkdir(fakeBin));
const fakeDocker = join(fakeBin, 'docker');
writeFileSync(fakeDocker, `#!/usr/bin/env node
const args=process.argv.slice(2), mode=process.env.FAKE_DOCKER_MODE||'short';
const service=args[0]==='compose'?args.at(-1):(String(args.at(-1)).startsWith('a')?'api':'web'), hex=service==='api'?'a':'b', id='sha256:'+hex.repeat(64);
const labels={repository:'owner/repo',pr:'42','run-id':'100','run-attempt':'1',workflow:'Preview-Deploy',commit:'${'c'.repeat(40)}',service,project:'gesto-pr-42-100-1'};
if(args[0]==='compose') {
  if(mode==='missing') process.exit(0);
  if(mode==='compose-ambiguous') { console.log(hex.repeat(12)+'\\n'+hex.repeat(13)); process.exit(0); }
  console.log(mode==='invalid'?'not-a-local-image':hex.repeat(12)); process.exit(0);
}
if(args[0]==='image'&&args[1]==='inspect') {
  if(mode==='invalid') process.exit(1);
  const image={Id:id,RepoTags:['synthetic-'+service+':one'],RepoDigests:[],Config:{Labels:Object.fromEntries(Object.entries(labels).map(([k,v])=>['com.gesto.preview.'+k,v]))}};
  console.log(JSON.stringify(mode==='inspect-ambiguous'?[image,image]:[image])); process.exit(0);
}
process.exit(2);
`);
chmodSync(fakeDocker, 0o755);
const recordEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_DOCKER_MODE: 'short', PREVIEW_OWNER_REPOSITORY: 'owner/repo', PREVIEW_OWNER_PR: '42', PREVIEW_OWNER_RUN_ID: '100', PREVIEW_OWNER_RUN_ATTEMPT: '1', PREVIEW_OWNER_WORKFLOW: 'Preview-Deploy', EXPECTED_PREVIEW_SHA: 'c'.repeat(40), COMPOSE_PROJECT_NAME: 'gesto-pr-42-100-1' };
const lifecyclePath = join(process.cwd(), 'scripts/preview-image-lifecycle.mjs');
const resolvedManifest = join(dir, 'resolved.json');
let record = spawnSync(process.execPath, [lifecyclePath, 'record', resolvedManifest], { cwd: dir, encoding: 'utf8', env: recordEnv });
assert.equal(record.status, 0, record.stderr);
assert.match(record.stdout, /kind=abbreviated_id length=12/);
assert.deepEqual(JSON.parse(readFileSync(resolvedManifest)).images.map(image => image.image_id), [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]);
for (const [mode, reason] of [['missing', 'compose_image_reference_api_missing'], ['compose-ambiguous', 'compose_image_reference_api_ambiguous'], ['invalid', 'image_reference_api_unresolvable'], ['inspect-ambiguous', 'image_reference_api_ambiguous']]) {
  record = spawnSync(process.execPath, [lifecyclePath, 'record', join(dir, `${mode}.json`)], { cwd: dir, encoding: 'utf8', env: { ...recordEnv, FAKE_DOCKER_MODE: mode } });
  assert.notEqual(record.status, 0, mode);
  assert.match(record.stderr, new RegExp(reason), mode);
}
console.log('PREVIEW_IMAGE_LIFECYCLE_SAFETY=PASS mutations=0');
