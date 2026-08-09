import { backfillDigest, buildBoundedBatchRanges } from "./backfillTooling.js";
import { TENANT_DATA_READINESS_CONTRACT_VERSION, TENANT_DATA_READINESS_ROOTS, type BlockerCode } from "./tenantDataReadinessPreflight.js";

export const PREFLIGHT_GATED_PLAN_VERSION = "1.0B.2-M/v1";
export const PREFLIGHT_INVENTORY_VERSION = "1.0B.2-A/roots-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/;
const BLOCKER_CODES = new Set<BlockerCode>(["UNKNOWN_TENANT", "AMBIGUOUS_MEMBERSHIP", "MEMBERSHIP_TENANT_INACTIVE", "MEMBERSHIP_TENANT_MISSING", "ROOT_TENANT_MISSING", "CROSS_TENANT_RELATION", "OWNERSHIP_DIVERGENCE", "OWNERSHIP_NULL", "ORPHAN_PARENT", "HASH_INCONSISTENT", "ROOT_MISSING", "ROOT_UNEXPECTED", "PARTIAL_READ"]);

export type GatedRootEvidence = { root: string; total: number; tenantIdFilled: number; tenantIdNull: number; primaryKeyHash: string; classification: "READY" | "BLOCKED" | "QUARANTINE_REQUIRED" };
export type PreflightEvidence = {
  contractVersion: string; generatedAt: string; evidenceId: string; inventoryVersion: string;
  roots: readonly string[];
  controlPlane: { targetTenantId: string; tenantExists: boolean; tenantActive: boolean; membershipAmbiguous: boolean; readComplete: boolean; evidenceEnvironment: "synthetic" | "authorized-non-production" | "production" };
  rootReports: readonly GatedRootEvidence[]; blockers: Readonly<Record<string, number>>;
  quarantineCount: number; aggregateResult: "READY" | "BLOCKED"; evidenceHash: string;
};
export type EvidenceRegistry = { bind(evidenceId: string, evidenceHash: string): "BOUND" | "SAME" | "CONFLICT" };
export function createEvidenceRegistry(): EvidenceRegistry {
  const bindings = new Map<string, string>();
  return { bind(id, hash) { const existing = bindings.get(id); if (existing === undefined) { bindings.set(id, hash); return "BOUND"; } return existing === hash ? "SAME" : "CONFLICT"; } };
}
export type GatedBatch = { ordinal: number; size: number; cursor: string };
export type GatedPlan = { planVersion: string; evidenceId: string; evidenceHash: string; targetTenantId: string; roots: readonly { root: string; total: number; nullCount: number; batches: readonly GatedBatch[]; rootHash: string }[]; blockers: readonly never[]; quarantineCount: 0; dryRunOnly: true; applyAuthorized: false; planHash: string };
export type GatedResult = { status: "READY"; plan: GatedPlan; output: readonly string[] } | { status: "BLOCKED"; blockerCodes: readonly string[]; output: readonly ["PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED"] };

const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
export const computePreflightEvidenceHash = (evidence: Omit<PreflightEvidence, "evidenceHash">) => backfillDigest(canonical({ ...evidence,
  roots: [...evidence.roots].sort((a, b) => TENANT_DATA_READINESS_ROOTS.indexOf(a as never) - TENANT_DATA_READINESS_ROOTS.indexOf(b as never)),
  rootReports: [...evidence.rootReports].sort((a, b) => TENANT_DATA_READINESS_ROOTS.indexOf(a.root as never) - TENANT_DATA_READINESS_ROOTS.indexOf(b.root as never)),
}));
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const blocked = (codes: Iterable<string>): GatedResult => ({ status: "BLOCKED", blockerCodes: [...new Set(codes)].sort(), output: ["PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED"] });

