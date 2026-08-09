import assert from "node:assert/strict";
import { AgendaEventTenantRepository, TimelineEventTenantRepository, type AgendaTimelineTransaction } from "./agendaTimelineTenantRepositories.js";
import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError } from "./tenantDataAccess.js";

const context = (tenantId: string): AuthTenantContext => ({ tenantId, userId: `u-${tenantId}`, membershipId: `m-${tenantId}`, membershipStatus: "active", membershipRole: "vendedor", legacyUserRole: "vendedor", resolutionSource: "synthetic_test", contextVersion: 1 });
const A = context("A"), B = context("B");
const clients = [{ id: "ca", tenantId: "A" }, { id: "ca2", tenantId: "A" }, { id: "cb", tenantId: "B" }, { id: "cn", tenantId: null }];
const opportunities = [{ id: "oa", clientId: "ca" }, { id: "ob", clientId: "cb" }];
const agendas: any[] = [
  { id: "ad-a", tenantId: "A", clientId: null, opportunityId: null }, { id: "ad-b", tenantId: "B", clientId: null, opportunityId: null },
  { id: "ac-a", tenantId: null, clientId: "ca", opportunityId: null }, { id: "ao-a", tenantId: null, clientId: null, opportunityId: "oa" },
  { id: "ac-b", tenantId: null, clientId: "cb", opportunityId: null }, { id: "ao-b", tenantId: null, clientId: null, opportunityId: "ob" },
  { id: "multi-convergent", tenantId: "A", clientId: "ca", opportunityId: null }, { id: "multi-divergent", tenantId: null, clientId: "ca2", opportunityId: "oa" },
  { id: "multi-cross", tenantId: null, clientId: "ca", opportunityId: "ob" }, { id: "orphan", tenantId: null, clientId: null, opportunityId: null },
  { id: "null-parent", tenantId: null, clientId: "cn", opportunityId: null },
];
const timelines: any[] = [
  { id: "tc-a", clientId: "ca", opportunityId: null }, { id: "to-a", clientId: null, opportunityId: "oa" },
  { id: "tc-b", clientId: "cb", opportunityId: null }, { id: "to-b", clientId: null, opportunityId: "ob" },
  { id: "tm-convergent", clientId: "ca", opportunityId: "oa" }, { id: "tm-cross", clientId: "ca", opportunityId: "ob" },
  { id: "t-orphan", clientId: null, opportunityId: null }, { id: "t-null-parent", clientId: "cn", opportunityId: null },
];
const calls: Array<{ operation: string; args: any }> = [];
const clientTenant = (id: string | null) => clients.find((x) => x.id === id)?.tenantId;
const opportunityTenant = (id: string | null) => clientTenant(opportunities.find((x) => x.id === id)?.clientId ?? null);
const tenantFrom = (where: any) => where.OR[0].tenantId ?? where.OR[0].client.tenantId;
const owned = (row: any, tenant: string, agenda: boolean) => {
  const sources = [agenda ? row.tenantId : null, row.clientId, row.opportunityId].filter((x) => x != null);
  if (sources.length !== 1) return false;
  return row.tenantId === tenant || clientTenant(row.clientId) === tenant || opportunityTenant(row.opportunityId) === tenant;
};
const model = (name: string, rows: any[], agenda: boolean): any => ({
  async findMany(args: any) { calls.push({ operation: `${name}.findMany`, args }); return rows.filter((r) => owned(r, tenantFrom(args.where), agenda)); },
  async findFirst(args: any) { calls.push({ operation: `${name}.findFirst`, args }); return rows.find((r) => r.id === args.where.id && owned(r, tenantFrom(args.where), agenda)) ?? null; },
  async create(args: any) { calls.push({ operation: `${name}.create`, args }); const row = { id: `${name}-created-${rows.length}`, ...args.data }; rows.push(row); return row; },
  async updateMany(args: any) { calls.push({ operation: `${name}.updateMany`, args }); const row = rows.find((r) => r.id === args.where.id && owned(r, tenantFrom(args.where), agenda)); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
  async deleteMany(args: any) { calls.push({ operation: `${name}.deleteMany`, args }); const i = rows.findIndex((r) => r.id === args.where.id && owned(r, tenantFrom(args.where), agenda)); if (i < 0) return { count: 0 }; rows.splice(i, 1); return { count: 1 }; },
  async count(args: any) { calls.push({ operation: `${name}.count`, args }); return rows.filter((r) => owned(r, tenantFrom(args.where), agenda)).length; },
  async aggregate(args: any) { calls.push({ operation: `${name}.aggregate`, args }); return { _count: rows.filter((r) => owned(r, tenantFrom(args.where), agenda)).length }; },
  async groupBy(args: any) { calls.push({ operation: `${name}.groupBy`, args }); return [{ _count: rows.filter((r) => owned(r, tenantFrom(args.where), agenda)).length }]; },
});
const tx: AgendaTimelineTransaction = {
  client: { async findFirst(args) { calls.push({ operation: "client.findFirst", args }); return clients.find((x) => x.id === args.where.id && x.tenantId === args.where.tenantId) ?? null; } },
  opportunity: { async findFirst(args) { calls.push({ operation: "opportunity.findFirst", args }); return opportunities.find((x) => x.id === args.where.id && clientTenant(x.clientId) === args.where.client.tenantId) ?? null; } },
  agendaEvent: model("agendaEvent", agendas, true), timelineEvent: model("timelineEvent", timelines, false),
};
const db = { async $transaction<T>(fn: (value: AgendaTimelineTransaction) => Promise<T>) { calls.push({ operation: "$transaction", args: {} }); return fn(tx); } };
const agenda = new AgendaEventTenantRepository(db), timeline = new TimelineEventTenantRepository(db);

assert.deepEqual((await agenda.list(A)).map((x) => x.id), ["ad-a", "ac-a", "ao-a"]);
assert.deepEqual((await agenda.list(B)).map((x) => x.id), ["ad-b", "ac-b", "ao-b"]);
assert.deepEqual((await timeline.list(A)).map((x) => x.id), ["tc-a", "to-a"]);
assert.deepEqual((await timeline.list(B)).map((x) => x.id), ["tc-b", "to-b"]);
for (const [repo, foreign] of [[agenda, "ad-b"], [timeline, "tc-b"]] as const) {
  assert.equal(await repo.findById(A, foreign), null); assert.equal(await repo.updateById(A, foreign, { description: "no" }), false); assert.equal(await repo.deleteById(A, foreign), false);
}
for (const id of ["multi-convergent", "multi-divergent", "multi-cross", "orphan", "null-parent"]) assert.equal(await agenda.findById(A, id), null);
for (const id of ["tm-convergent", "tm-cross", "t-orphan", "t-null-parent"]) assert.equal(await timeline.findById(A, id), null);
assert.equal(await agenda.count(A), 3); assert.deepEqual(await agenda.aggregate(B), { _count: 3 }); assert.deepEqual(await timeline.groupBy(A, ["type"]), [{ _count: 2 }]);
await agenda.create(A, { tenantId: "A", clientId: null, opportunityId: null, title: "direct" });
await timeline.create(A, { clientId: "ca", opportunityId: null, description: "client" });
for (const links of [{ tenantId: null, clientId: null, opportunityId: null }, { tenantId: "A", clientId: "ca", opportunityId: null }, { tenantId: null, clientId: "ca", opportunityId: "oa" }, { tenantId: "B", clientId: null, opportunityId: null }, { tenantId: null, clientId: "cb", opportunityId: null }]) await assert.rejects(agenda.create(A, links), TenantDataAccessError);
await assert.rejects(timeline.create(A, { tenantId: "A", clientId: "ca", opportunityId: null }), TenantDataAccessError);
assert.throws(() => agenda.updateById(A, "ad-a", { tenantId: "B" } as never), TenantDataAccessError);
assert.throws(() => timeline.updateById(A, "tc-a", { clientId: "cb" } as never), TenantDataAccessError);
assert.equal(await agenda.relink(A, "ad-a", { tenantId: null, clientId: "ca", opportunityId: null }), true);
await assert.rejects(timeline.relink(A, "tc-a", { clientId: "cb", opportunityId: null }), TenantDataAccessError);
const [parallelA, parallelB] = await Promise.all([timeline.list(A), timeline.list(B)]); assert.ok(parallelA.every((r) => owned(r, "A", false))); assert.ok(parallelB.every((r) => owned(r, "B", false)));
const before = calls.length; assert.throws(() => agenda.list(undefined as never), TenantDataAccessError); assert.equal(calls.length, before);
for (const call of calls.filter((x) => /^(agendaEvent|timelineEvent)\.(find|update|delete|count|aggregate|groupBy)/.test(x.operation))) assert.ok(call.args.where.OR, `${call.operation} must carry scope`);
assert.ok(calls.some((x) => x.operation === "agendaEvent.updateMany") && calls.some((x) => x.operation === "timelineEvent.deleteMany"));
assert.ok(calls.every((x) => x.args?.include === undefined), "independent includes are forbidden");
console.log("AGENDA_TIMELINE_TENANT_OWNERSHIP=PASS");
