import { createHash } from "node:crypto";

export const TENANT_DATA_READINESS_CONTRACT_VERSION = "1.0B.2-L/v1";
export const TENANT_DATA_READINESS_ROOTS = ["Client", "AgendaEvent", "Product", "AppConfig", "Goal", "ActivityKPI", "Sale", "SellerTerritoryCity", "KnowledgeDocument", "ErpSyncRun", "ErpSyncLock"] as const;
export type ReadinessRoot = typeof TENANT_DATA_READINESS_ROOTS[number];

export type TenantFact = { id: string; active: boolean };
export type UserFact = { id: string; active: boolean };
export type MembershipFact = { id: string; userId: string; tenantId: string; active: boolean };
export type ControlPlaneSnapshot = { tenants: readonly TenantFact[]; users: readonly UserFact[]; memberships: readonly MembershipFact[] };
export type RootFact = {
  id: string;
  tenantId: string | null;
  /** Empty for roots without a derivable parent; null means an expected ownership relation is absent. */
  ownershipTenantIds?: readonly (string | null)[];
  parentExists?: boolean;
};
export type RootRead = { root: string; rows: readonly RootFact[]; evidenceHash?: string };
export interface TenantDataReadinessReader {
  readControlPlane(): Promise<ControlPlaneSnapshot>;
  listRoots(): Promise<readonly string[]>;
  readRoot(root: ReadinessRoot): Promise<RootRead>;
}

export type BlockerCode =
  | "UNKNOWN_TENANT" | "AMBIGUOUS_MEMBERSHIP" | "MEMBERSHIP_TENANT_INACTIVE" | "MEMBERSHIP_TENANT_MISSING"
  | "ROOT_TENANT_MISSING" | "CROSS_TENANT_RELATION" | "OWNERSHIP_DIVERGENCE" | "OWNERSHIP_NULL"
  | "ORPHAN_PARENT" | "HASH_INCONSISTENT" | "ROOT_MISSING" | "ROOT_UNEXPECTED" | "PARTIAL_READ";
export type RootReport = {
  root: ReadinessRoot; total: number; tenantIdFilled: number; tenantIdNull: number; distinctTenants: number;
  ownershipDivergent: number; orphans: number; crossTenant: number; primaryKeyHash: string;
  classification: "READY" | "BLOCKED" | "QUARANTINE_REQUIRED";
};
export type ReadinessReport = {
  contractVersion: string; rootsEvaluated: number; controlPlane: {
    activeTenants: number; inactiveTenants: number; activeUsers: number; inactiveUsers: number;
    activeMemberships: number; inactiveMemberships: number; usersWithoutMembership: number;
    usersWithMultipleMemberships: number; membershipsToSuspendedTenant: number; membershipsToMissingTenant: number;
    defaultOnlyCompatible: boolean;
  }; roots: readonly RootReport[]; aggregateHash: string; blockers: Readonly<Record<BlockerCode, number>>;
  quarantineCount: number; result: "READY" | "BLOCKED"; durationMs: number;
};

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const emptyBlockers = (): Record<BlockerCode, number> => ({ UNKNOWN_TENANT: 0, AMBIGUOUS_MEMBERSHIP: 0,
  MEMBERSHIP_TENANT_INACTIVE: 0, MEMBERSHIP_TENANT_MISSING: 0, ROOT_TENANT_MISSING: 0,
  CROSS_TENANT_RELATION: 0, OWNERSHIP_DIVERGENCE: 0, OWNERSHIP_NULL: 0, ORPHAN_PARENT: 0,
  HASH_INCONSISTENT: 0, ROOT_MISSING: 0, ROOT_UNEXPECTED: 0, PARTIAL_READ: 0 });

