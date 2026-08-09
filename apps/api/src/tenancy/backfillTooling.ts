import { createHash, randomUUID } from "node:crypto";

export const BACKFILL_CONTRACT_VERSION = "1.0B.2-B/v1";
export const BACKFILL_ROOTS = ["Client", "AgendaEvent", "Product", "AppConfig", "Goal", "ActivityKPI", "Sale", "SellerTerritoryCity", "KnowledgeDocument", "ErpSyncRun", "ErpSyncLock"] as const;
export type BackfillRoot = typeof BACKFILL_ROOTS[number];
export type RunState = "planned" | "dry_run_passed" | "approved" | "applying" | "reconciled" | "aborted" | "failed" | "quarantined";
export type RowSnapshot = { id: string; tenantId: string | null; ownershipTenantId?: string | null; referenceValid?: boolean };
export type RootSnapshot = { root: BackfillRoot; rows: readonly RowSnapshot[] };
export type Quarantine = { idHash: string; reasonCode: "INVALID_REFERENCE" | "OWNERSHIP_DIVERGENCE" };
export type BatchPlan = { firstId: string; lastId: string; cursorAfter: string | null; ids: readonly string[] };
export type RootPlan = { root: BackfillRoot; targetTenantId: string; total: number; nullCount: number; assignedCorrectly: number; divergent: number; quarantined: number; batches: readonly BatchPlan[]; planHash: string; quarantine: readonly Quarantine[] };
export type BackfillPlan = { runId: string; contractVersion: string; targetTenantId: string; batchSize: number; createdAt: string; state: RunState; roots: readonly RootPlan[]; aggregateHash: string };

export const backfillDigest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = backfillDigest;
export function buildBoundedBatchRanges(total: number, batchSize: number): readonly { ordinal: number; size: number }[] {
  const ranges = [];
  for (let offset = 0; offset < total; offset += batchSize) ranges.push({ ordinal: ranges.length + 1, size: Math.min(batchSize, total - offset) });
  return ranges;
}
const canonicalMapping = (ids: readonly string[], tenantId: string) => ids.map((id) => `${id}\t${tenantId}`).join("\n");

export function buildBackfillPlan(input: {
  targetTenantId: string;
  targetTenantActive: boolean;
  knownTenantIds: readonly string[];
  snapshots: readonly RootSnapshot[];
  batchSize?: number;
  now?: string;
}): BackfillPlan {
  if (!input.targetTenantId) throw new Error("TARGET_TENANT_REQUIRED");
  if (!input.targetTenantActive || !input.knownTenantIds.includes(input.targetTenantId)) throw new Error("TARGET_TENANT_NOT_ACTIVE");
  if (input.knownTenantIds.some((id) => id !== input.targetTenantId)) throw new Error("UNEXPECTED_TENANT");
  const batchSize = input.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("UNSAFE_BATCH_SIZE");
  if (input.snapshots.length !== BACKFILL_ROOTS.length || BACKFILL_ROOTS.some((root) => !input.snapshots.some((item) => item.root === root))) throw new Error("ROOT_INVENTORY_MISMATCH");

  const roots = BACKFILL_ROOTS.map((root): RootPlan => {
    const rows = [...input.snapshots.find((item) => item.root === root)!.rows].sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`DUPLICATE_PRIMARY_KEY:${root}`);
    const quarantine = rows.flatMap((row): Quarantine[] => {
      if (row.referenceValid === false) return [{ idHash: digest(`${root}\0${row.id}`), reasonCode: "INVALID_REFERENCE" }];
      if (row.ownershipTenantId && row.ownershipTenantId !== input.targetTenantId) return [{ idHash: digest(`${root}\0${row.id}`), reasonCode: "OWNERSHIP_DIVERGENCE" }];
      return [];
    });
    const quarantinedIds = new Set(rows.filter((row) => row.referenceValid === false || (row.ownershipTenantId && row.ownershipTenantId !== input.targetTenantId)).map((row) => row.id));
    const eligible = rows.filter((row) => row.tenantId === null && !quarantinedIds.has(row.id)).map((row) => row.id);
    const batches: BatchPlan[] = [];
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      const ids = eligible.slice(offset, offset + batchSize);
      batches.push({ firstId: ids[0], lastId: ids.at(-1)!, cursorAfter: ids.at(-1)!, ids });
    }
    const divergent = rows.filter((row) => row.tenantId !== null && row.tenantId !== input.targetTenantId).length;
    return { root, targetTenantId: input.targetTenantId, total: rows.length, nullCount: rows.filter((row) => row.tenantId === null).length, assignedCorrectly: rows.filter((row) => row.tenantId === input.targetTenantId).length, divergent, quarantined: quarantine.length, batches, planHash: digest(canonicalMapping(eligible, input.targetTenantId)), quarantine };
  });
  const aggregateHash = digest(roots.map((root) => `${root.root}\t${root.planHash}`).join("\n"));
  return { runId: randomUUID(), contractVersion: BACKFILL_CONTRACT_VERSION, targetTenantId: input.targetTenantId, batchSize, createdAt: input.now ?? new Date().toISOString(), state: roots.some((root) => root.quarantined || root.divergent) ? "quarantined" : "dry_run_passed", roots, aggregateHash };
}

export function assertReconciled(approved: BackfillPlan, after: readonly RootSnapshot[]): void {
  if (!['dry_run_passed', 'approved', 'applying'].includes(approved.state)) throw new Error("PLAN_NOT_APPROVABLE");
  for (const rootPlan of approved.roots) {
    const rows = after.find((item) => item.root === rootPlan.root)?.rows;
    if (!rows || rows.length !== rootPlan.total) throw new Error(`TOTAL_NOT_PRESERVED:${rootPlan.root}`);
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`DUPLICATION_DETECTED:${rootPlan.root}`);
    if (rows.some((row) => row.tenantId !== approved.targetTenantId)) throw new Error(`OWNERSHIP_NOT_RECONCILED:${rootPlan.root}`);
    const approvedIds = rootPlan.batches.flatMap((batch) => batch.ids);
    const appliedIds = rows.filter((row) => approvedIds.includes(row.id) && row.tenantId === approved.targetTenantId).map((row) => row.id).sort((a,b) => a.localeCompare(b));
    const appliedHash = digest(canonicalMapping(appliedIds, approved.targetTenantId));
    if (appliedHash !== rootPlan.planHash) throw new Error(`APPLIED_HASH_MISMATCH:${rootPlan.root}`);
  }
}

export function authorizeSyntheticApply(input: { confirmation?: string; approvedHash?: string; plan: BackfillPlan; syntheticHarness?: boolean }): void {
  if (input.syntheticHarness !== true) throw new Error("PRODUCTION_APPLY_NOT_IMPLEMENTED");
  if (input.confirmation !== "APPLY_SYNTHETIC_FIXTURES") throw new Error("EXPLICIT_CONFIRMATION_REQUIRED");
  if (input.approvedHash !== input.plan.aggregateHash) throw new Error("APPROVED_HASH_MISMATCH");
  if (input.plan.state !== "dry_run_passed") throw new Error("PLAN_NOT_APPLICABLE");
}