/** Validates immutable evidence and creates a dry-run plan. It has no database or apply capability. */
export function planFromPreflight(raw: unknown, options: { registry?: EvidenceRegistry; now?: Date; maxAgeMs?: number; batchSize?: number; allowSyntheticEvidence?: boolean; allowProductionEvidence?: boolean } = {}): GatedResult {
  const errors: string[] = [];
  const top = ["contractVersion", "generatedAt", "evidenceId", "inventoryVersion", "roots", "controlPlane", "rootReports", "blockers", "quarantineCount", "aggregateResult", "evidenceHash"];
  if (!exactKeys(raw, top)) return blocked(["INVALID_ENVELOPE"]);
  const evidence = raw as PreflightEvidence;
  if (!exactKeys(evidence.controlPlane, ["targetTenantId", "tenantExists", "tenantActive", "membershipAmbiguous", "readComplete", "evidenceEnvironment"])) errors.push("INVALID_CONTROL_PLANE");
  if (evidence.contractVersion !== TENANT_DATA_READINESS_CONTRACT_VERSION || evidence.inventoryVersion !== PREFLIGHT_INVENTORY_VERSION) errors.push("INCOMPATIBLE_VERSION");
  if (!Array.isArray(evidence.roots) || !Array.isArray(evidence.rootReports)) errors.push("INVALID_ENVELOPE");
  else {
    const expected = new Set<string>(TENANT_DATA_READINESS_ROOTS); const seen = new Set<string>();
    for (const root of evidence.roots) { if (seen.has(root)) errors.push("ROOT_DUPLICATE"); seen.add(root); if (!expected.has(root)) errors.push("ROOT_UNEXPECTED"); }
    if (TENANT_DATA_READINESS_ROOTS.some((root) => !seen.has(root))) errors.push("ROOT_MISSING");
    const reportSeen = new Set<string>();
    for (const candidate of evidence.rootReports) {
      if (!exactKeys(candidate, ["root", "total", "tenantIdFilled", "tenantIdNull", "primaryKeyHash", "classification"])) { errors.push("INVALID_ROOT_REPORT"); continue; }
      const report = candidate as GatedRootEvidence;
      if (reportSeen.has(report.root)) errors.push("ROOT_DUPLICATE"); reportSeen.add(report.root);
      if (!expected.has(report.root)) errors.push("ROOT_UNEXPECTED");
      if (![report.total, report.tenantIdFilled, report.tenantIdNull].every((n) => Number.isSafeInteger(n) && n >= 0) || report.total !== report.tenantIdFilled + report.tenantIdNull) errors.push("INCONSISTENT_TOTAL");
      if (!HEX.test(report.primaryKeyHash) || report.classification !== "READY") errors.push("ROOT_NOT_READY");
    }
    if (TENANT_DATA_READINESS_ROOTS.some((root) => !reportSeen.has(root)) || evidence.rootReports.length !== TENANT_DATA_READINESS_ROOTS.length) errors.push("PARTIAL_REPORT");
  }
  if (!exactKeys(evidence.blockers, [...BLOCKER_CODES])) errors.push("INVALID_BLOCKERS");
  else for (const [code, count] of Object.entries(evidence.blockers)) if (!BLOCKER_CODES.has(code as BlockerCode) || !Number.isSafeInteger(count) || count < 0 || count !== 0) errors.push("BLOCKER_PRESENT");
  if (evidence.aggregateResult !== "READY") errors.push("AGGREGATE_NOT_READY");
  if (evidence.quarantineCount !== 0) errors.push("QUARANTINE_PRESENT");
  if (!evidence.controlPlane?.tenantExists || !evidence.controlPlane?.tenantActive || !evidence.controlPlane?.targetTenantId) errors.push("TARGET_TENANT_NOT_ACTIVE");
  if (evidence.controlPlane?.membershipAmbiguous) errors.push("AMBIGUOUS_MEMBERSHIP");
  if (!evidence.controlPlane?.readComplete) errors.push("PARTIAL_READ");
  if ((evidence.controlPlane?.evidenceEnvironment === "synthetic" && options.allowSyntheticEvidence !== true) || (evidence.controlPlane?.evidenceEnvironment === "production" && options.allowProductionEvidence !== true)) errors.push("EVIDENCE_ENVIRONMENT_FORBIDDEN");
  const generated = Date.parse(evidence.generatedAt); const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(generated) || generated > now || now - generated > (options.maxAgeMs ?? MAX_AGE_MS)) errors.push("EVIDENCE_EXPIRED");
  if (!evidence.evidenceId || !HEX.test(evidence.evidenceHash)) errors.push("INVALID_EVIDENCE_ID_OR_HASH");
  else { const { evidenceHash: _, ...unsigned } = evidence; if (computePreflightEvidenceHash(unsigned) !== evidence.evidenceHash) errors.push("EVIDENCE_HASH_MISMATCH"); }
  if (!options.registry) errors.push("SHARED_EVIDENCE_REGISTRY_REQUIRED");
  const batchSize = options.batchSize ?? 250; if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) errors.push("UNSAFE_BATCH_SIZE");
  if (errors.length) return blocked(errors);
  if (options.registry!.bind(evidence.evidenceId, evidence.evidenceHash) === "CONFLICT") return blocked(["EVIDENCE_ID_REUSED"]);
  const reports = new Map(evidence.rootReports.map((item) => [item.root, item]));
  const roots = TENANT_DATA_READINESS_ROOTS.map((root) => { const report = reports.get(root)!; const rootHash = backfillDigest(`${evidence.evidenceHash}\t${root}\t${report.total}\t${report.tenantIdNull}\t${report.primaryKeyHash}`); return { root, total: report.total, nullCount: report.tenantIdNull, batches: buildBoundedBatchRanges(report.tenantIdNull, batchSize).map(({ ordinal, size }) => ({ ordinal, size, cursor: backfillDigest(`${rootHash}\t${ordinal}\t${size}`) })), rootHash }; });
  const unsignedPlan = { planVersion: PREFLIGHT_GATED_PLAN_VERSION, evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash, targetTenantId: evidence.controlPlane.targetTenantId, roots, blockers: [] as never[], quarantineCount: 0 as const, dryRunOnly: true as const, applyAuthorized: false as const };
  const plan = { ...unsignedPlan, planHash: backfillDigest(canonical(unsignedPlan)) };
  return { status: "READY", plan, output: ["PREFLIGHT_GATED_BACKFILL_PLAN=READY", `PREFLIGHT_GATED_BACKFILL_PLAN_HASH=${plan.planHash}`] };
}
