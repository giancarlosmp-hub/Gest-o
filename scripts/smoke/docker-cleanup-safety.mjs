import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const inventory = readFileSync(join(root, 'scripts/diagnose-docker-images.mjs'), 'utf8');
const cleanup = readFileSync(join(root, 'scripts/legacy-preview-cleanup.sh'), 'utf8');
assert.match(inventory, /docker', \['ps', '-aq', '--no-trunc'\]/, 'must include stopped containers');
assert.match(inventory, /normalizeId\(container\.Image\)/, 'must correlate the real inspected image ID');
assert.doesNotMatch(inventory, /Config\?\.Env|\.Config\.Env/, 'must not read container environment');
assert.match(inventory, /NOT_MEASURED/, 'must not invent reclaimable bytes');
assert.match(cleanup, /SHARED_VOLUME_PROTECTED/);
assert.doesNotMatch(cleanup, /volume rm|down -v|system prune|image prune/);

const dir = mkdtempSync(join(tmpdir(), 'gesto-cleanup-'));
const log = join(dir, 'log');
const docker = join(dir, 'docker');
writeFileSync(docker, `#!/bin/sh
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "container inspect")
    case "$3" in
      -f) format="$4"; id="$5";; *) exit 2;;
    esac
    case "$format" in *Mounts*) [ "$SHARED" = yes ] && echo gest-o_pgdata; exit 0;; *) echo reviewed-project;; esac;;
  "network inspect") echo reviewed-project;;
  "container rm"|"network rm") exit 0;;
  *) exit 2;;
esac
`);
chmodSync(docker, 0o755);
const idA = 'a'.repeat(64), idB = 'b'.repeat(64);
const manifest = join(dir, 'manifest.tsv');
writeFileSync(manifest, `project\tpr\tcontainer_ids\tnetwork_ids\nreviewed-project\t526\t${idA}\t${idB}\n`);
const invoke = (mode, extra = {}) => spawnSync('bash', ['scripts/legacy-preview-cleanup.sh', mode, manifest], {
  cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log, ...extra }
});
let result = invoke('inventory');
assert.equal(result.status, 0, result.stderr + result.stdout);
assert.doesNotMatch(readFileSync(log, 'utf8'), / rm /);
result = invoke('apply');
assert.notEqual(result.status, 0);
assert.match(result.stdout, /CONFIRMATION_REQUIRED/);
result = invoke('apply', { LEGACY_PREVIEW_APPLY_CONFIRMATION: 'REMOVE_REVIEWED_LEGACY_PREVIEWS', SHARED: 'yes' });
assert.notEqual(result.status, 0);
assert.match(result.stdout, /SHARED_VOLUME_PROTECTED/);
console.log('DOCKER_CLEANUP_SAFETY=PASS');
