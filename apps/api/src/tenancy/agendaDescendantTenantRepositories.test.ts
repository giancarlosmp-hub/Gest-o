import assert from "node:assert/strict";
import { AgendaActivityTenantRepository, AgendaStopTenantRepository, type AgendaDescendantTransaction } from "./agendaDescendantTenantRepositories.js";
import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError } from "./tenantDataAccess.js";

const context = (tenantId: string): AuthTenantContext => ({ tenantId, userId: `u-${tenantId}`, membershipId: `m-${tenantId}`, membershipStatus: "active", membershipRole: "vendedor", legacyUserRole: "vendedor", resolutionSource: "synthetic_test", contextVersion: 1 });
const A = context("A"), B = context("B");
const clients = [{ id: "ca", tenantId: "A" }, { id: "cb", tenantId: "B" }, { id: "cn", tenantId: null }];
const agendas: any[] = [
  { id: "ad-a", tenantId: "A", clientId: null, opportunityId: null }, { id: "ad-b", tenantId: "B", clientId: null, opportunityId: null },
  { id: "ac-a", tenantId: null, clientId: "ca", opportunityId: null }, { id: "ao-a", tenantId: null, clientId: null, opportunityId: "oa" },
  { id: "multi-source", tenantId: "A", clientId: "ca", opportunityId: null }, { id: "null-root", tenantId: null, clientId: "cn", opportunityId: null },
];
const opportunities = [{ id: "oa", clientId: "ca" }];
const stops: any[] = [{ id: "sa", agendaEventId: "ad-a", clientId: null }, { id: "sb", agendaEventId: "ad-b", clientId: null }, { id: "scross", agendaEventId: "ad-a", clientId: "cb" }, { id: "sorphan", agendaEventId: "missing", clientId: null }];
const activities: any[] = [
  { id: "aa", agendaEventId: "ad-a", clientId: null, opportunityId: null }, { id: "ab", agendaEventId: "ad-b", clientId: null, opportunityId: null },
  { id: "agenda-client", agendaEventId: "ad-a", clientId: "ca", opportunityId: null }, { id: "agenda-opportunity", agendaEventId: "ad-a", clientId: null, opportunityId: "oa" },
  { id: "parents-convergent", agendaEventId: "ac-a", clientId: "ca", opportunityId: null }, { id: "parents-divergent", agendaEventId: "ad-a", clientId: "cb", opportunityId: null },
  { id: "activity-cross-tenant", agendaEventId: "ad-b", clientId: null, opportunityId: null }, { id: "activity-orphan", agendaEventId: null, clientId: null, opportunityId: null },
];
const calls: Array<{ operation: string; args: any }> = [];
const agendaOwned = (row: any, tenant: string) => { const sources = [row.tenantId, row.clientId, row.opportunityId].filter((x) => x != null); if (sources.length !== 1) return false; return row.tenantId === tenant || clients.find((x) => x.id === row.clientId)?.tenantId === tenant || clients.find((x) => x.id === opportunities.find((o) => o.id === row.opportunityId)?.clientId)?.tenantId === tenant; };
const tenantFrom = (where: any) => where.agendaEvent.OR[0].tenantId;
const visible = (row: any, where: any, activity: boolean) => { const agenda = agendas.find((x) => x.id === row.agendaEventId); if (!agenda || !agendaOwned(agenda, tenantFrom(where))) return false; if (activity) return row.clientId === null && row.opportunityId === null; return row.clientId === null || clients.find((x) => x.id === row.clientId)?.tenantId === tenantFrom(where); };
const model = (name: string, rows: any[], activity: boolean): any => ({
  async findMany(args: any) { calls.push({ operation: `${name}.findMany`, args }); return rows.filter((r) => visible(r, args.where, activity)); },
  async findFirst(args: any) { calls.push({ operation: `${name}.findFirst`, args }); return rows.find((r) => r.id === args.where.id && visible(r, args.where, activity)) ?? null; },
  async create(args: any) { calls.push({ operation: `${name}.create`, args }); const row = { id: `${name}-new`, ...args.data }; rows.push(row); return row; },
  async updateMany(args: any) { calls.push({ operation: `${name}.updateMany`, args }); const row = rows.find((r) => r.id === args.where.id && visible(r, args.where, activity)); if (!row) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
  async deleteMany(args: any) { calls.push({ operation: `${name}.deleteMany`, args }); const i = rows.findIndex((r) => r.id === args.where.id && visible(r, args.where, activity)); if (i < 0) return { count: 0 }; rows.splice(i, 1); return { count: 1 }; },
  async count(args: any) { calls.push({ operation: `${name}.count`, args }); return rows.filter((r) => visible(r, args.where, activity)).length; },
  async aggregate(args: any) { calls.push({ operation: `${name}.aggregate`, args }); return { _count: rows.filter((r) => visible(r, args.where, activity)).length }; },
  async groupBy(args: any) { calls.push({ operation: `${name}.groupBy`, args }); return [{ _count: rows.filter((r) => visible(r, args.where, activity)).length }]; },
});
const tx: AgendaDescendantTransaction = {
  agendaEvent: { async findFirst(args) { calls.push({ operation: "agendaEvent.findFirst", args }); const tenant = args.where.OR[0].tenantId as string; return agendas.find((x) => x.id === args.where.id && agendaOwned(x, tenant)) ?? null; } },
  client: { async findFirst(args) { calls.push({ operation: "client.findFirst", args }); return clients.find((x) => x.id === args.where.id && x.tenantId === args.where.tenantId) ?? null; } },
  agendaStop: model("agendaStop", stops, false), activity: model("activity", activities, true),
};
const db = { async $transaction<T>(fn: (tx: AgendaDescendantTransaction) => Promise<T>) { calls.push({ operation: "$transaction", args: {} }); return fn(tx); } };
const stop = new AgendaStopTenantRepository(db), activity = new AgendaActivityTenantRepository(db);

assert.deepEqual((await stop.list(A)).map((x) => x.id), ["sa"]); assert.deepEqual((await stop.list(B)).map((x) => x.id), ["sb"]);
assert.deepEqual((await activity.list(A)).map((x) => x.id), ["aa"]); assert.deepEqual((await activity.list(B)).map((x) => x.id), ["ab", "activity-cross-tenant"]);
for (const repo of [stop, activity]) { assert.equal(await repo.findById(A, repo === stop ? "sb" : "ab"), null); assert.equal(await repo.updateById(A, repo === stop ? "sb" : "ab", { notes: "no" }), false); assert.equal(await repo.deleteById(A, repo === stop ? "sb" : "ab"), false); }
for (const id of ["scross", "sorphan"]) assert.equal(await stop.findById(A, id), null);
for (const id of ["agenda-client", "agenda-opportunity", "parents-convergent", "parents-divergent", "activity-cross-tenant", "activity-orphan"]) assert.equal(await activity.findById(A, id), null);
await stop.create(A, { agendaEventId: "ac-a", clientId: "ca", order: 2 }); await activity.create(A, { agendaEventId: "ao-a", clientId: null, opportunityId: null });
await assert.rejects(stop.create(A, { agendaEventId: "ad-a", clientId: "cb" }), TenantDataAccessError); await assert.rejects(activity.create(A, { agendaEventId: "ad-a", clientId: "ca", opportunityId: null }), TenantDataAccessError);
for (const parent of ["ad-b", "multi-source", "null-root", "missing"]) await assert.rejects(activity.create(A, { agendaEventId: parent, clientId: null, opportunityId: null }), TenantDataAccessError);
assert.throws(() => stop.updateById(A, "sa", { agendaEventId: "ad-b" }), TenantDataAccessError); assert.throws(() => activity.updateById(A, "aa", { clientId: "ca" }), TenantDataAccessError);
assert.equal(await stop.relink(A, "sa", "ao-a"), true); await assert.rejects(activity.relink(A, "aa", "ad-b"), TenantDataAccessError);
assert.ok(await stop.count(A) >= 1); assert.ok(await activity.aggregate(A)); assert.ok(await stop.groupBy(A, ["resultStatus"]));
const [parallelA, parallelB] = await Promise.all([activity.list(A), activity.list(B)]); assert.ok(parallelA.every((r) => r.agendaEventId !== "ad-b")); assert.ok(parallelB.every((r) => r.agendaEventId === "ad-b"));
const before = calls.length; assert.throws(() => stop.list(undefined as never), TenantDataAccessError); assert.equal(calls.length, before);
for (const call of calls.filter((x) => /^(agendaStop|activity)\.(find|update|delete|count|aggregate|groupBy)/.test(x.operation))) assert.ok(call.args.where.agendaEvent?.OR, `${call.operation} lacks AgendaEvent scope`);
assert.ok(calls.some((x) => x.operation === "agendaStop.updateMany") && calls.some((x) => x.operation === "activity.deleteMany")); assert.ok(calls.every((x) => x.args?.include === undefined));
console.log("AGENDA_DESCENDANTS_TENANT_OWNERSHIP=PASS");
