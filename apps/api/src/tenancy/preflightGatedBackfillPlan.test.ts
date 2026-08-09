import assert from "node:assert/strict";
import { TENANT_DATA_READINESS_ROOTS } from "./tenantDataReadinessPreflight.js";
import { computePreflightEvidenceHash, createEvidenceRegistry, planFromPreflight, PREFLIGHT_INVENTORY_VERSION, type PreflightEvidence } from "./preflightGatedBackfillPlan.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const blockerKeys = ["UNKNOWN_TENANT", "AMBIGUOUS_MEMBERSHIP", "MEMBERSHIP_TENANT_INACTIVE", "MEMBERSHIP_TENANT_MISSING", "ROOT_TENANT_MISSING", "CROSS_TENANT_RELATION", "OWNERSHIP_DIVERGENCE", "OWNERSHIP_NULL", "ORPHAN_PARENT", "HASH_INCONSISTENT", "ROOT_MISSING", "ROOT_UNEXPECTED", "PARTIAL_READ"];
const makeEvidence = (order: readonly string[] = TENANT_DATA_READINESS_ROOTS): PreflightEvidence => {
  const unsigned: Omit<PreflightEvidence, "evidenceHash"> = { contractVersion: "1.0B.2-L/v1", generatedAt: "2026-08-09T11:00:00.000Z", evidenceId: "ev-ready-001", inventoryVersion: PREFLIGHT_INVENTORY_VERSION, roots: order,
    controlPlane: { targetTenantId: "tenant-default-v1", tenantExists: true, tenantActive: true, membershipAmbiguous: false, readComplete: true, evidenceEnvironment: "synthetic" },
    rootReports: order.map((root, index) => ({ root, total: index + 2, tenantIdFilled: 1, tenantIdNull: index + 1, primaryKeyHash: "a".repeat(64), classification: "READY" })),
    blockers: Object.fromEntries(blockerKeys.map((key) => [key, 0])), quarantineCount: 0, aggregateResult: "READY" };
  return { ...unsigned, evidenceHash: computePreflightEvidenceHash(unsigned) };
};
const resign = (e: PreflightEvidence): PreflightEvidence => { const { evidenceHash: _, ...unsigned } = e; return { ...unsigned, evidenceHash: computePreflightEvidenceHash(unsigned) }; };
const plan = (e: unknown, registry = createEvidenceRegistry()) => planFromPreflight(e, { registry, now: NOW, allowSyntheticEvidence: true, batchSize: 3 });
const ready = makeEvidence(); const first = plan(ready); assert.equal(first.status, "READY");
if (first.status !== "READY") throw new Error("unreachable");
assert.equal(first.plan.roots.length, 11); assert.equal(first.plan.applyAuthorized, false); assert.equal(first.plan.dryRunOnly, true);
assert.equal(first.plan.blockers.length, 0); assert.equal(first.plan.quarantineCount, 0); assert.match(first.plan.planHash, /^[a-f0-9]{64}$/);
const repeat = plan(ready); assert.equal(repeat.status, "READY"); if (repeat.status === "READY") assert.equal(repeat.plan.planHash, first.plan.planHash);
const reversed = resign({ ...ready, roots: [...ready.roots].reverse(), rootReports: [...ready.rootReports].reverse() }); const canonical = plan(reversed); assert.equal(canonical.status, "READY"); if (canonical.status === "READY") assert.equal(canonical.plan.planHash, first.plan.planHash);

const blockedExpected = resign({ ...makeEvidence(), aggregateResult: "BLOCKED", blockers: { ...makeEvidence().blockers, OWNERSHIP_NULL: 1 } });
const refused = plan(blockedExpected); assert.equal(refused.status, "BLOCKED"); if (refused.status === "BLOCKED") { assert.deepEqual(refused.output, ["PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED"]); assert.equal("plan" in refused, false); }
const negative = (mutate: (e: PreflightEvidence) => PreflightEvidence, code: string, resignAfter = true) => { let e = mutate(makeEvidence()); if (resignAfter) e = resign(e); const result = plan(e); assert.equal(result.status, "BLOCKED", code); if (result.status === "BLOCKED") assert.ok(result.blockerCodes.includes(code), `${code}: ${result.blockerCodes}`); };
negative((e) => ({ ...e, evidenceHash: "0".repeat(64) }), "EVIDENCE_HASH_MISMATCH", false);
negative((e) => ({ ...e, evidenceId: "different" }), "EVIDENCE_HASH_MISMATCH", false);
negative((e) => ({ ...e, generatedAt: "2026-08-01T00:00:00Z" }), "EVIDENCE_EXPIRED");
negative((e) => ({ ...e, contractVersion: "unknown" }), "INCOMPATIBLE_VERSION");
negative((e) => ({ ...e, roots: e.roots.slice(1), rootReports: e.rootReports.slice(1) }), "ROOT_MISSING");
negative((e) => ({ ...e, roots: [...e.roots, "Unexpected"], rootReports: [...e.rootReports, { ...e.rootReports[0], root: "Unexpected" }] }), "ROOT_UNEXPECTED");
negative((e) => ({ ...e, roots: [...e.roots.slice(0, -1), e.roots[0]] }), "ROOT_DUPLICATE");
negative((e) => ({ ...e, blockers: { ...e.blockers, PARTIAL_READ: 1 } }), "BLOCKER_PRESENT");
negative((e) => ({ ...e, quarantineCount: 1 }), "QUARANTINE_PRESENT");
negative((e) => ({ ...e, rootReports: e.rootReports.map((r, i) => i ? r : { ...r, total: r.total + 1 }) }), "INCONSISTENT_TOTAL");
negative((e) => ({ ...e, controlPlane: { ...e.controlPlane, tenantActive: false } }), "TARGET_TENANT_NOT_ACTIVE");
negative((e) => ({ ...e, controlPlane: { ...e.controlPlane, membershipAmbiguous: true } }), "AMBIGUOUS_MEMBERSHIP");
assert.equal(planFromPreflight(makeEvidence(), { registry: createEvidenceRegistry(), now: NOW }).status, "BLOCKED", "synthetic cannot pose as productive evidence");
assert.equal((first.plan as { applyAuthorized: boolean }).applyAuthorized, false, "apply cannot be authorized");
assert.equal(plan({ ...makeEvidence(), extra: true }).status, "BLOCKED");
assert.equal(planFromPreflight(makeEvidence(), { now: NOW, allowSyntheticEvidence: true }).status, "BLOCKED", "concurrent planning requires shared registry");
const registry = createEvidenceRegistry(); assert.equal(plan(ready, registry).status, "READY"); const replay = resign({ ...ready, generatedAt: "2026-08-09T11:01:00.000Z" }); const replayResult = plan(replay, registry); assert.equal(replayResult.status, "BLOCKED"); if (replayResult.status === "BLOCKED") assert.ok(replayResult.blockerCodes.includes("EVIDENCE_ID_REUSED"));
console.log("PREFLIGHT_GATED_BACKFILL_PLAN_UNIT=PASS");
