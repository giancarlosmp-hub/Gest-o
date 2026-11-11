import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Política comercial nas Configurações: todos os perfis leem (a tela de itens usa o limite e o aviso), só o diretor
// altera; padrão 3% para todos e ligada. Usuários fictícios; Prisma simulado.
type Row = Record<string, any>;

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" }
];
const config = new Map<string, string>();
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("appConfig", {
  findUnique: async ({ where }: any) => (config.has(where.key) ? { value: config.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    config.set(where.key, config.has(where.key) ? update.value : create.value);
    return { value: config.get(where.key) };
  }
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}/settings/commercial-policy`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

const DEFAULTS = {
  enabled: true,
  maxDiscountPercent: { vendedor: 3, gerente: 3, diretor: 3 },
  discountWarning: "Descontos acima do limite da política comercial não são autorizados e implicam a perda do bônus."
};
const results: string[] = [];
try {
  for (const userId of ["director-a", "manager-a", "seller-a"]) {
    const response = await call("GET", userId);
    assert.equal(response.status, 200, `${userId} lê a política`);
    assert.deepEqual(response.json, DEFAULTS);
  }
  results.push("read_all_roles_default=PASS");

  const next = { enabled: true, maxDiscountPercent: { vendedor: 2.5, gerente: 4, diretor: 5 }, discountWarning: "Aviso fictício de teste." };
  assert.equal((await call("PUT", "seller-a", next)).status, 403, "vendedor não altera");
  assert.equal((await call("PUT", "manager-a", next)).status, 403, "gerente não altera");
  assert.equal(config.size, 0);
  const saved = await call("PUT", "director-a", next);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, next);
  assert.deepEqual((await call("GET", "seller-a")).json, next);
  results.push("write_director_only=PASS");

  for (const body of [
    { ...next, maxDiscountPercent: { vendedor: 101, gerente: 4, diretor: 5 } },
    { ...next, maxDiscountPercent: { vendedor: -1, gerente: 4, diretor: 5 } },
    { ...next, maxDiscountPercent: { vendedor: 3, gerente: 4 } },
    { ...next, discountWarning: "   " },
    { ...next, enabled: "sim" }
  ]) assert.equal((await call("PUT", "director-a", body)).status, 400, `inválido: ${JSON.stringify(body)}`);
  assert.deepEqual((await call("GET", "manager-a")).json, next, "inválido não grava");
  results.push("invalid_rejected=PASS");

  config.set("commercial.policy", "{quebrado");
  assert.deepEqual((await call("GET", "seller-a")).json, DEFAULTS, "valor gravado inválido volta ao padrão");
  results.push("stored_invalid_default=PASS");

  console.log(results.join("\n"));
} finally {
  server.close();
}
