import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantContext, TenantContextError, type MembershipRecord, type TenantControlPlaneReader, type TenantRecord } from "./tenantContext.js";
import { defineAuditedTenantSql, tenantCacheKey, tenantLogFields, type PlatformAdministration, type TenantJobEnvelope, type TenantRepository, type WebhookTenantResolver } from "./contracts.js";

const tenant: TenantRecord = { id: "tenant-default", status: "active" };
const membership: MembershipRecord = { id: "membership-1", tenantId: tenant.id, userId: "user-1", role: "diretor", status: "active", version: 3 };
const reader = (t: TenantRecord | null = tenant, m: MembershipRecord | null = membership): TenantControlPlaneReader => ({
  findTenant: async () => t,
  findMembership: async () => m
});
const evidence = { source: "access_token" as const, principal: { tenantId: tenant.id, userId: membership.userId, membershipId: membership.id, tenantRole: membership.role, membershipVersion: membership.version } };
const options = { defaultTenantId: tenant.id, defaultOnly: true };
const denied = async (promise: Promise<unknown>, code = "TENANT_DENIED") => assert.rejects(promise, (error: unknown) => error instanceof TenantContextError && error.code === code);

const context = await createTenantContext(evidence, "request-1", reader(), options);
assert(Object.isFrozen(context), "TenantContext must be immutable");
assert.equal(context.tenantId, tenant.id);
await denied(createTenantContext({ ...evidence, principal: { ...evidence.principal, tenantId: "tenant-other" } }, "request-2", reader(), options));
await denied(createTenantContext(evidence, "request-3", reader(null, membership), options));
await denied(createTenantContext(evidence, "request-4", reader({ ...tenant, status: "suspended" }, membership), options));
await denied(createTenantContext(evidence, "request-5", reader(tenant, null), options));
await denied(createTenantContext(evidence, "request-6", reader(tenant, { ...membership, status: "revoked" }), options));
await denied(createTenantContext(evidence, "request-7", reader(tenant, { ...membership, version: 4 }), options));
await denied(createTenantContext(evidence, "", reader(), options), "TENANT_REQUIRED");

const breakGlass = { source: "platform_break_glass" as const, principal: { ...evidence.principal, platformRole: "platform_support" as const }, reason: "INC-TEST", auditId: "audit-1", expiresAt: new Date(Date.now() + 60_000) };
assert.equal((await createTenantContext(breakGlass, "request-8", reader(), options)).source, "platform_break_glass");
await denied(createTenantContext({ ...breakGlass, reason: "" }, "request-9", reader(), options), "BREAK_GLASS_DENIED");

const repository: TenantRepository<string> = { findById: async (ctx, id) => `${ctx.tenantId}:${id}`, save: async (_ctx, value) => value };
assert.equal(await repository.findById(context, "resource"), "tenant-default:resource");
const platform: PlatformAdministration = { executeBreakGlass: async (input) => assert(input.reason) };
await platform.executeBreakGlass({ auditId: "audit-2", reason: "INC-TEST", expiresAt: new Date(Date.now() + 1) });
const job: TenantJobEnvelope<{ task: string }> = { tenantId: context.tenantId, jobId: "job-1", payload: { task: "sync" } };
assert(job.tenantId);
assert.match(tenantCacheKey(context, "client", "5050"), /^tenant:tenant-default:/);
assert.deepEqual(tenantLogFields(context), { tenantId: "tenant-default", requestId: "request-1" });
assert(!("userId" in tenantLogFields(context)), "tenant log fields must not add user PII");
const webhook: WebhookTenantResolver = { resolveVerifiedAccount: async externalAccountId => ({ tenantId: context.tenantId, externalAccountId }) };
assert.equal((await webhook.resolveVerifiedAccount("wa-account"))?.tenantId, context.tenantId);
assert.equal(defineAuditedTenantSql({ name: "tenant_clients_by_id", text: 'SELECT * FROM "Client" WHERE "tenantId" = $1 AND id = $2', tenantIdParameter: 1, auditEvent: "tenant_sql" }).tenantIdParameter, 1);

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(here, "tenantContext.ts"), "utf8");
for (const forbidden of ["req.body", "req.query", "x-tenant-id", "X-Tenant-Id"]) assert(!source.includes(forbidden), `context factory must not contain ${forbidden}`);
const contracts = await readFile(resolve(here, "contracts.ts"), "utf8");
assert.match(contracts, /findById\(context: TenantContext/);
assert.match(contracts, /TenantJobEnvelope.*tenantId/s);
assert.match(contracts, /resolveVerifiedAccount/);
assert.match(contracts, /tenantIdParameter/);
console.log("tenant architecture contracts: PASS");
