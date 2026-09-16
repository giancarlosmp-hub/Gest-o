import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'gesto-docker-safety-'));
const docker = join(dir, 'docker');
const cid = 'a'.repeat(64), extraCid = 'c'.repeat(64), nid = 'b'.repeat(64);
writeFileSync(docker, `#!/usr/bin/env bash
set -eu
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  'ps -aq') printf '%s\n' "$CID"; [[ "\${EXTRA_RESOURCE:-no}" == yes ]] && printf '%s\n' "$EXTRA_CID" || :;;
  'network ls') printf '%s\n' "$NID";;
  'network inspect')
    [[ "\${ALTER_NETWORK:-no}" == yes ]] && printf 'd%.0s' {1..64} || printf '%s' "$NID"
    printf '\tpreview_default\tpreview-project\n';;
  'container inspect')
    if [[ "$3" == sha256:* || "$3" == "$CID" ]]; then
      printf '[{"Id":"%s","Name":"/pr-526-api-1","Image":"sha256:%s","State":{"Status":"exited"},"Config":{"Labels":{"com.docker.compose.project":"preview-project"}}}]\n' "$CID" "$CID"
      exit 0
    fi
    format="$4"; id="$5"
    case "$format" in
      *'.Mounts'*) [[ "\${VOLUME:-none}" != none ]] && echo "$VOLUME" || :;;
      *'NetworkSettings.Networks'*) echo preview_default;;
      *)
        name=/pr-526-api-1; [[ "\${PRODUCTION:-no}" == yes ]] && name=/gest-o-production-api-1
        [[ "\${ALTER_ID:-no}" == yes ]] && id=$(printf 'd%.0s' {1..64})
        printf '%s\t%s\t%s\t%s\n' "$id" "$name" "\${PROJECT:-preview-project}" exited;;
    esac;;
  'image ls') printf '%s\n' "sha256:$CID";;
  'image inspect') printf '[{"Id":"sha256:%s","RepoTags":["same:a","same:b"],"RepoDigests":[],"Created":"2026-01-01","Size":100}]\n' "$CID";;
  'container rm'|'network rm'|'volume rm'|'image rm') exit 99;;
  *) exit 2;;
esac
`);
chmodSync(docker, 0o755);
const log = join(dir, 'docker.log');
const env = extra => ({ ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log, CID: cid, EXTRA_CID: extraCid, NID: nid, ...extra });
const manifest = (rows, name = 'manifest.tsv') => {
  const path = join(dir, name);
  writeFileSync(path, `project\tpr\tcontainer_ids\tnetwork_ids\n${rows}`);
  return path;
};
const one = manifest(`preview-project\t526\t${cid}\t${nid}\n`);
const invoke = (mode, file = one, extra = {}) => spawnSync('bash', ['scripts/legacy-preview-cleanup.sh', mode, file], { cwd: root, encoding: 'utf8', env: env(extra) });

let result = invoke('inventory');
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.match(result.stdout, /PR_STATE=NOT_PROVEN/);
assert.doesNotMatch(readFileSync(log, 'utf8'), /\b(rm|down|prune)\b/);

result = invoke('apply');
assert.notEqual(result.status, 0);
assert.match(result.stdout, /APPLY_DISABLED/);
result = invoke('apply', one, { LEGACY_PREVIEW_APPLY_CONFIRMATION: 'REMOVE_REVIEWED_LEGACY_PREVIEWS' });
assert.notEqual(result.status, 0, 'confirmation must not enable apply');
assert.match(result.stdout, /APPLY_DISABLED/);
// A stopped legacy container claimed as rollback/recovery/unknown cannot be
// deleted because there is no apply path at all.
assert.doesNotMatch(readFileSync(log, 'utf8'), /container rm/);
result = invoke('apply', manifest(`preview-project\t526\t${cid}\t${nid}\nother\t527\t${extraCid}\t${nid}\n`, 'two.tsv'));
assert.match(result.stdout, /APPLY_SINGLE_PROJECT_REQUIRED/);
assert.doesNotMatch(readFileSync(log, 'utf8'), /\b(rm|down|prune)\b/);

for (const [extra, marker] of [
  [{ PRODUCTION: 'yes' }, 'PRODUCTION_CONTAINER_PROTECTED'],
  [{ VOLUME: 'gest-o_pgdata' }, 'PROTECTED_VOLUME'],
  [{ VOLUME: 'gest-o_pgdata_clean_v2_20260717' }, 'PROTECTED_VOLUME'],
  [{ EXTRA_RESOURCE: 'yes' }, 'PROJECT_SET_DIVERGED'],
  [{ ALTER_ID: 'yes' }, 'IDENTITY_DIVERGED'],
  [{ ALTER_NETWORK: 'yes' }, 'IDENTITY_DIVERGED'],
  [{ PROJECT: 'different-project' }, 'IDENTITY_DIVERGED']
]) {
  result = invoke('inventory', one, extra);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp(marker));
}
result = invoke('inventory', manifest(`preview-project\t526\t${cid}\t${nid},${nid}\n`, 'duplicate.tsv'));
assert.match(result.stdout, /DUPLICATE_RESOURCE/);
result = invoke('inventory', manifest(`preview-project\t526\t${extraCid}\t${nid}\n`, 'partial.tsv'));
assert.match(result.stdout, /PROJECT_SET_DIVERGED/);

const imageLog = join(dir, 'image.log');
result = spawnSync('node', ['scripts/diagnose-docker-images.mjs'], { cwd: root, encoding: 'utf8', env: { ...env({ DOCKER_LOG: imageLog }), DEPLOY_EVIDENCE_ROOT: join(dir, 'absent') } });
assert.equal(result.status, 0, result.stderr);
const inventory = JSON.parse(result.stdout);
assert.equal(inventory.images.length, 1);
assert.deepEqual(inventory.images[0].tags, ['same:a', 'same:b']);
assert.equal(inventory.images[0].containers[0].state, 'exited', 'stopped container must remain a reference');
assert.equal(inventory.images[0].classification, 'vínculo desconhecido, preservar');

const cleanupSource = readFileSync(join(root, 'scripts/legacy-preview-cleanup.sh'), 'utf8');
assert.doesNotMatch(cleanupSource, /docker\s+(container|network|volume|image)\s+rm|compose\s+down|prune/);
console.log('DOCKER_CLEANUP_SAFETY=PASS apply=disabled');
