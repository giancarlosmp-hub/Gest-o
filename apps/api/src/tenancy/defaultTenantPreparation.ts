import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_TENANT, deterministicMembershipId, mapUserRole, membershipAggregateHash } from "./defaultTenant.js";

type Db = Prisma.TransactionClient | PrismaClient;
type Counts = Record<string, number>;
const countBy = (values: string[]): Counts => values.reduce((out, value) => ({ ...out, [value]: (out[value] ?? 0) + 1 }), {} as Counts);
const tsv = (rows: Array<Record<string, string | number | boolean>>) => {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return `${keys.join("\t")}\n${rows.map(row => keys.map(key => String(row[key] ?? "")).join("\t")).join("\n")}\n`;
};

async function snapshot(db: Db) {
  // Deliberately select no name, email, password/hash, token, or ERP credential fields.
  const [users, tenants, memberships] = await Promise.all([
    db.user.findMany({ select: { id: true, role: true, isActive: true }, orderBy: { id: "asc" } }),
    db.tenant.findMany({ select: { id: true, slug: true, legalName: true, displayName: true, status: true } }),
    db.tenantMembership.findMany({ select: { id: true, tenantId: true, userId: true, role: true, status: true, version: true, invitedAt: true, acceptedAt: true, revokedAt: true } })
  ]);
  const userIds = new Set(users.map(user => user.id));
  const tenantIds = new Set(tenants.map(tenant => tenant.id));
  const membershipUsers = new Set(memberships.map(item => item.userId));
  const duplicateCount = memberships.length - new Set(memberships.map(item => `${item.tenantId}\0${item.userId}`)).size;
  return {
    users, tenants, memberships,
    metrics: {
      users: users.length, tenants: tenants.length, memberships: memberships.length,
      usersByRole: countBy(users.map(user => user.role)), usersByActive: countBy(users.map(user => String(user.isActive))),
      membershipsByRole: countBy(memberships.map(item => item.role)), membershipsByStatus: countBy(memberships.map(item => item.status)),
      usersWithoutMembership: users.filter(user => !membershipUsers.has(user.id)).length,
      membershipsWithoutUser: memberships.filter(item => !userIds.has(item.userId)).length,
      membershipsWithoutTenant: memberships.filter(item => !tenantIds.has(item.tenantId)).length,
      duplicateMemberships: duplicateCount,
      defaultTenantFound: tenants.some(tenant => tenant.id === DEFAULT_TENANT.id),
      unexpectedTenants: tenants.filter(tenant => tenant.id !== DEFAULT_TENANT.id).length,
      aggregateHash: membershipAggregateHash(memberships)
    }
  };
}

function validate(current: Awaited<ReturnType<typeof snapshot>>, allowMissing = true) {
  const unknownRoles: string[] = [];
  for (const user of current.users) try { mapUserRole(user.role); } catch { unknownRoles.push(user.role); }
  if (unknownRoles.length) throw new Error(`UNKNOWN_USER_ROLES:${[...new Set(unknownRoles)].sort().join(",")}`);
  if (current.metrics.unexpectedTenants) throw new Error("UNEXPECTED_TENANT");
  const tenant = current.tenants.find(item => item.id === DEFAULT_TENANT.id);
  if (!tenant && !allowMissing) throw new Error("DEFAULT_TENANT_MISSING");
  if (tenant && (tenant.slug !== DEFAULT_TENANT.slug || tenant.legalName !== DEFAULT_TENANT.legalName || tenant.displayName !== DEFAULT_TENANT.displayName || tenant.status !== "active")) throw new Error("DEFAULT_TENANT_INCOMPATIBLE");
  if (current.metrics.membershipsWithoutUser || current.metrics.membershipsWithoutTenant || current.metrics.duplicateMemberships) throw new Error("MEMBERSHIP_INTEGRITY_ERROR");
  for (const item of current.memberships) {
    const user = current.users.find(candidate => candidate.id === item.userId);
    if (item.tenantId !== DEFAULT_TENANT.id || !user || item.id !== deterministicMembershipId(item.userId) || item.role !== mapUserRole(user.role) || item.status !== "active" || item.version <= 0 || item.version !== 1 || !item.acceptedAt || item.invitedAt || item.revokedAt) throw new Error("MEMBERSHIP_INCOMPATIBLE");
  }
}

