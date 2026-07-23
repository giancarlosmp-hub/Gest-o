import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

setModel("client", {
  count: async () => 1,
  findMany: async () => [{ id: "client-1", name: "Cliente Smoke", fantasyName: null, city: "Rio Verde", state: "GO", lastPurchaseDate: null, ownerSellerId: "seller-1" }],
  findFirst: async (args: any) => args?.where?.id === "client-1" ? { id: "client-1", name: "Cliente Smoke", isArchived: false, ownerSellerId: "seller-1" } : null,
});
setModel("user", {
  findFirst: async (args: any) => args?.where?.id === "invalid-seller" ? null : { id: args?.where?.id ?? "seller-1" },
  findMany: async () => [{ id: "seller-1" }, { id: "seller-2" }],
});
setModel("agendaEvent", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
setModel("opportunity", { findMany: async () => [], count: async () => 0 });
setModel("activity", { aggregate: async () => ({ _max: { date: null } }), count: async () => 0 });
setModel("erpSyncRun", { findFirst: async () => null });
setModel("appConfig", { findUnique: async () => ({ value: JSON.stringify({ enabled: false }) }), upsert: async () => ({}) });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const directorToken = signAccessToken({ id: "director-1", email: "director@example.test", role: "diretor" });
const auth = { Authorization: `Bearer ${directorToken}` };
const get = (path: string, headers?: Record<string, string>) => fetch(`${baseUrl}${path}`, { headers });

try {
  for (const path of ["/health/version", "/api/health/version"]) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} sem auth deve retornar 200`);
    const body = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["builtAt", "commit", "environment", "status", "version"].sort());
    for (const forbidden of ["database", "hostname", "token", "secret", "path", "container"]) assert(!(forbidden in body));
  }

  const cooling = await get("/api/clients/alerts/cooling", auth);
  assert.equal(cooling.status, 200);
  const coolingBody = await cooling.json() as any;
  assert.equal(typeof coolingBody.count, "number");
  assert(Array.isArray(coolingBody.clients));

  const byId = await get("/api/clients/client-1", auth);
  assert.notEqual(byId.status, 404, "/api/clients/:id deve continuar montado após alerts");

  const unauthAgenda = await get("/api/ai/agenda-intelligence/day?date=2026-07-23");
  assert.equal(unauthAgenda.status, 401);
  for (const path of ["/api/ai/agenda-intelligence/day?date=2026-07-23", "/api/ai/agenda-intelligence/day?date=2026-07-23&refresh=true"]) {
    const res = await get(path, auth);
    assert.equal(res.status, 200, path);
    const body = await res.json() as any;
    assert.equal(body.scope, "aggregate");
    assert.deepEqual(body.sellerIds, ["seller-1", "seller-2"]);
  }
  const invalid = await get("/api/ai/agenda-intelligence/day?date=2026-07-23&sellerId=invalid-seller", auth);
  assert.equal(invalid.status, 403);

  const scheduler = await get("/api/erp/ultrafv3/scheduler/status", auth);
  assert.equal(scheduler.status, 200);
  const schedulerBody = await scheduler.json() as any;
  assert.deepEqual(Object.keys(schedulerBody.automaticSync).sort(), ["enabled", "initialized", "lastRunAt", "lastSuccessAt", "nextRunAt", "reasonCode", "status"].sort());

  console.log("PR18A.2 mounted HTTP regression passed");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
