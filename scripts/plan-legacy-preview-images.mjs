#!/usr/bin/env node
/** Read-only batch planner. It never infers ownership from a tag or image name. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [inventoryPath, evidencePath] = process.argv.slice(2);
const fail = reason => { console.error(`LEGACY_IMAGE_PLAN=FAIL reason=${reason}`); process.exit(1); };
if (!inventoryPath || !evidencePath) fail('usage_inventory_and_independent_evidence');
let inventory, evidence;
try { inventory = JSON.parse(readFileSync(inventoryPath)); evidence = JSON.parse(readFileSync(evidencePath)); } catch { fail('input_unreadable'); }
if (!Array.isArray(inventory.images) || !Array.isArray(evidence.images)) fail('input_invalid');
const fullId = id => /^sha256:[a-f0-9]{64}$/.test(id || '');
const duplicateIds = values => new Set(values).size !== values.length;
if (inventory.images.some(x => !fullId(x.image_id)) || duplicateIds(inventory.images.map(x => x.image_id))) fail('inventory_identity_invalid');
if (evidence.images.some(x => !fullId(x.image_id)) || duplicateIds(evidence.images.map(x => x.image_id))) fail('evidence_identity_invalid');

const query = async path => {
  if (!process.env.GITHUB_TOKEN) throw new Error('github_auth_missing');
  const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${evidence.repository}${path}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!response.ok) throw new Error(`github_${response.status}`);
  if (Number(response.headers.get('x-ratelimit-remaining')) === 0) throw new Error('github_rate_limit');
  return response.json();
};
const cache = new Map();
const githubFacts = async item => {
  const key = `${item.pr}:${item.run_id}`;
  if (cache.has(key)) return cache.get(key);
  const result = await Promise.all([query(`/pulls/${item.pr}`), query(`/actions/runs/${item.run_id}`)]).then(([pr, run]) => ({
    pr_state: pr.state, merged: Boolean(pr.merged_at), run_status: run.status, run_conclusion: run.conclusion, run_attempt: run.run_attempt,
    head_sha: run.head_sha, workflow: run.name, event: run.event,
    correlated: run.pull_requests?.some(x => String(x.number) === String(item.pr)) || false
  }));
  cache.set(key, result); return result;
};

const evidenceById = new Map(evidence.images.map(x => [x.image_id, x]));
const rows = [];
for (const image of inventory.images) {
  const proof = evidenceById.get(image.image_id);
  const base = { image_id: image.image_id, tags: image.tags || [], digests: image.digests || [], containers: image.containers || [], decision: 'NOT_PROVEN', reasons: [] };
  if (image.production_reference) base.reasons.push('PRODUCTION_REFERENCE');
  if (image.rollback_reference) base.reasons.push('ROLLBACK_REFERENCE');
  if (image.incident_hold || image.recovery_reference) base.reasons.push('INCIDENT_OR_RECOVERY_HOLD');
  if ((image.containers || []).length) base.reasons.push('CONTAINER_REFERENCE');
  if (!proof) base.reasons.push('INDEPENDENT_PROVENANCE_MISSING');
  if (proof) {
    const fields = ['repository', 'pr', 'run_id', 'run_attempt', 'workflow', 'commit', 'service', 'project'];
    if (fields.some(field => !proof[field])) base.reasons.push('PROVENANCE_INCOMPLETE');
    try {
      const remote = await githubFacts(proof);
      base.github = remote;
      if (remote.pr_state !== 'closed') base.reasons.push('PR_OPEN');
      if (remote.run_status !== 'completed') base.reasons.push('RUN_NOT_COMPLETED');
      if (remote.run_conclusion !== 'success') base.reasons.push('RUN_NOT_SUCCESSFUL');
      if (String(remote.run_attempt) !== String(proof.run_attempt) || remote.head_sha !== proof.commit || remote.workflow !== proof.workflow || remote.event !== 'pull_request' || !remote.correlated) base.reasons.push('GITHUB_IDENTITY_DIVERGED');
    } catch (error) { base.reasons.push(`REMOTE_EVIDENCE_UNAVAILABLE:${error.message}`); }
  }
  if (!base.reasons.length) { base.decision = 'ELIGIBLE_FOR_HUMAN_REVIEW'; base.reasons.push('ALL_PLANNING_GATES_PROVEN'); }
  else if (base.reasons.some(x => /PRODUCTION|ROLLBACK|INCIDENT|RECOVERY|CONTAINER/.test(x))) base.decision = 'PROTECTED';
  rows.push(base);
}
rows.sort((a, b) => a.image_id.localeCompare(b.image_id));
const manifest = { format: 1, generated_at: new Date().toISOString(), read_only: true, expires_at: new Date(Date.now() + 24 * 3600e3).toISOString(), repository: evidence.repository, reclaimable_bytes: 'NOT_MEASURED', images: rows };
const canonical = JSON.stringify(manifest);
manifest.approval_hash_sha256 = createHash('sha256').update(canonical).digest('hex');
manifest.notes = ['Approval, if a separately reviewed executor is ever implemented, must bind this exact hash.', 'No executor is included; unknown or unavailable evidence is NOT_PROVEN.', 'Tags, ages and absent containers are not ownership evidence.'];
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
