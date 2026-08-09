import assert from "node:assert/strict";
import { TENANT_DATA_READINESS_ROOTS, runTenantDataReadinessPreflight, serializeTenantDataReadiness, type RootFact, type TenantDataReadinessReader } from "./tenantDataReadinessPreflight.js";

const makeReader = (options: { roots?: readonly string[]; rows?: Partial<Record<string, readonly RootFact[]>>; tamper?: string; fail?: string; ambiguous?: boolean; suspended?: boolean } = {}): TenantDataReadinessReader => ({
  async readControlPlane() { return {
    tenants: [{ id: "tenant-a", active: true }, ...(options.suspended ? [{ id: "tenant-b", active: false }] : [])],
    users: [{ id: "user-active", active: true }, { id: "user-inactive", active: false }],
    memberships: [
      { id: "membership-a", userId: "user-active", tenantId: "tenant-a", active: true },
      ...(options.ambiguous ? [{ id: "membership-b", userId: "user-active", tenantId: options.suspended ? "tenant-b" : "tenant-a", active: true }] : []),
    ],
  }; },
  async listRoots() { return options.roots ?? TENANT_DATA_READINESS_ROOTS; },
  async readRoot(root) {
    if (options.fail === root) throw new Error("synthetic read failure");
    return { root, rows: options.rows?.[root] ?? [{ id: `${root}-pk`, tenantId: "tenant-a", ownershipTenantIds: ["tenant-a"], parentExists: true }],
      ...(options.tamper === root ? { evidenceHash: "0".repeat(64) } : {}) };
  },
});

const ready = await runTenantDataReadinessPreflight(makeReader());
assert.equal(ready.result, "READY");
assert.equal(ready.rootsEvaluated, 11);
assert.equal(ready.controlPlane.activeUsers, 1);
assert.equal(ready.controlPlane.inactiveUsers, 1);
assert.equal(ready.controlPlane.usersWithoutMembership, 1);
assert.equal(ready.controlPlane.defaultOnlyCompatible, true);
assert.equal(ready.roots.every((root) => root.classification === "READY"), true);

const nullPending = await runTenantDataReadinessPreflight(makeReader({ rows: { Client: [{ id: "null-pending", tenantId: null }] } }));
assert.equal(nullPending.result, "READY", "NULL is a backfill pending count, not global access or automatic repair");
assert.equal(nullPending.roots.find((root) => root.root === "Client")?.tenantIdNull, 1);

const integrity = await runTenantDataReadinessPreflight(makeReader({ suspended: true, ambiguous: true, rows: { Client: [
  { id: "cross", tenantId: "tenant-a", ownershipTenantIds: ["tenant-b"] },
  { id: "orphan", tenantId: "missing", ownershipTenantIds: [null], parentExists: false },
] } }));
assert.equal(integrity.result, "BLOCKED");
assert.equal(integrity.blockers.AMBIGUOUS_MEMBERSHIP, 1);
assert.equal(integrity.blockers.MEMBERSHIP_TENANT_INACTIVE, 1);
assert.equal(integrity.blockers.CROSS_TENANT_RELATION, 1);
assert.equal(integrity.blockers.OWNERSHIP_DIVERGENCE, 1);
assert.equal(integrity.blockers.OWNERSHIP_NULL, 1);
assert.equal(integrity.blockers.ROOT_TENANT_MISSING, 1);
assert.equal(integrity.roots.find((root) => root.root === "Client")?.classification, "QUARANTINE_REQUIRED");

const missing = await runTenantDataReadinessPreflight(makeReader({ roots: TENANT_DATA_READINESS_ROOTS.slice(1) }));
assert.equal(missing.blockers.ROOT_MISSING, 1);
assert.equal(missing.result, "BLOCKED");
const unexpected = await runTenantDataReadinessPreflight(makeReader({ roots: [...TENANT_DATA_READINESS_ROOTS, "UnexpectedRoot"] }));
assert.equal(unexpected.blockers.ROOT_UNEXPECTED, 1);
const tampered = await runTenantDataReadinessPreflight(makeReader({ tamper: "Product" }));
assert.equal(tampered.blockers.HASH_INCONSISTENT, 1);
const partial = await runTenantDataReadinessPreflight(makeReader({ fail: "Sale" }));
assert.equal(partial.blockers.PARTIAL_READ, 1);
assert.equal(partial.result, "BLOCKED");

const [concurrentA, concurrentB] = await Promise.all([
  runTenantDataReadinessPreflight(makeReader()),
  runTenantDataReadinessPreflight(makeReader({ rows: { Client: [{ id: "isolated-b", tenantId: null }] } })),
]);
assert.notEqual(concurrentA.roots.find((root) => root.root === "Client")?.primaryKeyHash, concurrentB.roots.find((root) => root.root === "Client")?.primaryKeyHash);
assert.equal(concurrentA.roots.find((root) => root.root === "Client")?.tenantIdNull, 0);
assert.equal(concurrentB.roots.find((root) => root.root === "Client")?.tenantIdNull, 1);

const output = serializeTenantDataReadiness(integrity);
assert.match(output, /^TENANT_DATA_READINESS_PREFLIGHT=/);
for (const forbidden of ["email", "password", "token", "connection", "payload", "tenant-a", "user-active"]) assert.equal(output.includes(forbidden), false);
console.log("TENANT_DATA_READINESS_UNIT=PASS");
