#!/usr/bin/env node
/** Read-only, sanitized Docker image inventory. Never inspects container Env. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const dockerJson = (kind, ids) => ids.length ? JSON.parse(run('docker', [kind, 'inspect', ...ids])) : [];
const lines = value => value.split('\n').map(x => x.trim()).filter(Boolean);
const normalizeId = value => value?.startsWith('sha256:') ? value : value ? `sha256:${value}` : '';
const productionNames = new Set((process.env.PRODUCTION_CONTAINERS || 'gest-o-production-api-1,gest-o-production-web-1,gest-o-db-clean-v2-20260717').split(','));
const evidenceRoot = process.env.DEPLOY_EVIDENCE_ROOT || '/var/log/gest-o/deploy';

const imageIds = lines(run('docker', ['image', 'ls', '--no-trunc', '--quiet']));
const images = dockerJson('image', [...new Set(imageIds)]);
const containerIds = lines(run('docker', ['ps', '-aq', '--no-trunc']));
const containers = dockerJson('container', containerIds);
const rollback = new Set();

// Read only the deployment metadata formats created by deploy-production.sh.
const walk = directory => {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && ['previous-runtime.tsv', 'rollback-images.env'].includes(entry.name)) {
      if (statSync(path).size > 1024 * 1024) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(/sha256:[a-f0-9]{64}/g)) rollback.add(match[0]);
    }
  }
};
walk(evidenceRoot);

const byImage = new Map(images.map(image => [normalizeId(image.Id), {
  image_id: normalizeId(image.Id),
  tags: (image.RepoTags || []).filter(x => x !== '<none>:<none>').sort(),
  digests: (image.RepoDigests || []).filter(x => x !== '<none>@<none>').sort(),
  created: image.Created || null,
  size_bytes: image.Size ?? null,
  shared_size_bytes: image.SharedSize >= 0 ? image.SharedSize : 'NOT_MEASURED',
  unique_size_bytes: image.VirtualSize >= 0 && image.SharedSize >= 0 ? image.VirtualSize - image.SharedSize : 'NOT_MEASURED',
  containers: [], production_reference: false, rollback_reference: rollback.has(normalizeId(image.Id)),
  classification: 'vínculo desconhecido, preservar', reasons: []
}]));

for (const container of containers) {
  const imageId = normalizeId(container.Image);
  const row = byImage.get(imageId);
  if (!row) continue;
  const name = String(container.Name || '').replace(/^\//, '');
  const labels = container.Config?.Labels || {};
  const reference = { name, state: container.State?.Status || 'unknown', compose_project: labels['com.docker.compose.project'] || null,
    preview_pr: labels['com.gesto.preview.pr'] || null, preview_run: labels['com.gesto.preview.run-id'] || null };
  row.containers.push(reference);
  if (productionNames.has(name)) row.production_reference = true;
}

for (const row of byImage.values()) {
  if (row.production_reference) { row.classification = 'produção atual'; row.reasons.push('container produtivo exato referencia o IMAGE ID'); }
  else if (row.rollback_reference || row.tags.some(x => x.includes('-rollback:'))) { row.classification = 'rollback protegido'; row.reasons.push('evidência/tag de rollback referencia o IMAGE ID'); }
  else if (row.containers.length) { row.classification = 'vínculo desconhecido, preservar'; row.reasons.push('um ou mais containers, inclusive parados, referenciam o IMAGE ID'); }
  else row.reasons.push('ausência de container não prova descarte; referências externas ainda não classificadas');
  row.containers.sort((a, b) => a.name.localeCompare(b.name));
}

const result = { format: 1, generated_at: new Date().toISOString(), read_only: true,
  reclaimable_estimate_bytes: 'NOT_MEASURED', notes: [
    'Objetos são agrupados por IMAGE ID completo; tags e digests não são somados.',
    'SharedSize ausente/negativo é NOT_MEASURED; docker system df negativo não é usado.',
    'O diagnóstico não lê nem imprime Env, secrets, tokens ou conteúdos de backup.',
    'PR/run GitHub e bundles fora de DEPLOY_EVIDENCE_ROOT exigem correlação separada; desconhecido é preservado.'
  ], images: [...byImage.values()].sort((a, b) => a.image_id.localeCompare(b.image_id)) };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
