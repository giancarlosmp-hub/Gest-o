import assert from "node:assert/strict";
import { ActivityTenantRepository, type ActivityTenantTransaction } from "./activityTenantRepository.js";
import { OpportunityTenantRepository, type OpportunityTenantTransaction } from "./opportunityTenantRepository.js";
import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError } from "./tenantDataAccess.js";

const context = (tenantId: string): AuthTenantContext => Object.freeze({ tenantId, userId: `user-${tenantId}`, membershipId: `membership-${tenantId}`, membershipStatus: "active", membershipRole: "vendedor", legacyUserRole: "vendedor", resolutionSource: "synthetic_test", contextVersion: 1 });
const contextA = context("tenant-a");
const contextB = context("tenant-b");
const clients = [
  { id: "client-a1", tenantId: "tenant-a" },
  { id: "client-a2", tenantId: "tenant-a" },
  { id: "client-a-null", tenantId: null },
  { id: "client-b", tenantId: "tenant-b" },
];
const opportunities = [
  { id: "opportunity-a1", clientId: "client-a1", value: 10 },
  { id: "opportunity-a2", clientId: "client-a2", value: 20 },
  { id: "opportunity-a-move", clientId: "client-a1", value: 30 },
  { id: "opportunity-b", clientId: "client-b", value: 40 },
];
const activities = [
  { id: "activity-client-a", clientId: "client-a1", opportunityId: null, duration: 1 },
  { id: "activity-opportunity-a", clientId: null, opportunityId: "opportunity-a1", duration: 2 },
  { id: "activity-client-b", clientId: "client-b", opportunityId: null, duration: 4 },
  { id: "activity-opportunity-b", clientId: null, opportunityId: "opportunity-b", duration: 8 },
  { id: "activity-dual-same-client", clientId: "client-a1", opportunityId: "opportunity-a1", duration: 16 },
  { id: "activity-dual-divergent-same-tenant", clientId: "client-a1", opportunityId: "opportunity-a2", duration: 32 },
  { id: "activity-dual-cross-tenant", clientId: "client-a1", opportunityId: "opportunity-b", duration: 64 },
  { id: "activity-orphan", clientId: null, opportunityId: null, duration: 128 },
  { id: "activity-null-tenant-parent", clientId: "client-a-null", opportunityId: null, duration: 256 },
];
const calls: Array<{ operation: string; args: any }> = [];
const clientTenant = (id: string | null) => clients.find((row) => row.id === id)?.tenantId;
const opportunityTenant = (id: string | null) => clientTenant(opportunities.find((row) => row.id === id)?.clientId ?? null);
// Model the documented database-executable XOR policy, not merely same-tenant parent membership.
const activityOwned = (row: typeof activities[number], tenantId: string) => {
  const hasClient = row.clientId !== null;
  const hasOpportunity = row.opportunityId !== null;
  if (hasClient === hasOpportunity) return false;
  return hasClient ? clientTenant(row.clientId) === tenantId : opportunityTenant(row.opportunityId) === tenantId;
};
const opportunityScopeTenant = (where: any): string => where.client.tenantId;
const activityScopeTenant = (where: any): string => where.OR[0].client.tenantId;

const tx: OpportunityTenantTransaction & ActivityTenantTransaction = {
  client: { async findFirst(args) { calls.push({ operation: "client.findFirst", args }); return clients.find((row) => row.id === args.where.id && row.tenantId === args.where.tenantId) ?? null; } },
  opportunity: {
    async findMany(args: any) { calls.push({ operation: "opportunity.findMany", args }); return opportunities.filter((row) => clientTenant(row.clientId) === opportunityScopeTenant(args.where)); },
    async findFirst(args: any) { calls.push({ operation: "opportunity.findFirst", args }); const tenantId = opportunityScopeTenant(args.where); return opportunities.find((row) => row.id === args.where.id && clientTenant(row.clientId) === tenantId) ?? null; },
    async create(args: any) { calls.push({ operation: "opportunity.create", args }); const row = { id: "opportunity-created", value: 0, ...args.data }; opportunities.push(row); return row; },
    async updateMany(args: any) { calls.push({ operation: "opportunity.updateMany", args }); const row = opportunities.find((item) => item.id === args.where.id && clientTenant(item.clientId) === opportunityScopeTenant(args.where)); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
    async deleteMany(args: any) { calls.push({ operation: "opportunity.deleteMany", args }); const index = opportunities.findIndex((item) => item.id === args.where.id && clientTenant(item.clientId) === opportunityScopeTenant(args.where)); if (index < 0) return { count: 0 }; opportunities.splice(index, 1); return { count: 1 }; },
    async count(args: any) { calls.push({ operation: "opportunity.count", args }); return opportunities.filter((row) => clientTenant(row.clientId) === opportunityScopeTenant(args.where)).length; },
    async aggregate(args: any) { calls.push({ operation: "opportunity.aggregate", args }); const rows = opportunities.filter((row) => clientTenant(row.clientId) === opportunityScopeTenant(args.where)); return { _count: rows.length, _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) } }; },
  },
  activity: {
    async findMany(args) { calls.push({ operation: "activity.findMany", args }); return activities.filter((row) => activityOwned(row, activityScopeTenant(args.where))); },
    async findFirst(args) { calls.push({ operation: "activity.findFirst", args }); return activities.find((row) => row.id === args.where.id && activityOwned(row, activityScopeTenant(args.where))) ?? null; },
    async create(args) { calls.push({ operation: "activity.create", args }); const row = { id: "activity-created", duration: 0, ...args.data }; activities.push(row); return row; },
    async updateMany(args) { calls.push({ operation: "activity.updateMany", args }); const row = activities.find((item) => item.id === args.where.id && activityOwned(item, activityScopeTenant(args.where))); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
    async deleteMany(args) { calls.push({ operation: "activity.deleteMany", args }); const index = activities.findIndex((item) => item.id === args.where.id && activityOwned(item, activityScopeTenant(args.where))); if (index < 0) return { count: 0 }; activities.splice(index, 1); return { count: 1 }; },
    async count(args) { calls.push({ operation: "activity.count", args }); return activities.filter((row) => activityOwned(row, activityScopeTenant(args.where))).length; },
    async aggregate(args) { calls.push({ operation: "activity.aggregate", args }); const rows = activities.filter((row) => activityOwned(row, activityScopeTenant(args.where))); return { _count: rows.length, _sum: { duration: rows.reduce((sum, row) => sum + row.duration, 0) } }; },
  },
};
const database = { async $transaction<T>(operation: (transaction: typeof tx) => Promise<T>) { calls.push({ operation: "$transaction", args: {} }); return operation(tx); } };
const opportunityRepository = new OpportunityTenantRepository(database);
const activityRepository = new ActivityTenantRepository(database);

