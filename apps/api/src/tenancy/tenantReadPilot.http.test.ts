import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { requestContextMiddleware } from "../middlewares/requestLogging.js";
import { signAccessToken } from "../utils/jwt.js";
import { formatTenantReadPilotMarker, runClientListShadowPilot, validateTenantReadPilotConfig, type TenantReadPilotEvent } from "./tenantReadPilot.js";
import type { ClientTenantDelegate } from "./clientTenantRepository.js";
import type { MembershipRecord, TenantControlPlaneReader, TenantRecord } from "./tenantContext.js";

const tenants: TenantRecord[] = [
  { id: "tenant-a", status: "active" }, { id: "tenant-b", status: "active" }, { id: "tenant-suspended", status: "suspended" },
];
const memberships: MembershipRecord[] = [
  { id: "ma", tenantId: "tenant-a", userId: "user-a", role: "vendedor", status: "active", version: 1 },
  { id: "mb", tenantId: "tenant-b", userId: "user-b", role: "vendedor", status: "active", version: 1 },
  { id: "mx1", tenantId: "tenant-a", userId: "ambiguous", role: "vendedor", status: "active", version: 1 },
  { id: "mx2", tenantId: "tenant-b", userId: "ambiguous", role: "vendedor", status: "active", version: 1 },
  { id: "mi", tenantId: "tenant-a", userId: "inactive", role: "vendedor", status: "revoked", version: 1 },
  { id: "ms", tenantId: "tenant-suspended", userId: "suspended", role: "vendedor", status: "active", version: 1 },
];
const clients = [
  { id: "client-a", tenantId: "tenant-a", name: "A", ownerSellerId: "user-a" },
  { id: "client-b", tenantId: "tenant-b", name: "B", ownerSellerId: "user-b" },
];
let readerCalls = 0, repositoryCalls = 0, mutations = 0;
const reader: TenantControlPlaneReader = {
  async findTenant(id) { readerCalls++; return tenants.find((tenant) => tenant.id === id) ?? null; },
  async findMembership(id) { readerCalls++; return memberships.find((membership) => membership.id === id) ?? null; },
  async findMembershipsForUser(userId) { readerCalls++; return memberships.filter((membership) => membership.userId === userId); },
};
const delegate: ClientTenantDelegate = {
  async findMany() { repositoryCalls++; return []; }, async findFirst() { repositoryCalls++; return null; },
  async count({ where }) { repositoryCalls++; return clients.filter((client) => client.tenantId === where.tenantId && (!where.ownerSellerId || client.ownerSellerId === where.ownerSellerId)).length; },
  async create() { mutations++; throw new Error("mutation forbidden"); }, async updateMany() { mutations++; return { count: 0 }; }, async deleteMany() { mutations++; return { count: 0 }; },
};
const enabledA = validateTenantReadPilotConfig({ NODE_ENV: "test", TENANCY_MODE: "default-only", TENANT_READ_PILOT_ENABLED: "true", DEFAULT_TENANT_ID: "tenant-a" });
const enabledB = validateTenantReadPilotConfig({ NODE_ENV: "test", TENANCY_MODE: "default-only", TENANT_READ_PILOT_ENABLED: "true", DEFAULT_TENANT_ID: "tenant-b" });
const disabled = validateTenantReadPilotConfig({ NODE_ENV: "production", TENANCY_MODE: "disabled", TENANT_READ_PILOT_ENABLED: "false" });
const pilotOff = validateTenantReadPilotConfig({ NODE_ENV: "test", TENANCY_MODE: "default-only", TENANT_READ_PILOT_ENABLED: "false" });

