#!/usr/bin/env node
/** Exact-identity provenance and fail-closed cleanup for newly built preview images. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LABEL = 'com.gesto.preview.';
const required = ['repository', 'pr', 'run-id', 'run-attempt', 'workflow', 'commit', 'service', 'project'];
const die = (reason, code = 1) => { console.error(`PREVIEW_IMAGE_RESULT=PRESERVED reason=${reason}`); process.exit(code); };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const fullId = value => /^sha256:[a-f0-9]{64}$/.test(value || '') ? value : die('full_image_id_required');
const lines = value => value.split('\n').map(x => x.trim()).filter(Boolean);
const canonical = values => [...new Set(values || [])].sort();
const inspectImages = ids => ids.length ? JSON.parse(docker('image', 'inspect', ...ids)) : [];
const referenceKind = value => /^sha256:[a-f0-9]{64}$/.test(value) ? 'full_id' : /^[a-f0-9]{12,64}$/.test(value) ? 'abbreviated_id' : 'tag_or_reference';
const resolveLocalImage = (raw, service) => {
  const references = lines(raw);
  if (references.length === 0) die(`compose_image_reference_${service}_missing`);
  if (references.length !== 1) die(`compose_image_reference_${service}_ambiguous`);
  const reference = references[0];
  console.log(`PREVIEW_IMAGE_REFERENCE service=${service} candidates=1 kind=${referenceKind(reference)} length=${reference.length}`);
  let inspected;
  try { inspected = inspectImages([reference]); } catch { die(`image_reference_${service}_unresolvable`); }
  if (!Array.isArray(inspected) || inspected.length !== 1) die(`image_reference_${service}_ambiguous`);
  // The reference may be a tag or a Compose-version-dependent abbreviated ID.
  // Only Docker inspect is authoritative for the complete local IMAGE ID.
  return facts(inspected[0]);
};
const labelsOf = image => image?.Config?.Labels || {};
const facts = image => ({
  image_id: fullId(image.Id),
  tags: canonical((image.RepoTags || []).filter(x => x !== '<none>:<none>')),
  digests: canonical((image.RepoDigests || []).filter(x => x !== '<none>@<none>')),
  labels: Object.fromEntries(required.map(key => [key, labelsOf(image)[`${LABEL}${key}`] || '']))
});
const envIdentity = service => ({
  repository: process.env.PREVIEW_OWNER_REPOSITORY,
  pr: process.env.PREVIEW_OWNER_PR,
  'run-id': process.env.PREVIEW_OWNER_RUN_ID,
  'run-attempt': process.env.PREVIEW_OWNER_RUN_ATTEMPT,
  workflow: process.env.PREVIEW_OWNER_WORKFLOW,
  commit: process.env.EXPECTED_PREVIEW_SHA,
  service,
  project: process.env.COMPOSE_PROJECT_NAME
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assertIdentity = (observed, expected) => {
  for (const key of required) if (!expected[key] || observed[key] !== String(expected[key])) die(`identity_${key}_not_proven`);
};

const command = process.argv[2];
const manifestPath = process.argv[3];
if (!['record', 'authorize', 'cleanup'].includes(command) || !manifestPath) die('usage_record_authorize_or_cleanup_manifest', 2);

if (command === 'record') {
  const project = process.env.COMPOSE_PROJECT_NAME || die('project_missing');
  const resolveServiceRaw = service => {
    let raw = docker('compose', '-p', project, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'images', '-q', service);
    if (!lines(raw).length) {
      let targetRef = `${project}-${service}`;
      try {
        const cfg = JSON.parse(docker('compose', '-p', project, '-f', 'docker-compose.yml', '-f', 'docker-compose.preview.yml', 'config', '--format', 'json'));
        if (cfg.services?.[service]?.image) targetRef = cfg.services[service].image;
      } catch {}
      try {
        raw = docker('images', '-q', targetRef);
      } catch {
        raw = '';
      }
    }
    return raw;
  };
  const images = ['api', 'web'].map(service => resolveLocalImage(resolveServiceRaw(service), service));
  if (new Set(images.map(image => image.image_id)).size !== 2) die('service_image_identity_not_distinct');
  images.sort((a, b) => a.labels.service.localeCompare(b.labels.service));
  for (const image of images) assertIdentity(image.labels, envIdentity(image.labels.service));
  if (!same(images.map(x => x.labels.service), ['api', 'web'])) die('service_set_diverged');
  const manifest = { format: 1, created_at: new Date().toISOString(), project, images };
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(manifestPath), 0o700);
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600); renameSync(temporary, manifestPath);
  console.log(`PREVIEW_IMAGE_PROVENANCE=PASS project=${project} images=${images.length}`);
  process.exit(0);
}

if (!process.env.GITHUB_TOKEN) die('github_auth_missing');
let manifest;
try {
  const metadata = lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid()) die('manifest_filesystem_contract_invalid');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch { die('manifest_unreadable'); }
if (manifest?.format !== 1 || !Array.isArray(manifest.images) || manifest.images.length !== 2) die('manifest_invalid');
if (!same(Object.keys(manifest).sort(), ['created_at', 'format', 'images', 'project']) || !Number.isFinite(Date.parse(manifest.created_at))) die('manifest_schema_invalid');
if (!/^gesto-pr-[0-9]+-[0-9]+-[0-9]+$/.test(manifest.project || '')) die('project_invalid');
const expectedBase = envIdentity('');
if (manifest.project !== expectedBase.project) die('manifest_project_diverged');
if (!/^[1-9][0-9]*$/.test(expectedBase.pr || '') || !/^[1-9][0-9]*$/.test(expectedBase['run-id'] || '') || !/^[1-9][0-9]*$/.test(expectedBase['run-attempt'] || '')) die('numeric_identity_invalid');

const github = async path => {
  const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${expectedBase.repository}${path}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!response.ok) die(`github_query_failed_${response.status}`);
  return response.json();
};
const identityDiverged = (field, detail = '') => die(`authenticated_run_identity_diverged field=${field} pr=${expectedBase.pr} run_id=${expectedBase['run-id']}${detail}`);
const authenticateProducer = async () => {
  const pr = await github(`/pulls/${expectedBase.pr}`);
  if (pr.state !== 'closed') die('pr_not_closed');
  // Query both the top-level run resource (where GitHub Actions REST API attaches
  // pull_requests associations) and the exact immutable attempt endpoint.
  const topRun = await github(`/actions/runs/${expectedBase['run-id']}`);
  const run = await github(`/actions/runs/${expectedBase['run-id']}/attempts/${expectedBase['run-attempt']}`);
  if (run.status !== 'completed') die('producer_run_not_completed');
  if (run.conclusion !== 'success') die('producer_run_not_successful');
  if (!Number.isSafeInteger(run.run_attempt) || String(run.run_attempt) !== expectedBase['run-attempt']) identityDiverged('run_attempt', ` expected=${expectedBase['run-attempt']} observed=${Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 'INVALID'}`);
  if (!/^[a-f0-9]{40}$/.test(run.head_sha || '')) identityDiverged('run_head_sha');
  if (run.name !== 'Preview Deploy') identityDiverged('workflow_name');
  if (run.path !== '.github/workflows/preview.yml') identityDiverged('workflow_path');
  if (run.event !== 'pull_request') identityDiverged('event');
  if (!Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0) identityDiverged('workflow_id');
  const authenticatedWorkflow = await github(`/actions/workflows/${run.workflow_id}`);
  if (authenticatedWorkflow.path !== '.github/workflows/preview.yml') identityDiverged('workflow_id_path');
  if (typeof run.head_branch !== 'string' || run.head_branch !== pr.head?.ref) identityDiverged('head_ref');
  // Validate origin repository and fork identity explicitly. Fail-closed if missing or divergent.
  const headRef = pr.head?.ref;
  const headUser = pr.head?.user?.login;
  const headRepoFull = pr.head?.repo?.full_name;
  if (!headRef || !headUser || !headRepoFull) {
    die('run_pr_correlation_missing');
  }

  // Extract explicit PR associations from topRun and attempt run.
  const topPRs = Array.isArray(topRun.pull_requests) ? topRun.pull_requests : [];
  const attemptPRs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  const explicitPRs = topPRs.length > 0 ? topPRs : attemptPRs;

  if (explicitPRs.length > 0) {
    // Explicit associations provided by GitHub REST API.
    const correlatedPull = explicitPRs.find(x => String(x.number) === String(expectedBase.pr));
    if (!correlatedPull) {
      // Explicit associations exist but NONE match expectedBase.pr.
      die('run_pr_correlation_missing');
    }
    if (correlatedPull.head?.sha !== expectedBase.commit) identityDiverged('run_pull_request_head_sha');
    if (pr.head?.sha !== expectedBase.commit) identityDiverged('pull_request_head_sha');
    if (run.head_sha !== expectedBase.commit) identityDiverged('run_head_sha');
  } else {
    // GitHub Actions REST API clears the pull_requests array on workflow runs when a PR is closed or merged.
    // Fallback for closed PRs with empty pull_requests arrays:
    if (topRun.event !== 'pull_request' || typeof topRun.head_branch !== 'string' || topRun.head_branch !== headRef) {
      die('run_pr_correlation_missing');
    }

    // Prove exact 3-way commit linkage: candidate build commit == PR head SHA == Workflow run SHA.
    if (pr.head?.sha !== expectedBase.commit) identityDiverged('pull_request_head_sha');
    if (topRun.head_sha !== expectedBase.commit || run.head_sha !== expectedBase.commit) {
      identityDiverged('run_head_sha');
    }

    // Query GitHub API for ALL PRs on this head branch/user across all pages.
    // If multiple PRs exist for this branch (e.g. branch reuse across PRs), correlation is ambiguous.
    const pullsForBranch = [];
    for (let page = 1; ; page++) {
      const pageData = await github(`/pulls?head=${encodeURIComponent(`${headUser}:${headRef}`)}&state=all&per_page=100&page=${page}`);
      if (!Array.isArray(pageData)) die('run_pr_correlation_missing');
      for (const pull of pageData) {
        if (pull.head?.ref === headRef && pull.head?.user?.login === headUser) {
          pullsForBranch.push(pull);
        }
      }
      if (pageData.length < 100) break;
    }

    if (pullsForBranch.length !== 1 || String(pullsForBranch[0].number) !== String(expectedBase.pr)) {
      die('run_pr_correlation_missing');
    }
  }
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    for (let page = 1; ; page++) {
      const pageData = await github(`/actions/runs?status=${status}&event=pull_request&per_page=100&page=${page}`);
      const rows = pageData.workflow_runs || [];
      if (rows.some(x => x.id !== Number(expectedBase['run-id']) && x.pull_requests?.some(p => String(p.number) === String(expectedBase.pr)))) die(`concurrent_run_${status}`);
      if (rows.length < 100) break;
    }
  }
};
await authenticateProducer();

const evidenceRoots = (process.env.PROTECTED_IMAGE_EVIDENCE_ROOTS || '/var/log/gest-o/deploy,/var/log/gest-o/backup').split(',');
const evidenceContains = id => {
  const walk = root => {
    let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && walk(path)) return true;
      if (entry.isFile()) { try { if (statSync(path).size <= 1024 * 1024 && readFileSync(path, 'utf8').includes(id)) return true; } catch {} }
    }
    return false;
  };
  return evidenceRoots.some(walk);
};
const protectedNames = new Set(['gest-o-production-api-1', 'gest-o-production-web-1', 'gest-o-db-clean-v2-20260717']);
const currentContainerIds = lines(docker('ps', '-aq', '--no-trunc'));
const containers = currentContainerIds.length ? JSON.parse(docker('container', 'inspect', ...currentContainerIds)) : [];

const candidates = [];
for (const recorded of [...manifest.images].sort((a, b) => a.labels.service.localeCompare(b.labels.service))) {
  if (!same(Object.keys(recorded).sort(), ['digests', 'image_id', 'labels', 'tags']) || !Array.isArray(recorded.tags) || !Array.isArray(recorded.digests)) die('manifest_image_schema_invalid');
  const expected = envIdentity(recorded.labels?.service);
  assertIdentity(recorded.labels || {}, expected);
  fullId(recorded.image_id);
  let current;
  try { current = facts(inspectImages([recorded.image_id])[0]); } catch (error) {
    if (/No such image|No such object/i.test(String(error.stderr || error.message))) { console.log(`PREVIEW_IMAGE_ALREADY_ABSENT=${recorded.image_id}`); continue; }
    die('image_reinspection_failed');
  }
  assertIdentity(current.labels, expected);
  if (!same(current.tags, recorded.tags) || !same(current.digests, recorded.digests)) die('references_diverged_since_manifest');
  if (current.tags.some(tag => /production|rollback|recovery|incident/i.test(tag))) die('protected_tag_present');
  if (evidenceContains(current.image_id)) die('rollback_or_recovery_evidence_present');
  const referencing = containers.filter(container => container.Image === current.image_id);
  if (referencing.length) {
    const ownedRuntimeOnly = command === 'authorize' && referencing.every(container => {
      const labels = container.Config?.Labels || {};
      return labels['com.docker.compose.project'] === expectedBase.project
        && labels['com.docker.compose.service'] === current.labels.service
        && ['pr', 'run-id', 'run-attempt', 'workflow'].every(key => String(labels[`${LABEL}${key}`] || '') === String(expectedBase[key]));
    });
    if (!ownedRuntimeOnly) die(protectedNames.has(String(referencing[0].Name || '').replace(/^\//, '')) ? 'production_container_reference' : 'container_reference_present');
  }
  candidates.push(current);
}

if (command === 'authorize') {
  console.log(`PREVIEW_IMAGE_AUTHORIZATION=PASS project=${expectedBase.project} images=${candidates.length}`);
  process.exit(0);
}

for (const current of candidates) {
  // Repeat authenticated authorization and local TOCTOU checks immediately
  // before every individual, non-force image deletion.
  await authenticateProducer();
  const finalImage = facts(inspectImages([current.image_id])[0]);
  if (!same(finalImage, current)) die('image_changed_before_delete');
  const finalContainers = lines(docker('ps', '-aq', '--no-trunc'));
  if (finalContainers.length) {
    const inspected = JSON.parse(docker('container', 'inspect', ...finalContainers));
    if (inspected.some(container => container.Image === current.image_id)) die('container_reference_created_before_delete');
  }
  // Docker refuses an ID-only, non-force removal when the same image has
  // multiple tags. Remove exactly the revalidated reference set instead;
  // Docker deletes the underlying image when its final reference disappears.
  const removalReferences = current.tags.length ? current.tags : current.digests.length ? current.digests : [current.image_id];
  docker('image', 'rm', ...removalReferences);
  try { inspectImages([current.image_id]); die('image_still_present_after_reference_removal'); } catch (error) {
    if (!/No such image|No such object/i.test(String(error.stderr || error.message))) throw error;
  }
  console.log(`PREVIEW_IMAGE_REMOVED=${current.image_id} service=${current.labels.service}`);
}
rmSync(manifestPath, { force: true });
console.log('PREVIEW_IMAGE_RESULT=PASS force=false shared_layers=docker_managed');