assert.deepEqual((await opportunityRepository.list(contextA)).map((row) => row.id), ["opportunity-a1", "opportunity-a2", "opportunity-a-move"]);
assert.deepEqual((await opportunityRepository.list(contextB)).map((row) => row.id), ["opportunity-b"]);
assert.equal(await opportunityRepository.findById(contextA, "opportunity-b"), null);
assert.equal(await opportunityRepository.updateById(contextA, "opportunity-b", { title: "denied" }), false);
assert.equal(await opportunityRepository.deleteById(contextB, "opportunity-a1"), false);
await assert.rejects(opportunityRepository.moveToClient(contextA, "opportunity-a-move", "client-b"), TenantDataAccessError);
assert.equal(await opportunityRepository.moveToClient(contextA, "opportunity-a-move", "client-a2"), true);

assert.deepEqual((await activityRepository.list(contextA)).map((row) => row.id), ["activity-client-a", "activity-opportunity-a"]);
assert.deepEqual((await activityRepository.list(contextB)).map((row) => row.id), ["activity-client-b", "activity-opportunity-b"]);
assert.equal(await activityRepository.count(contextA), 2);
assert.equal(await activityRepository.count(contextB), 2);
assert.deepEqual(await activityRepository.aggregate(contextA), { _count: 2, _sum: { duration: 3 } });
assert.deepEqual(await activityRepository.aggregate(contextB), { _count: 2, _sum: { duration: 12 } });

const deniedActivityIds = ["activity-dual-same-client", "activity-dual-divergent-same-tenant", "activity-dual-cross-tenant", "activity-orphan", "activity-null-tenant-parent"];
for (const id of deniedActivityIds) {
  assert.equal(await activityRepository.findById(contextA, id), null, `${id} read must be denied`);
  assert.equal(await activityRepository.updateById(contextA, id, { done: true }), false, `${id} update must be denied`);
  assert.equal(await activityRepository.deleteById(contextA, id), false, `${id} delete must be denied`);
}
assert.equal(await activityRepository.findById(contextA, "activity-client-b"), null);
assert.equal(await activityRepository.updateById(contextA, "activity-opportunity-b", { done: true }), false);
assert.equal(await activityRepository.deleteById(contextB, "activity-client-a"), false);

const deniedLinks = [
  { clientId: null, opportunityId: null },
  { clientId: "client-a1", opportunityId: "opportunity-a1" },
  { clientId: "client-a1", opportunityId: "opportunity-a2" },
  { clientId: "client-a1", opportunityId: "opportunity-b" },
  { clientId: "client-a-null", opportunityId: null },
  { clientId: "client-b", opportunityId: null },
];
for (const links of deniedLinks) {
  await assert.rejects(activityRepository.create(contextA, { ...links, notes: "denied" }), TenantDataAccessError);
  await assert.rejects(activityRepository.relink(contextA, "activity-client-a", links), TenantDataAccessError);
}
const created = await activityRepository.create(contextA, { clientId: null, opportunityId: "opportunity-a1", notes: "allowed" });
assert.equal(created.opportunityId, "opportunity-a1");
assert.equal(await activityRepository.relink(contextA, "activity-client-a", { clientId: null, opportunityId: "opportunity-a1" }), true);

const [parallelA, parallelB] = await Promise.all([activityRepository.list(contextA), activityRepository.list(contextB)]);
assert.ok(parallelA.every((row) => activityOwned(row as any, "tenant-a")));
assert.ok(parallelB.every((row) => activityOwned(row as any, "tenant-b")));
const beforeInvalid = calls.length;
assert.throws(() => activityRepository.list(undefined as never), TenantDataAccessError);
assert.throws(() => opportunityRepository.list({ ...contextA, contextVersion: 99 } as never), TenantDataAccessError);
assert.equal(calls.length, beforeInvalid);

for (const call of calls.filter((item) => /^(opportunity|activity)\.(find|update|delete|count|aggregate)/.test(item.operation))) {
  assert.ok(call.args.where.client?.tenantId || call.args.where.OR, `${call.operation} must send relational ownership to Prisma`);
  if (/findFirst|updateMany|deleteMany/.test(call.operation)) assert.equal(typeof call.args.where.id, "string");
}
const activityScopes = calls.filter((call) => call.operation.startsWith("activity.") && call.args.where).map((call) => call.args.where);
assert.ok(activityScopes.every((where) => where.OR.length === 2));
assert.ok(activityScopes.every((where) => where.OR[0].opportunityId === null && where.OR[1].clientId === null));
console.log("TENANT_RELATIONAL_OWNERSHIP_A_X_B=PASS");