const events: TenantReadPilotEvent[] = [];
const buildApp = (configuredPilot: typeof enabledA) => { const app = express();
app.use(requestContextMiddleware, express.json(), authMiddleware);
app.all("/clients", async (req, res) => {
  const legacy = clients.filter((client) => client.ownerSellerId === req.user!.id);
  try {
    await runClientListShadowPilot({ config: req.get("x-test-mode") === "disabled" ? disabled : req.get("x-test-mode") === "pilot-off" ? pilotOff : configuredPilot,
      verifiedUser: { id: req.user!.id, role: req.user!.role }, requestId: req.requestId!,
      functionalWhere: { ownerSellerId: req.user!.id }, legacyCount: legacy.length, reader, clientDelegate: delegate,
      observe: (event) => events.push(event) });
    res.json(legacy);
  } catch { res.status(403).json({ message: "Tenant context denied" }); }
}); return app; };
const serverA = http.createServer(buildApp(enabledA)), serverB = http.createServer(buildApp(enabledB));
await Promise.all([new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve))]);
const addressA = serverA.address(), addressB = serverB.address();
assert(addressA && typeof addressA !== "string" && addressB && typeof addressB !== "string");
const urlA = `http://127.0.0.1:${addressA.port}/clients`, urlB = `http://127.0.0.1:${addressB.port}/clients`;
const token = (id: string) => signAccessToken({ id, email: `${id}@synthetic.invalid`, role: "vendedor" });
const call = (baseUrl: string, id: string, suffix = "", init: RequestInit = {}) => fetch(baseUrl + suffix, { ...init, headers: { authorization: `Bearer ${token(id)}`, "content-type": "application/json", ...(init.headers || {}) } });

try {
  const before = { readerCalls, repositoryCalls };
  const legacy = await call(urlA, "user-a", "", { headers: { "x-test-mode": "disabled" } });
  assert.equal(legacy.status, 200); assert.deepEqual(await legacy.json(), [clients[0]]);
  assert.deepEqual({ readerCalls, repositoryCalls }, before, "disabled must not call tenant dependencies");
  const off = await call(urlA, "user-a", "", { headers: { "x-test-mode": "pilot-off" } });
  assert.deepEqual(await off.json(), [clients[0]]);
  assert.deepEqual({ readerCalls, repositoryCalls }, before, "disabled pilot must not call tenant dependencies");

  const [a, b] = await Promise.all([call(urlA, "user-a"), call(urlB, "user-b")]);
  assert.deepEqual(await a.json(), [clients[0]]); assert.deepEqual(await b.json(), [clients[1]]);
  assert.equal(events.at(-2)?.tenantId, "tenant-a"); assert.equal(events.at(-1)?.tenantId, "tenant-b");
  assert.equal(events.at(-2)?.result, "MATCH"); assert.equal(events.at(-1)?.result, "MATCH");
  const marker = formatTenantReadPilotMarker(events.at(-2)!);
  assert.match(marker, /^TENANT_READ_SHADOW_EVENT=\{"requestId":"req-[0-9a-f]{8}","tenantId":"tenant-a"/);
  assert.match(marker, /"result":"MATCH"/);
  assert.doesNotMatch(marker, /email|authorization|token|payload|client-a/i);

  const untrustedId = "preview-shadow-client-controlled";
  const correlated = await call(urlA, "user-a", "", { headers: { "x-request-id": untrustedId } });
  const responseRequestId = correlated.headers.get("x-request-id");
  assert.match(responseRequestId ?? "", /^req-[0-9a-f]{8}$/);
  assert.notEqual(responseRequestId, untrustedId, "client request ID must never become authoritative");
  assert.equal(events.at(-1)?.requestId, responseRequestId);
  assert.match(formatTenantReadPilotMarker(events.at(-1)!), new RegExp(`^TENANT_READ_SHADOW_EVENT=\\{"requestId":"${responseRequestId}"`));
  assert.deepEqual(await correlated.json(), [clients[0]]);

  for (const attempt of [
    call(urlA, "user-a", "?tenantId=tenant-b"),
    call(urlA, "user-a", "", { headers: { "x-tenant-id": "tenant-b" } }),
    call(urlA, "user-a", "", { method: "POST", body: JSON.stringify({ tenantId: "tenant-b" }) }),
  ]) assert.deepEqual(await (await attempt).json(), [clients[0]]);
  for (const denied of ["ambiguous", "inactive", "suspended"]) assert.equal((await call(urlA, denied)).status, 403);
  assert.throws(() => validateTenantReadPilotConfig({ NODE_ENV: "production", TENANCY_MODE: "default-only", TENANT_READ_PILOT_ENABLED: "true", DEFAULT_TENANT_ID: "tenant-a" }), /UNSAFE/);
  assert.equal(mutations, 0);
  assert(events.every((event) => Object.keys(event).every((key) => ["requestId", "tenantId", "resolutionSource", "contextVersion", "pilotMode", "legacyCount", "tenantScopedCount", "result", "durationMs"].includes(key))));
  console.log("TENANT_READ_PILOT_HTTP_A_X_B=PASS");
} finally { serverA.close(); serverB.close(); }
