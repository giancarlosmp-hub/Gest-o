import assert from "node:assert/strict";
import { ActivityTenantRepository, type ActivityTenantTransaction } from "./activityTenantRepository.js";
import { OpportunityTenantRepository, type OpportunityTenantTransaction } from "./opportunityTenantRepository.js";
import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError } from "./tenantDataAccess.js";

const contexts = (tenantId: string): AuthTenantContext => Object.freeze({ tenantId, userId: `user-${tenantId}`, membershipId: `membership-${tenantId}`, membershipStatus: "active", membershipRole: "vendedor", legacyUserRole: "vendedor", resolutionSource: "synthetic_test", contextVersion: 1 });
const contextA = contexts("tenant-a"); const contextB = contexts("tenant-b");
const clients = [{ id: "client-a", tenantId: "tenant-a" }, { id: "client-a2", tenantId: "tenant-a" }, { id: "client-b", tenantId: "tenant-b" }];
const opportunities = [{ id: "opportunity-a", clientId: "client-a", value: 10 }, { id: "opportunity-b", clientId: "client-b", value: 20 }];
const activities = [
  { id: "activity-a", clientId: "client-a", opportunityId: null, duration: 1 },
  { id: "activity-b", clientId: null, opportunityId: "opportunity-b", duration: 2 },
  { id: "activity-convergent", clientId: "client-a", opportunityId: "opportunity-a", duration: 3 },
  { id: "activity-divergent", clientId: "client-a", opportunityId: "opportunity-b", duration: 4 },
  { id: "activity-orphan", clientId: null, opportunityId: null, duration: 5 },
];
const calls: Array<{ operation: string; args: any }> = [];
const tenantOfOpportunity = (id: string | null) => clients.find((client) => client.id === opportunities.find((item) => item.id === id)?.clientId)?.tenantId;
const activityOwned = (row: typeof activities[number], tenantId: string) => Boolean((row.clientId || row.opportunityId) && (!row.clientId || clients.find((c) => c.id === row.clientId)?.tenantId === tenantId) && (!row.opportunityId || tenantOfOpportunity(row.opportunityId) === tenantId));
const tenantFromScope = (where: any): string => where.client?.tenantId ?? where.AND[0].OR[0].client.tenantId;

const tx: OpportunityTenantTransaction & ActivityTenantTransaction = {
  client: { async findFirst(args) { calls.push({ operation: "client.findFirst", args }); return clients.find((row) => row.id === args.where.id && row.tenantId === args.where.tenantId) ?? null; } },
  opportunity: {
    async findMany(args: any) { calls.push({ operation: "opportunity.findMany", args }); return opportunities.filter((row) => clients.find((c) => c.id === row.clientId)?.tenantId === tenantFromScope(args.where)); },
    async findFirst(args: any) { calls.push({ operation: "opportunity.findFirst", args }); const row = opportunities.find((item) => item.id === args.where.id && clients.find((c) => c.id === item.clientId)?.tenantId === tenantFromScope(args.where)); return row ?? null; },
    async create(args: any) { calls.push({ operation: "opportunity.create", args }); const row = { id: `opportunity-${opportunities.length}`, value: 0, ...args.data }; opportunities.push(row); return row; },
    async updateMany(args: any) { calls.push({ operation: "opportunity.updateMany", args }); const row = opportunities.find((item) => item.id === args.where.id && clients.find((c) => c.id === item.clientId)?.tenantId === tenantFromScope(args.where)); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
    async deleteMany(args: any) { calls.push({ operation: "opportunity.deleteMany", args }); const index = opportunities.findIndex((item) => item.id === args.where.id && clients.find((c) => c.id === item.clientId)?.tenantId === tenantFromScope(args.where)); if (index < 0) return { count: 0 }; opportunities.splice(index, 1); return { count: 1 }; },
    async count(args: any) { calls.push({ operation: "opportunity.count", args }); return opportunities.filter((row) => clients.find((c) => c.id === row.clientId)?.tenantId === tenantFromScope(args.where)).length; },
    async aggregate(args: any) { calls.push({ operation: "opportunity.aggregate", args }); const rows = opportunities.filter((row) => clients.find((c) => c.id === row.clientId)?.tenantId === tenantFromScope(args.where)); return { _count: rows.length, _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) } }; },
  },
  activity: {
    async findMany(args) { calls.push({ operation: "activity.findMany", args }); return activities.filter((row) => activityOwned(row, tenantFromScope(args.where))); },
    async findFirst(args) { calls.push({ operation: "activity.findFirst", args }); return activities.find((row) => row.id === args.where.id && activityOwned(row, tenantFromScope(args.where))) ?? null; },
    async create(args) { calls.push({ operation: "activity.create", args }); const row = { id: `activity-${activities.length}`, duration: 0, ...args.data }; activities.push(row); return row; },
    async updateMany(args) { calls.push({ operation: "activity.updateMany", args }); const row = activities.find((item) => item.id === args.where.id && activityOwned(item, tenantFromScope(args.where))); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
    async deleteMany(args) { calls.push({ operation: "activity.deleteMany", args }); const index = activities.findIndex((item) => item.id === args.where.id && activityOwned(item, tenantFromScope(args.where))); if (index < 0) return { count: 0 }; activities.splice(index, 1); return { count: 1 }; },
    async count(args) { calls.push({ operation: "activity.count", args }); return activities.filter((row) => activityOwned(row, tenantFromScope(args.where))).length; },
    async aggregate(args) { calls.push({ operation: "activity.aggregate", args }); const rows = activities.filter((row) => activityOwned(row, tenantFromScope(args.where))); return { _count: rows.length, _sum: { duration: rows.reduce((sum, row) => sum + row.duration, 0) } }; },
  },
};
const database = { async $transaction<T>(operation: (transaction: typeof tx) => Promise<T>) { calls.push({ operation: "$transaction", args: {} }); return operation(tx); } };
const opportunityRepository = new OpportunityTenantRepository(database); const activityRepository = new ActivityTenantRepository(database);

