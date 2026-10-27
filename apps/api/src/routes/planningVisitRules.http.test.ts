import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Valores das visitas sugeridas nas Configurações (valor estimado do cliente por faixa e valor da oportunidade): vendedor
// vê, gerente e diretor alteram; padrões 20.000 / 5.000 / 20.000; faixa 2 menor que a faixa 1. Usuários fictícios;
// Prisma simulado.
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
  findMany: async ({ where }: any) => [...config].filter(([key]) => where.key.in.includes(key)).map(([key, value]) => ({ key, value })),
  upsert: async ({ where, update, create }: any) => {
    config.set(where.key, config.has(where.key) ? update.value : create.value);
    return { value: config.get(where.key) };
  },
});
(prisma as any).$transaction = async (operations: Array<Promise<unknown>>) => Promise.all(operations);

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

const PATH = "/settings/planning-visit-rules";
const DEFAULTS = { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 5000, opportunityMinValue: 20000 };
const results: string[] = [];
try {
  for (const userId of ["director-a", "manager-a", "seller-a"]) {
    const response = await call("GET", PATH, userId);
    assert.equal(response.status, 200, `${userId} vê os valores`);
    assert.deepEqual(response.json, DEFAULTS, "padrões");
  }
  results.push("read_all_roles_default=PASS");

  assert.equal((await call("PUT", PATH, "seller-a", { ...DEFAULTS, tier1MinEstimatedValue: 30000 })).status, 403, "vendedor não altera");
  assert.equal(config.size, 0);
  const manager = await call("PUT", PATH, "manager-a", { tier1MinEstimatedValue: 30000, tier2MinEstimatedValue: 8000, opportunityMinValue: 25000 });
  assert.equal(manager.status, 200);
  assert.deepEqual(manager.json, { tier1MinEstimatedValue: 30000, tier2MinEstimatedValue: 8000, opportunityMinValue: 25000 });
  const director = await call("PUT", PATH, "director-a", { tier1MinEstimatedValue: 40000, tier2MinEstimatedValue: 10000, opportunityMinValue: 15000 });
  assert.equal(director.status, 200);
  assert.deepEqual((await call("GET", PATH, "seller-a")).json, { tier1MinEstimatedValue: 40000, tier2MinEstimatedValue: 10000, opportunityMinValue: 15000 });
  results.push("write_manager_director=PASS");

  const invalid = [
    { tier1MinEstimatedValue: 10000, tier2MinEstimatedValue: 10000, opportunityMinValue: 20000 },
    { tier1MinEstimatedValue: 10000, tier2MinEstimatedValue: 15000, opportunityMinValue: 20000 },
    { tier1MinEstimatedValue: 20000.5, tier2MinEstimatedValue: 5000, opportunityMinValue: 20000 },
    { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 0, opportunityMinValue: 20000 },
    { tier1MinEstimatedValue: "20000", tier2MinEstimatedValue: 5000, opportunityMinValue: 20000 },
    { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 5000 },
  ];
  for (const body of invalid) assert.equal((await call("PUT", PATH, "director-a", body)).status, 400, `inválido: ${JSON.stringify(body)}`);
  const sameTiers = await call("PUT", PATH, "director-a", invalid[0]);
  assert.match(String(sameTiers.json?.message ?? JSON.stringify(sameTiers.json)), /faixa 2 precisa ser menor que a faixa 1/i);
  assert.deepEqual((await call("GET", PATH, "manager-a")).json, { tier1MinEstimatedValue: 40000, tier2MinEstimatedValue: 10000, opportunityMinValue: 15000 }, "valor inválido não grava");
  results.push("validation=PASS");

  // Gravado fora de ordem direto no banco: as duas faixas voltam ao padrão.
  config.set("planning.visitTier2MinEstimatedValue", "90000");
  assert.deepEqual((await call("GET", PATH, "seller-a")).json, { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 5000, opportunityMinValue: 15000 });
  results.push("stored_out_of_order_falls_back=PASS");

  // Tela: painel na Disciplina Semanal, junto do raio, com o termo e a explicação da aproximação.
  const settingsSource = readFileSync(new URL("../../../web/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../../../web/src/components/settings/PlanningVisitValueRulesPanel.tsx", import.meta.url), "utf8");
  assert(settingsSource.includes('<PlanningVisitValueRulesPanel canEdit={user.role === "diretor" || user.role === "gerente"} />'));
  assert(panelSource.includes("valor estimado do cliente") && panelSource.includes("aproximação"));
  assert(!/faturamento|valor comprado/i.test(panelSource), "não chama de faturamento nem de valor comprado");
  results.push("screen=PASS");

  console.log(results.join("\n"));
} finally {
  server.close();
}
