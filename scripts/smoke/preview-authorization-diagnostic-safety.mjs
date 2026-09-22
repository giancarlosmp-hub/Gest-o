import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/preview-authorization-diagnostic.yml', 'utf8');
const runner = readFileSync('scripts/preview-authorization-diagnostic-remote.sh', 'utf8');
assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
assert.doesNotMatch(workflow, /\b(push|pull_request|schedule):/);
assert.match(workflow, /contents: read[\s\S]*actions: read[\s\S]*pull-requests: read/);
assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /group: preview-pr-881[\s\S]*cancel-in-progress: false/);
for (const exact of ['881', '35668904948', '1', 'gesto-pr-881-35668904948-1', 'ef1bd1069cb23e1e887aef7154d94fae8879797e', '/var/www/preview-provenance/gesto-pr-881-35668904948-1.json']) assert.ok(workflow.includes(exact));
assert.match(runner, /node "\$trusted_script" authorize "\$DIAGNOSTIC_MANIFEST"/);
assert.doesNotMatch(workflow + runner, /preview-cleanup-remote|docker\s+(?:image|volume|network|container)\s+rm|docker\s+compose\s+down|\bprune\b|nginx|systemctl/);
assert.doesNotMatch(workflow, /PERSONAL|PAT|echo.*GITHUB_TOKEN/);
assert.match(runner, /trap cleanup_temporary_files EXIT/);
assert.match(runner, /rm -rf -- "\$DIAGNOSTIC_TEMP_DIR"/);

const runCase = ({ nodeBody, manifest = true }) => {
  const base = mkdtempSync(join(tmpdir(), 'diagnostic-test-'));
  const temp = join('/tmp', `gesto-preview-authorization-diagnostic-${process.pid}-${Date.now()}`);
  const bin = join(base, 'bin'); mkdirSync(bin); mkdirSync(join(temp, 'scripts'), { recursive: true });
  writeFileSync(join(temp, 'scripts/preview-image-lifecycle.mjs'), '// trusted fixture\n');
  const fakeNode = join(bin, 'node'); writeFileSync(fakeNode, `#!/usr/bin/env bash\n${nodeBody}\n`); chmodSync(fakeNode, 0o755);
  const manifestPath = join(base, 'manifest.json'); if (manifest) writeFileSync(manifestPath, '{}');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIAGNOSTIC_TEMP_DIR: temp, DIAGNOSTIC_MANIFEST: manifestPath, DIAGNOSTIC_CODE_SHA: 'a'.repeat(40), PREVIEW_OWNER_REPOSITORY: 'giancarlosmp-hub/Gest-o', PREVIEW_OWNER_PR: '881', PREVIEW_OWNER_RUN_ID: '35668904948', PREVIEW_OWNER_RUN_ATTEMPT: '1', PREVIEW_OWNER_WORKFLOW: 'Preview-Deploy', EXPECTED_PREVIEW_SHA: 'ef1bd1069cb23e1e887aef7154d94fae8879797e', COMPOSE_PROJECT_NAME: 'gesto-pr-881-35668904948-1', GITHUB_TOKEN: 'masked-fixture' };
  return spawnSync('bash', ['scripts/preview-authorization-diagnostic-remote.sh'], { encoding: 'utf8', env });
};

let result = runCase({ nodeBody: "echo 'PREVIEW_IMAGE_AUTHORIZATION=PASS project=x images=2'; exit 0" });
assert.equal(result.status, 0); assert.match(result.stdout, /RESULT=PASS reason=authorization_approved/);
result = runCase({ nodeBody: "echo 'PREVIEW_IMAGE_RESULT=PRESERVED reason=producer_run_not_successful' >&2; exit 1" });
assert.equal(result.status, 1); assert.match(result.stdout, /RESULT=PRESERVED reason=producer_run_not_successful/);
result = runCase({ nodeBody: 'exit 0', manifest: false });
assert.equal(result.status, 1); assert.match(result.stdout, /RESULT=PRESERVED reason=manifest_absent/);
result = runCase({ nodeBody: "echo 'PREVIEW_IMAGE_RESULT=PRESERVED reason=github_query_failed_503' >&2; exit 1" });
assert.equal(result.status, 1); assert.match(result.stdout, /RESULT=ERROR reason=github_query_failed_503/);
console.log('PREVIEW_AUTHORIZATION_DIAGNOSTIC_SAFETY=PASS mutations=0');