assert.deepEqual((await opportunityRepository.list(contextA)).map((row) => row.id), ["opportunity-a"]); assert.deepEqual((await opportunityRepository.list(contextB)).map((row) => row.id), ["opportunity-b"]);
assert.equal(await opportunityRepository.findById(contextA, "opportunity-b"), null); assert.equal(await opportunityRepository.findById(contextB, "opportunity-a"), null);
assert.equal(await opportunityRepository.updateById(contextA, "opportunity-b", { title: "denied" }), false); assert.equal(await opportunityRepository.deleteById(contextB, "opportunity-a"), false);
assert.deepEqual(await opportunityRepository.aggregate(contextA), { _count: 1, _sum: { value: 10 } }); assert.equal(await opportunityRepository.count(contextB), 1);
await assert.rejects(opportunityRepository.create(contextA, { clientId: "client-b", title: "denied" }), TenantDataAccessError); await assert.rejects(opportunityRepository.moveToClient(contextA, "opportunity-a", "client-b"), TenantDataAccessError);
assert.equal(await opportunityRepository.moveToClient(contextA, "opportunity-a", "client-a2"), true);

assert.deepEqual((await activityRepository.list(contextA)).map((row) => row.id), ["activity-a", "activity-convergent"]); assert.deepEqual((await activityRepository.list(contextB)).map((row) => row.id), ["activity-b"]);
assert.equal(await activityRepository.findById(contextA, "activity-b"), null); assert.equal(await activityRepository.findById(contextB, "activity-a"), null);
assert.equal(await activityRepository.updateById(contextA, "activity-b", { done: true }), false); assert.equal(await activityRepository.deleteById(contextB, "activity-a"), false);
assert.deepEqual(await activityRepository.aggregate(contextA), { _count: 2, _sum: { duration: 4 } }); assert.equal(await activityRepository.count(contextB), 1);
await assert.rejects(activityRepository.create(contextA, { clientId: null, opportunityId: null, notes: "orphan" }), TenantDataAccessError);
await assert.rejects(activityRepository.create(contextA, { clientId: "client-a", opportunityId: "opportunity-a", notes: "divergent" }), TenantDataAccessError);
await assert.rejects(activityRepository.relink(contextA, "activity-a", { clientId: "client-b", opportunityId: null }), TenantDataAccessError);
assert.equal(await activityRepository.relink(contextA, "activity-a", { clientId: "client-a2", opportunityId: null }), true);
const [parallelA, parallelB] = await Promise.all([activityRepository.list(contextA), activityRepository.list(contextB)]); assert.ok(parallelA.every((row) => activityOwned(row as any, "tenant-a"))); assert.ok(parallelB.every((row) => activityOwned(row as any, "tenant-b")));
const beforeInvalid = calls.length; assert.throws(() => activityRepository.list(undefined as never), TenantDataAccessError); assert.throws(() => opportunityRepository.list({ ...contextA, contextVersion: 99 } as never), TenantDataAccessError); assert.equal(calls.length, beforeInvalid);

for (const call of calls.filter((item) => /^(opportunity|activity)\.(find|update|delete|count|aggregate)/.test(item.operation))) {
  assert.ok(call.args.where.client?.tenantId || call.args.where.AND, `${call.operation} must send relational ownership to Prisma`);
  if (/findFirst|updateMany|deleteMany/.test(call.operation)) assert.equal(typeof call.args.where.id, "string");
}
assert.ok(calls.some((call) => call.operation === "activity.findMany" && call.args.where.AND.length === 3));
assert.ok(calls.some((call) => call.operation === "client.findFirst" && call.args.where.tenantId === "tenant-a"));
console.log("TENANT_RELATIONAL_OWNERSHIP_A_X_B=PASS");
