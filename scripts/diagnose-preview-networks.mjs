#!/usr/bin/env node
/** Read-only, allowlisted Docker network inventory. Never emits Env or raw inspect. */
import { execFileSync } from 'node:child_process';

const dockerJson = args => JSON.parse(execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const ids = execFileSync('docker', ['network', 'ls', '-q', '--no-trunc'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const networks = ids.length ? dockerJson(['network', 'inspect', ...ids]) : [];
const containerIds = execFileSync('docker', ['ps', '-aq', '--no-trunc'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const containers = containerIds.length ? dockerJson(['container', 'inspect', ...containerIds]) : [];
let defaultAddressPools = 'NOT_OBSERVED';
try {
  const raw = execFileSync('docker', ['info', '--format', '{{json .DefaultAddressPools}}'], { encoding: 'utf8' }).trim();
  if (raw && raw !== 'null') defaultAddressPools = JSON.parse(raw);
} catch {}

const selectedLabels = labels => Object.fromEntries(Object.entries(labels || {}).filter(([key]) =>
  key.startsWith('com.docker.compose.') || key === 'com.gesto.preview' || key.startsWith('com.gesto.preview.')));
const previewPrs = new Set(['874', '875', '876', '877']);
const cleanName = value => String(value || '').replace(/^\//, '');
const networkRows = networks.map(network => {
  const labels = selectedLabels(network.Labels);
  const project = labels['com.docker.compose.project'] || '';
  const pr = labels['com.gesto.preview.pr'] || '';
  const endpoints = Object.entries(network.Containers || {}).map(([id, endpoint]) => ({
    container_id: id, container_name: endpoint.Name || '', ipv4: endpoint.IPv4Address || '', ipv6: endpoint.IPv6Address || ''
  })).sort((a, b) => a.container_id.localeCompare(b.container_id));
  const identityComplete = labels['com.gesto.preview'] === 'true' && /^[0-9]+$/.test(pr)
    && /^[0-9]+$/.test(labels['com.gesto.preview.run-id'] || '')
    && /^[0-9]+$/.test(labels['com.gesto.preview.run-attempt'] || '')
    && labels['com.gesto.preview.workflow'] === 'Preview-Deploy'
    && project === `gesto-pr-${pr}-${labels['com.gesto.preview.run-id']}-${labels['com.gesto.preview.run-attempt']}`;
  const protectedByRole = /production|rollback|recovery|incident/i.test(`${network.Name} ${project}`) || ['bridge', 'host', 'none'].includes(network.Name);
  return {
    network_id: network.Id, name: network.Name, driver: network.Driver, scope: network.Scope,
    internal: Boolean(network.Internal), attachable: Boolean(network.Attachable), ingress: Boolean(network.Ingress),
    ipam: (network.IPAM?.Config || []).map(item => ({ subnet: item.Subnet || '', gateway: item.Gateway || '', ip_range: item.IPRange || '' })),
    labels, endpoints,
    classification: {
      preview_target_pr: previewPrs.has(pr),
      preview_identity: identityComplete ? 'PROVEN' : labels['com.gesto.preview'] === 'true' ? 'INCOMPLETE' : 'NOT_CLAIMED',
      production_or_external_protected: protectedByRole || !identityComplete,
      protection_reason: protectedByRole ? 'PROTECTED_ROLE_OR_BUILTIN' : !identityComplete ? 'ORIGIN_NOT_PROVEN' : 'NONE',
      removal: 'NOT_AUTHORIZED'
    }
  };
}).sort((a, b) => a.name.localeCompare(b.name));

const containerRows = containers.map(container => {
  const labels = selectedLabels(container.Config?.Labels);
  const pr = labels['com.gesto.preview.pr'] || '';
  return {
    container_id: container.Id, name: cleanName(container.Name), state: container.State?.Status || 'unknown',
    labels, networks: Object.keys(container.NetworkSettings?.Networks || {}).sort(), preview_target_pr: previewPrs.has(pr)
  };
}).filter(container => container.preview_target_pr || container.networks.some(name => networkRows.some(network => network.name === name && network.classification.production_or_external_protected)))
  .sort((a, b) => a.name.localeCompare(b.name));

const subnetOwners = new Map();
for (const network of networkRows) for (const item of network.ipam) if (item.subnet) subnetOwners.set(item.subnet, [...(subnetOwners.get(item.subnet) || []), network.network_id]);
const report = {
  format: 1, mode: 'READ_ONLY', generated_at: new Date().toISOString(),
  default_address_pools: defaultAddressPools,
  summary: {
    network_count: networkRows.length,
    target_preview_network_count: networkRows.filter(row => row.classification.preview_target_pr).length,
    incomplete_preview_identity_count: networkRows.filter(row => row.classification.preview_identity === 'INCOMPLETE').length,
    duplicate_subnets: [...subnetOwners].filter(([, owners]) => owners.length > 1).map(([subnet, owners]) => ({ subnet, network_ids: owners }))
  },
  networks: networkRows, associated_containers_including_stopped: containerRows,
  conclusion: 'INVENTORY_ONLY_NO_REMOVAL_AUTHORIZED'
};
console.log(JSON.stringify(report, null, 2));
