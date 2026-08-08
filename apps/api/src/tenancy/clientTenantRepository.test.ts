import assert from "node:assert/strict";
import { ClientTenantRepository, type ClientTenantDelegate } from "./clientTenantRepository.js";
import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError } from "./tenantDataAccess.js";

type Row = { id: string; tenantId: string | null; name: string; createdAt: string; [key: string]: unknown };
const rows: Row[] = [
  { id: "client-a", tenantId: "tenant-a", name: "Synthetic A", createdAt: "2026-01-01" },
  { id: "client-b", tenantId: "tenant-b", name: "Synthetic B", createdAt: "2026-01-02" },
];
const calls: Array<{ operation: string; args: unknown }> = [];
const delegate: ClientTenantDelegate = {
  async findMany(args) { calls.push({ operation: "findMany", args }); return rows.filter((row) => row.tenantId === args.where.tenantId && (!args.where.id || row.id === args.where.id)); },
  async findFirst(args) { calls.push({ operation: "findFirst", args }); return rows.find((row) => row.id === args.where.id && row.tenantId === args.where.tenantId) ?? null; },
  async create(args) { calls.push({ operation: "create", args }); const row = { id: `client-${rows.length + 1}`, createdAt: "2026-01-03", ...args.data } as Row; rows.push(row); return row; },
  async updateMany(args) { calls.push({ operation: "updateMany", args }); const found = rows.find((row) => row.id === args.where.id && row.tenantId === args.where.tenantId); if (!found) return { count: 0 }; Object.assign(found, args.data); return { count: 1 }; },
  async deleteMany(args) { calls.push({ operation: "deleteMany", args }); const index = rows.findIndex((row) => row.id === args.where.id && row.tenantId === args.where.tenantId); if (index < 0) return { count: 0 }; rows.splice(index, 1); return { count: 1 }; },
  async count(args) { calls.push({ operation: "count", args }); return rows.filter((row) => row.tenantId === args.where.tenantId).length; },
};
const context = (tenantId: string, userId: string): AuthTenantContext => Object.freeze({
  tenantId, userId, membershipId: `membership-${tenantId}`, membershipStatus: "active", membershipRole: "vendedor",
  legacyUserRole: "vendedor", resolutionSource: "synthetic_test", contextVersion: 1,
});
const contextA = context("tenant-a", "user-a");
const contextB = context("tenant-b", "user-b");
const repository = new ClientTenantRepository(delegate);

assert.deepEqual((await repository.list(contextA)).map(({ id }) => id), ["client-a"]);
assert.deepEqual((await repository.list(contextB)).map(({ id }) => id), ["client-b"]);
assert.equal((await repository.findById(contextA, "client-a"))?.tenantId, "tenant-a");
assert.equal((await repository.findById(contextB, "client-b"))?.tenantId, "tenant-b");
assert.equal(await repository.findById(contextA, "client-b"), null);
assert.equal(await repository.findById(contextB, "client-a"), null);
assert.equal(await repository.updateById(contextA, "client-b", { name: "cross-tenant" }), false);
assert.equal(await repository.updateById(contextB, "client-a", { name: "cross-tenant" }), false);
assert.equal(await repository.updateById(contextA, "client-a", { name: "Updated A" }), true);

const createdA = await repository.create(contextA, { name: "Created A" });
assert.equal(createdA.tenantId, "tenant-a");
assert.throws(() => repository.create(contextA, { name: "Divergent", tenantId: "tenant-b" }), TenantDataAccessError);
await assert.rejects(repository.updateById(contextA, "client-a", { tenantId: "tenant-b" } as never), TenantDataAccessError);
assert.equal(await repository.deleteById(contextA, "client-b"), false);
assert.equal(await repository.deleteById(contextB, "client-b"), true);
assert.equal(await repository.count(contextA), 2);
assert.equal(await repository.count(contextB), 0);

const [concurrentA, concurrentB] = await Promise.all([repository.list(contextA), repository.list(contextB)]);
assert.ok(concurrentA.every((row) => row.tenantId === "tenant-a"));
assert.ok(concurrentB.every((row) => row.tenantId === "tenant-b"));
assert.throws(() => repository.list(undefined as never), TenantDataAccessError);
assert.throws(() => repository.list({ ...contextA, contextVersion: 2 } as never), TenantDataAccessError);

for (const call of calls.filter(({ operation }) => operation !== "create")) {
  const where = (call.args as { where: { tenantId?: string } }).where;
  assert.ok(where.tenantId === "tenant-a" || where.tenantId === "tenant-b", `${call.operation} must send tenantId to Prisma`);
}
for (const operation of ["findFirst", "updateMany", "deleteMany"]) {
  for (const call of calls.filter((item) => item.operation === operation)) {
    assert.equal(typeof (call.args as { where: { id?: string } }).where.id, "string", `${operation} must compose id with tenantId`);
  }
}
assert.ok(calls.filter(({ operation }) => operation === "create").every((call) => (call.args as { data: { tenantId: string } }).data.tenantId.startsWith("tenant-")));

console.log("TENANT_DATA_ACCESS_A_X_B=PASS");