/** Runs only injected reads. It has no Prisma/runtime/HTTP dependency and returns no source identifiers. */
export async function runTenantDataReadinessPreflight(reader: TenantDataReadinessReader): Promise<ReadinessReport> {
  const started = performance.now();
  const blockers = emptyBlockers();
  let control: ControlPlaneSnapshot = { tenants: [], users: [], memberships: [] };
  let listed: readonly string[] = [];
  try { [control, listed] = await Promise.all([reader.readControlPlane(), reader.listRoots()]); }
  catch { blockers.PARTIAL_READ++; }

  const expected = new Set<string>(TENANT_DATA_READINESS_ROOTS);
  blockers.ROOT_MISSING += TENANT_DATA_READINESS_ROOTS.filter((root) => !listed.includes(root)).length;
  blockers.ROOT_UNEXPECTED += listed.filter((root) => !expected.has(root)).length;
  const tenantById = new Map(control.tenants.map((tenant) => [tenant.id, tenant]));
  const membershipsByUser = new Map<string, MembershipFact[]>();
  for (const membership of control.memberships) {
    const bucket = membershipsByUser.get(membership.userId) ?? [];
    bucket.push(membership); membershipsByUser.set(membership.userId, bucket);
    const tenant = tenantById.get(membership.tenantId);
    if (!tenant) blockers.MEMBERSHIP_TENANT_MISSING++;
    else if (!tenant.active) blockers.MEMBERSHIP_TENANT_INACTIVE++;
  }
  const usersWithoutMembership = control.users.filter((user) => (membershipsByUser.get(user.id)?.length ?? 0) === 0).length;
  const usersWithMultipleMemberships = control.users.filter((user) => (membershipsByUser.get(user.id)?.length ?? 0) > 1).length;
  blockers.AMBIGUOUS_MEMBERSHIP += usersWithMultipleMemberships;
  blockers.UNKNOWN_TENANT += control.tenants.length === 0 ? 1 : 0;

  const roots: RootReport[] = [];
  await Promise.all(TENANT_DATA_READINESS_ROOTS.map(async (root) => {
    if (!listed.includes(root)) return;
    try {
      const snapshot = await reader.readRoot(root);
      if (snapshot.root !== root) { blockers.ROOT_UNEXPECTED++; return; }
      const rows = [...snapshot.rows].sort((a, b) => a.id.localeCompare(b.id));
      const primaryKeyHash = hash(rows.map((row) => row.id).join("\n"));
      if (snapshot.evidenceHash !== undefined && snapshot.evidenceHash !== primaryKeyHash) blockers.HASH_INCONSISTENT++;
      let ownershipDivergent = 0, orphans = 0, crossTenant = 0;
      for (const row of rows) {
        if (row.tenantId !== null && !tenantById.has(row.tenantId)) blockers.ROOT_TENANT_MISSING++;
        if (row.parentExists === false) { orphans++; blockers.ORPHAN_PARENT++; }
        for (const ownerTenant of row.ownershipTenantIds ?? []) {
          if (ownerTenant === null) blockers.OWNERSHIP_NULL++;
          else if (row.tenantId !== null && ownerTenant !== row.tenantId) { ownershipDivergent++; crossTenant++; blockers.OWNERSHIP_DIVERGENCE++; blockers.CROSS_TENANT_RELATION++; }
        }
      }
      const quarantined = ownershipDivergent + orphans;
      roots.push({ root, total: rows.length, tenantIdFilled: rows.filter((row) => row.tenantId !== null).length,
        tenantIdNull: rows.filter((row) => row.tenantId === null).length,
        distinctTenants: new Set(rows.flatMap((row) => row.tenantId === null ? [] : [row.tenantId])).size,
        ownershipDivergent, orphans, crossTenant, primaryKeyHash,
        classification: quarantined ? "QUARANTINE_REQUIRED" : "READY" });
    } catch { blockers.PARTIAL_READ++; }
  }));
  roots.sort((a, b) => TENANT_DATA_READINESS_ROOTS.indexOf(a.root) - TENANT_DATA_READINESS_ROOTS.indexOf(b.root));
  const blockerTotal = Object.values(blockers).reduce((sum, count) => sum + count, 0);
  if (blockerTotal) for (const item of roots) if (item.classification === "READY") item.classification = "BLOCKED";
  const activeTenants = control.tenants.filter((tenant) => tenant.active).length;
  return { contractVersion: TENANT_DATA_READINESS_CONTRACT_VERSION, rootsEvaluated: roots.length,
    controlPlane: { activeTenants, inactiveTenants: control.tenants.length - activeTenants,
      activeUsers: control.users.filter((user) => user.active).length, inactiveUsers: control.users.filter((user) => !user.active).length,
      activeMemberships: control.memberships.filter((membership) => membership.active).length,
      inactiveMemberships: control.memberships.filter((membership) => !membership.active).length,
      usersWithoutMembership, usersWithMultipleMemberships,
      membershipsToSuspendedTenant: blockers.MEMBERSHIP_TENANT_INACTIVE, membershipsToMissingTenant: blockers.MEMBERSHIP_TENANT_MISSING,
      defaultOnlyCompatible: activeTenants === 1 && control.tenants.length === 1 && usersWithMultipleMemberships === 0 },
    roots, aggregateHash: hash(roots.map((root) => `${root.root}\t${root.primaryKeyHash}`).join("\n")), blockers,
    quarantineCount: roots.reduce((sum, root) => sum + root.ownershipDivergent + root.orphans, 0),
    result: blockerTotal === 0 ? "READY" : "BLOCKED", durationMs: Math.max(0, Math.round(performance.now() - started)) };
}

export const serializeTenantDataReadiness = (report: ReadinessReport) =>
  `TENANT_DATA_READINESS_PREFLIGHT=${JSON.stringify(report)}`;