export async function prepareDefaultTenant(prisma: PrismaClient, options: { apply: boolean; evidenceDir: string }) {
  const started = performance.now();
  await mkdir(options.evidenceDir, { recursive: true, mode: 0o700 });
  if (existsSync(`${options.evidenceDir}/result.tsv`)) throw new Error("COMPLETED_EVIDENCE_IMMUTABLE");
  const before = await snapshot(prisma);
  validate(before);
  await writeFile(`${options.evidenceDir}/metadata.tsv`, tsv([{ mode: options.apply ? "apply" : "dry-run", identityVersion: 1 }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/users-before.tsv`, tsv([{ total: before.metrics.users, ...Object.fromEntries(Object.entries(before.metrics.usersByRole).map(([k,v]) => [`role_${k}`,v])), ...Object.fromEntries(Object.entries(before.metrics.usersByActive).map(([k,v]) => [`active_${k}`,v])) }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/tenants-before.tsv`, tsv([{ total: before.metrics.tenants, defaultFound: before.metrics.defaultTenantFound, unexpected: before.metrics.unexpectedTenants }]), { mode: 0o600 });
  const missing = before.users.filter(user => !before.memberships.some(item => item.userId === user.id));
  const expectedAggregateHash = membershipAggregateHash([
    ...before.memberships,
    ...missing.map(user => ({ userId: user.id, tenantId: DEFAULT_TENANT.id, role: mapUserRole(user.role), version: 1 }))
  ]);
  await writeFile(`${options.evidenceDir}/dry-run-plan.tsv`, tsv([{ createTenant: before.metrics.tenants === 0 ? 1 : 0, createMemberships: missing.length }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/dry-run.tsv`, tsv([{ users: before.metrics.users, tenants: before.metrics.tenants, memberships: before.metrics.memberships, missingMemberships: missing.length, inconsistencies: before.metrics.membershipsWithoutUser + before.metrics.membershipsWithoutTenant + before.metrics.duplicateMemberships, createTenant: before.metrics.tenants === 0 ? 1 : 0, createMemberships: missing.length, expectedAggregateHash }]), { mode: 0o600 });
  if (!options.apply) {
    const durationMs = Math.round(performance.now() - started);
    await writeFile(`${options.evidenceDir}/dry-run-result.tsv`, tsv([{ result: "PASS", expectedAggregateHash, durationMs }]), { mode: 0o600 });
    return { ...before.metrics, expectedAggregateHash };
  }

  if (!process.env.EXPECTED_AGGREGATE_HASH || process.env.EXPECTED_AGGREGATE_HASH !== expectedAggregateHash) throw new Error("DRY_RUN_STATE_HASH_MISMATCH");

  await prisma.$transaction(async tx => {
    const locked = await snapshot(tx);
    validate(locked);
    if (locked.tenants.length === 0) await tx.tenant.create({ data: { ...DEFAULT_TENANT, status: "active" } });
    const acceptedAt = new Date();
    for (const user of locked.users) if (!locked.memberships.some(item => item.userId === user.id)) {
      await tx.tenantMembership.create({ data: { id: deterministicMembershipId(user.id), tenantId: DEFAULT_TENANT.id, userId: user.id, role: mapUserRole(user.role), status: "active", version: 1, acceptedAt } });
    }
    validate(await snapshot(tx), false);
  }, { isolationLevel: "Serializable" });

  const after = await snapshot(prisma);
  validate(after, false);
  if (after.metrics.memberships !== after.metrics.users || after.metrics.usersWithoutMembership) throw new Error("RECONCILIATION_FAILED");
  if (after.metrics.aggregateHash !== expectedAggregateHash) throw new Error("APPLY_AGGREGATE_HASH_MISMATCH");
  const durationMs = Math.round(performance.now() - started);
  await writeFile(`${options.evidenceDir}/apply.tsv`, tsv([{ committed: true, createdTenant: before.metrics.tenants === 0 ? 1 : 0, createdMemberships: missing.length, aggregateHash: after.metrics.aggregateHash }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/tenants-after.tsv`, tsv([{ total: after.metrics.tenants, defaultFound: after.metrics.defaultTenantFound, unexpected: after.metrics.unexpectedTenants }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/memberships-after.tsv`, tsv([{ total: after.metrics.memberships, ...Object.fromEntries(Object.entries(after.metrics.membershipsByRole).map(([k,v]) => [`role_${k}`,v])), ...Object.fromEntries(Object.entries(after.metrics.membershipsByStatus).map(([k,v]) => [`status_${k}`,v])) }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/reconciliation.tsv`, tsv([{ ...after.metrics, usersByRole: JSON.stringify(after.metrics.usersByRole), usersByActive: JSON.stringify(after.metrics.usersByActive), membershipsByRole: JSON.stringify(after.metrics.membershipsByRole), membershipsByStatus: JSON.stringify(after.metrics.membershipsByStatus), durationMs }]), { mode: 0o600 });
  await writeFile(`${options.evidenceDir}/result.tsv`, tsv([{ result: "PASS", aggregateHash: after.metrics.aggregateHash, durationMs }]), { mode: 0o600 });
  return after.metrics;
}
