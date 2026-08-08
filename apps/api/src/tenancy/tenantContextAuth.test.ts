import assert from "node:assert/strict";
import { resolveTenantContext, sanitizeTenantContext, TenantContextError, type MembershipRecord, type TenantControlPlaneReader, type TenantRecord, type VerifiedTenantClaims } from "./tenantContext.js";

const tenantA: TenantRecord = { id: "synthetic-tenant-a", slug: "tenant-a", status: "active" };
const tenantB: TenantRecord = { id: "synthetic-tenant-b", slug: "tenant-b", status: "active" };
const suspended: TenantRecord = { id: "synthetic-tenant-suspended", status: "suspended" };
const membership = (id: string, tenantId: string, userId: string, status: MembershipRecord["status"] = "active", role: MembershipRecord["role"] = "vendedor"): MembershipRecord =>
  ({ id, tenantId, userId, role, status, version: 1 });
const membershipA = membership("membership-a", tenantA.id, "user-a", "active", "gerente");
const membershipB = membership("membership-b", tenantB.id, "user-b");
const membershipBothA = membership("membership-both-a", tenantA.id, "user-both");
const membershipBothB = membership("membership-both-b", tenantB.id, "user-both");
const inactive = membership("membership-inactive", tenantA.id, "user-inactive", "revoked");
const tenants = new Map([tenantA, tenantB, suspended].map((item) => [item.id, item]));
const memberships = [membershipA, membershipB, membershipBothA, membershipBothB, inactive];
const reader: TenantControlPlaneReader = {
  findTenant: async (id) => tenants.get(id) ?? null,
  findMembership: async (id) => memberships.find((item) => item.id === id) ?? null,
  findMembershipsForUser: async (userId) => memberships.filter((item) => item.userId === userId),
};
const aware = (item: MembershipRecord, legacyUserRole: VerifiedTenantClaims["legacyUserRole"] = item.role): VerifiedTenantClaims => ({
  userId: item.userId, legacyUserRole, tenantId: item.tenantId, membershipId: item.id, membershipVersion: item.version, contextVersion: 1,
});
const options = { legacyCompatibility: "default-only" as const, defaultTenantId: tenantA.id };
const denied = (promise: Promise<unknown>, code: TenantContextError["code"] = "TENANT_DENIED") =>
  assert.rejects(promise, (error: unknown) => error instanceof TenantContextError && error.code === code);

const contextA = await resolveTenantContext(aware(membershipA), reader, options);
const contextB = await resolveTenantContext(aware(membershipB), reader, options);
assert.equal(contextA.tenantId, tenantA.id);
assert.equal(contextB.tenantId, tenantB.id);
assert.equal(contextA.resolutionSource, "tenant_claim");
assert.equal(contextA.legacyUserRole, "gerente", "User.role remains the legacy authority");
assert.equal(contextA.membershipRole, "gerente", "membership role is reconciled but does not replace User.role");
assert(Object.isFrozen(contextA));

await denied(resolveTenantContext({ ...aware(membershipBothB), tenantId: tenantA.id }, reader, options));
await denied(resolveTenantContext({ ...aware(membershipA), tenantId: "missing" }, reader, options));
await denied(resolveTenantContext({ ...aware(membershipA), tenantId: suspended.id }, reader, options));
await denied(resolveTenantContext(aware(inactive), reader, options));
await denied(resolveTenantContext({ ...aware(membershipA), membershipId: "tampered" }, reader, options));
await denied(resolveTenantContext(aware(membershipA, "diretor"), reader, options));
await denied(resolveTenantContext({ ...aware(membershipA), contextVersion: 2 }, reader, options), "TENANT_CLAIM_INVALID");

const legacy = await resolveTenantContext({ userId: membershipA.userId, legacyUserRole: "diretor" }, reader, options);
assert.equal(legacy.resolutionSource, "legacy_default_only");
await denied(resolveTenantContext({ userId: "user-both", legacyUserRole: "vendedor" }, reader, options), "TENANT_AMBIGUOUS");
await denied(resolveTenantContext({ userId: "user-inactive", legacyUserRole: "vendedor" }, reader, options));
await denied(resolveTenantContext({ userId: membershipA.userId, legacyUserRole: "diretor" }, reader, { legacyCompatibility: "disabled" }), "TENANT_REQUIRED");

// An untrusted header is never passed to the resolver and therefore cannot override an authenticated claim.
const divergentHeader = tenantB.id;
assert.equal((await resolveTenantContext(aware(membershipA), reader, options)).tenantId, tenantA.id);
assert.notEqual(contextA.tenantId, divergentHeader);

const [concurrentA, concurrentB] = await Promise.all([
  resolveTenantContext(aware(membershipA), reader, options),
  resolveTenantContext(aware(membershipB), reader, options),
]);
assert.notStrictEqual(concurrentA, concurrentB);
assert.deepEqual([concurrentA.tenantId, concurrentB.tenantId], [tenantA.id, tenantB.id]);

const safe = sanitizeTenantContext(contextA);
assert.deepEqual(Object.keys(safe).sort(), ["contextVersion", "membershipId", "membershipStatus", "resolutionSource", "tenantId"]);
for (const forbidden of ["token", "email", "documento", "payload", "password", "DATABASE_URL"]) assert(!JSON.stringify(safe).includes(forbidden));

console.log("TENANT_CONTEXT_AUTH=PASS");
