import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Raio do agrupamento de visitas nas Configurações: vendedor vê, gerente e diretor alteram (10 a 300 km, padrão 70).
// Usuários fictícios; Prisma simulado.
type Row = Record<string, any>;

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
];
const config = new Map<string, string>();
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("appConfig", {
  findUnique: async ({ where }: any) => (config.has(where.key) ? { value: config.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    config.set(where.key, config.has(where.key) ? update.value : create.value);
    return { value: config.get(where.key) };
  },
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

const results: string[] = [];
try {
  for (const userId of ["director-a", "manager-a", "seller-a"]) {
    const response = await call("GET", "/settings/planning-visit-radius", userId);
    assert.equal(response.status, 200, `${userId} vê o raio`);
    assert.deepEqual(response.json, { radiusKm: 70 }, "padrão 70 km");
  }
  results.push("read_all_roles_default=PASS");

  assert.equal((await call("PUT", "/settings/planning-visit-radius", "seller-a", { radiusKm: 90 })).status, 403, "vendedor não altera");
  assert.equal(config.size, 0);
  const manager = await call("PUT", "/settings/planning-visit-radius", "manager-a", { radiusKm: 90 });
  assert.equal(manager.status, 200);
  assert.deepEqual(manager.json, { radiusKm: 90 });
  const director = await call("PUT", "/settings/planning-visit-radius", "director-a", { radiusKm: 120 });
  assert.equal(director.status, 200);
  assert.deepEqual((await call("GET", "/settings/planning-visit-radius", "seller-a")).json, { radiusKm: 120 });
  results.push("write_manager_director=PASS");

  for (const radiusKm of [9, 301, 70.5, "70"]) {
    assert.equal((await call("PUT", "/settings/planning-visit-radius", "director-a", { radiusKm })).status, 400, `inválido: ${radiusKm}`);
  }
  assert.deepEqual((await call("GET", "/settings/planning-visit-radius", "manager-a")).json, { radiusKm: 120 }, "valor inválido não grava");
  results.push("validation=PASS");

  // Tela: painel nas Configurações (gerente e diretor editam) e aviso/rota no planejamento.
  const settingsSource = readFileSync(new URL("../../../web/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  const planSource = readFileSync(new URL("../../../web/src/components/planning/WeeklyCommercialPlan.tsx", import.meta.url), "utf8");
  assert(settingsSource.includes('<PlanningVisitRadiusPanel canEdit={user.role === "diretor" || user.role === "gerente"} />'));
  assert(planSource.includes("Fora do território"));
  assert(planSource.includes("Ver rota do dia"));
  assert(planSource.includes("Visitas sem dia nesta semana") && planSource.includes("plan?.unallocatedPriorities"), "bloco das visitas sem dia");
  assert(planSource.includes('target="_blank"') && planSource.includes('rel="noopener noreferrer"'));
  results.push("screen=PASS");

  console.log(`PLANNING_VISIT_RADIUS_HTTP=PASS ${results.join(" ")}`);
} finally {
  server.close();
}
