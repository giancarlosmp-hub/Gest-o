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
assert.doesNotMatch(workflow, /capture_stdout|steps\.authorize\.outputs\.stdout|appleboy\/ssh-action/);
assert.match(workflow, /uses: appleboy\/scp-action@v0\.1\.7/);
const scpBlock = workflow.match(/uses: appleboy\/scp-action@v0\.1\.7[\s\S]*?\n\s+- name:/)?.[0] ?? '';
for (const input of [...scpBlock.matchAll(/^\s{10}([a-z_]+):/gm)].map((match) => match[1])) {
  assert.ok(['host', 'username', 'key', 'port', 'source', 'target'].includes(input), `unsupported scp-action input: ${input}`);
}
assert.match(workflow, /node scripts\/preview-authorization-diagnostic-result\.mjs "\$remote_output" "\$ssh_rc" "\$GITHUB_OUTPUT"/);
assert.match(workflow, /continue-on-error: true[\s\S]*id: authorize[\s\S]*continue-on-error: true/);
for (const exact of ['881', '35668904948', '1', 'gesto-pr-881-35668904948-1', 'ef1bd1069cb23e1e887aef7154d94fae8879797e', '/var/www/preview-provenance/gesto-pr-881-35668904948-1.json']) assert.ok(workflow.includes(exact));
assert.match(runner, /node "\$trusted_script" authorize "\$DIAGNOSTIC_MANIFEST"/);
assert.doesNotMatch(workflow + runner, /preview-cleanup-remote|docker\s+(?:image|volume|network|container)\s+rm|docker\s+compose\s+down|\bprune\b|nginx|systemctl/);
assert.doesNotMatch(workflow, /PERSONAL|PAT|echo.*GITHUB_TOKEN/);
assert.doesNotMatch(workflow, /cat "\$request_file"|cat.*VPS_KEY/);
assert.doesNotMatch(workflow, /cat "\$remote_output"/);
assert.doesNotMatch(runner, /cat "\$output_file"/);
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
assert.equal(result.status, 1); assert.match(result.stdout, /RESULT=PRESERVED reason=manifest_absent/); assert.match(result.stdout, /EXIT_CODE=NOT_EXECUTED/);
result = runCase({ nodeBody: "echo 'PREVIEW_IMAGE_RESULT=PRESERVED reason=github_query_failed_503' >&2; exit 1" });
assert.equal(result.status, 1); assert.match(result.stdout, /RESULT=ERROR reason=github_query_failed_503/);

const parseCase = (remoteOutput, sshExit = 0) => {
  const base = mkdtempSync(join(tmpdir(), 'diagnostic-result-test-'));
  const input = join(base, 'remote.txt'); const output = join(base, 'github-output.txt');
  writeFileSync(input, remoteOutput); writeFileSync(output, '');
  const parsed = spawnSync('node', ['scripts/preview-authorization-diagnostic-result.mjs', input, String(sshExit), output], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=', 2)));
};
const complete = (resultLine, exitCode, temporary = 'REMOVED') => `PREVIEW_AUTH_DIAGNOSTIC_REMOTE_STARTED=YES\n${resultLine}\nPREVIEW_AUTH_DIAGNOSTIC_EXIT_CODE=${exitCode}\nPREVIEW_AUTH_DIAGNOSTIC_CLEANUP_EXECUTED=NO\nPREVIEW_AUTH_DIAGNOSTIC_TEMP_CLEANUP=${temporary}\n`;

let parsed = parseCase(complete('PREVIEW_AUTH_DIAGNOSTIC_RESULT=PASS reason=authorization_approved', '0'));
assert.deepEqual({ result: parsed.result, authorize: parsed.authorize_exit_code }, { result: 'PASS', authorize: '0' });
parsed = parseCase(complete('PREVIEW_AUTH_DIAGNOSTIC_RESULT=PRESERVED reason=authenticated_run_identity_diverged field=pull_request_head_sha', '1'), 1);
assert.deepEqual({ result: parsed.result, reason: parsed.reason, field: parsed.field, authorize: parsed.authorize_exit_code }, { result: 'PRESERVED', reason: 'authenticated_run_identity_diverged', field: 'pull_request_head_sha', authorize: '1' });
parsed = parseCase(complete('PREVIEW_AUTH_DIAGNOSTIC_RESULT=ERROR reason=github_query_failed_503', '1'), 1);
assert.equal(parsed.result, 'ERROR'); assert.equal(parsed.reason, 'github_query_failed_503');
parsed = parseCase('', 255);
assert.deepEqual({ result: parsed.result, reason: parsed.reason, authorize: parsed.authorize_exit_code }, { result: 'ERROR', reason: 'ssh_failed_before_remote_execution', authorize: 'NOT_EXECUTED' });
parsed = parseCase('PREVIEW_AUTH_DIAGNOSTIC_REMOTE_STARTED=YES\nnot-a-result\n', 1);
assert.equal(parsed.result, 'ERROR'); assert.equal(parsed.reason, 'missing_or_invalid_remote_result'); assert.equal(parsed.authorize_exit_code, 'UNKNOWN');
parsed = parseCase(complete('PREVIEW_AUTH_DIAGNOSTIC_RESULT=PRESERVED reason=authenticated_run_identity_diverged field=pull_request_head_sha', '1', 'FAILED'), 255);
assert.equal(parsed.result, 'PRESERVED'); assert.equal(parsed.temporary_cleanup, 'FAILED');
console.log('PREVIEW_AUTHORIZATION_DIAGNOSTIC_SAFETY=PASS mutations=0');
