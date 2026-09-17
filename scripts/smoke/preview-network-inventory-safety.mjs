import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync('scripts/diagnose-preview-networks.mjs', 'utf8');
assert.doesNotMatch(source, /network',\s*'(?:rm|prune|create|connect|disconnect)'|container',\s*'(?:rm|stop|kill)'|system',\s*'prune/);
assert.doesNotMatch(source, /\.Config\?\.Env|\.Config\.Env|process\.env/);
for (const field of ['network_id', 'driver', 'scope', 'ipam', 'labels', 'endpoints', 'associated_containers_including_stopped', 'removal', 'NOT_AUTHORIZED']) assert.match(source, new RegExp(field));

const dir = mkdtempSync(join(tmpdir(), 'gesto-network-inventory-'));
const docker = join(dir, 'docker');
writeFileSync(docker, `#!/usr/bin/env node
const a=process.argv.slice(2); process.stderr.write(a.join(' ')+'\\n');
if(a[0]==='network'&&a[1]==='ls') process.stdout.write('net1\\nnet2\\n');
else if(a[0]==='network'&&a[1]==='inspect') process.stdout.write(JSON.stringify([
 {Id:'net1',Name:'gesto-pr-877-35253792293-2_default',Driver:'bridge',Scope:'local',IPAM:{Config:[{Subnet:'172.30.0.0/16',Gateway:'172.30.0.1'}]},Labels:{'com.gesto.preview':'true','com.gesto.preview.pr':'877','com.gesto.preview.run-id':'35253792293','com.gesto.preview.run-attempt':'2','com.gesto.preview.workflow':'Preview-Deploy','com.docker.compose.project':'gesto-pr-877-35253792293-2'},Containers:{}},
 {Id:'net2',Name:'production-external',Driver:'bridge',Scope:'local',IPAM:{Config:[{Subnet:'172.31.0.0/16'}]},Labels:{},Containers:{c1:{Name:'prod-api',IPv4Address:'172.31.0.2/16'}}}
]));
else if(a[0]==='ps') process.stdout.write('c1\\nc2\\n');
else if(a[0]==='container'&&a[1]==='inspect') process.stdout.write(JSON.stringify([
 {Id:'c1',Name:'/prod-api',State:{Status:'running'},Config:{Labels:{secret:'must-not-leak'}},NetworkSettings:{Networks:{'production-external':{}}}},
 {Id:'c2',Name:'/preview-stopped',State:{Status:'exited'},Config:{Labels:{'com.gesto.preview.pr':'877','com.gesto.preview.run-id':'35253792293'}},NetworkSettings:{Networks:{}}}
]));
else if(a[0]==='info') process.stdout.write('[{"Base":"172.16.0.0/12","Size":24}]\\n'); else process.exit(2);
`);
chmodSync(docker, 0o755);
const result = spawnSync(process.execPath, ['scripts/diagnose-preview-networks.mjs'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(result.stdout);
assert.equal(report.mode, 'READ_ONLY');
assert.equal(report.networks[0].classification.preview_identity, 'PROVEN');
assert.equal(report.networks[0].classification.removal, 'NOT_AUTHORIZED');
assert.equal(report.associated_containers_including_stopped.find(row => row.name === 'preview-stopped').state, 'exited');
assert.doesNotMatch(result.stdout, /must-not-leak|secret/);
assert.doesNotMatch(result.stderr, /\brm\b|\bprune\b|\bcreate\b|\bconnect\b|\bdisconnect\b/);
console.log('PREVIEW_NETWORK_INVENTORY_SAFETY=PASS mutations=0 stopped_containers=included redaction=pass');
