import assert from "node:assert/strict";
import { once } from "node:events";
import { optionalUserPhoneSchema, userCreateSchema, userUpdateSchema } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Celular/WhatsApp do usuário: cadastro em Configurações → Usuários (diretor e gerente).
// Dados fictícios; Prisma simulado em memória.
type Row = Record<string, any>;

// 1) Schema: só celular brasileiro válido, gravado como 55 + DDD + número.
const parsePhone = (value: unknown) => optionalUserPhoneSchema.safeParse(value);
assert.equal(parsePhone("(11) 90000-0001").data, "5511900000001");
assert.equal(parsePhone("+55 11 90000-0001").data, "5511900000001");
assert.equal(parsePhone("11 8000-0001").data, "5511980000001", "celular antigo de 8 dígitos ganha o nono dígito");
assert.equal(parsePhone("").data, null, "vazio limpa");
assert.equal(parsePhone(null).data, null);
assert.equal(parsePhone(undefined).data, undefined, "ausente não altera");
for (const invalid of ["(11) 3000-0001", "90000-0001", "(00) 90000-0001", "abc", "11 90000-00011"]) {
  assert.equal(parsePhone(invalid).success, false, `recusa ${invalid}`);
}
const baseUser = { name: "Usuario Ficticio", email: "ficticio@test.invalid", role: "vendedor" };
assert.equal(userCreateSchema.safeParse({ ...baseUser, password: "senha-ficticia", phone: "(21) 90000-0002" }).data?.phone, "5521900000002");
assert.equal(userUpdateSchema.safeParse({ ...baseUser, phone: "(21) 3000-0002" }).success, false, "fixo é recusado");

// 2) Rotas /users com Prisma simulado.
const users: Row[] = [
  { id: "director-a", name: "Diretor Ficticio", email: "director-a@test.invalid", role: "diretor", phone: null },
  { id: "manager-a", name: "Gerente Ficticio", email: "manager-a@test.invalid", role: "gerente", phone: null },
  { id: "seller-a", name: "Vendedor Ficticio", email: "seller-a@test.invalid", role: "vendedor", phone: "5511900000009" }
].map((user) => ({
  region: null, erpCode: null, erpOperatorCode: null, erpRawPayload: { CAMPO_FICTICIO: "x" }, erpLoginUsername: null,
  erpLoginPasswordEncrypted: "cifra-ficticia", erpLoginLastTestStatus: null, erpLoginLastTestAt: null,
  passwordHash: "hash-ficticio", isActive: true, createdAt: new Date("2026-01-01T00:00:00.000Z"), ...user
}));

// Respeita o select como o Prisma: sem select, devolve a linha inteira.
const project = (row: Row | undefined, select?: Row) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : { ...row };

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where, select }: any) => {
    if (where?.OR) return null; // identidade duplicada: nenhuma nos dados fictícios
    return project(users.find((row) => row.id === where?.id && row.isActive), select);
  },
  findUnique: async ({ where, select }: any) => project(users.find((row) => row.id === where?.id), select),
  findMany: async ({ where, select }: any) => users.filter((row) => where?.isActive === undefined || row.isActive === where.isActive).map((row) => project(row, select)),
  create: async ({ data, select }: any) => {
    const { tenantMemberships: _memberships, ...fields } = data;
    const row = { id: `user-${users.length + 1}`, isActive: true, createdAt: new Date("2026-01-02T00:00:00.000Z"), erpLoginLastTestStatus: null, erpLoginLastTestAt: null, ...fields };
    users.push(row);
    return project(row, select);
  },
  update: async ({ where, data, select }: any) => {
    const row = users.find((item) => item.id === where.id)!;
    Object.assign(row, data);
    return project(row, select);
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });

const originalInfo = console.info;
console.info = () => undefined;
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: user.email, role: user.role });
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const byId = (id: string) => users.find((row) => row.id === id)!;
const editBody = (user: Row, extra: Row = {}) => ({ name: user.name, email: user.email, role: user.role, ...extra });

try {
  // Criação grava o celular normalizado; fixo é recusado.
  const created = await call("POST", "/users", "director-a", { name: "Novo Ficticio", email: "novo@test.invalid", password: "senha-ficticia", role: "vendedor", phone: "(31) 90000-0003" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.phone, "5531900000003");
  assert.equal(byId(created.json.data.id).phone, "5531900000003");
  const landline = await call("POST", "/users", "director-a", { name: "Fixo Ficticio", email: "fixo@test.invalid", password: "senha-ficticia", role: "vendedor", phone: "(31) 3000-0003" });
  assert.equal(landline.status, 400);

  // Edição: diretor e gerente editam o celular de vendedor; ausente mantém; vazio limpa.
  const seller = byId("seller-a");
  assert.equal((await call("PUT", "/users/seller-a", "manager-a", editBody(seller, { phone: "41 90000-0004" }))).status, 200);
  assert.equal(seller.phone, "5541900000004");
  assert.equal((await call("PUT", "/users/seller-a", "director-a", editBody(seller))).status, 200);
  assert.equal(seller.phone, "5541900000004", "sem phone no corpo mantém o atual");
  assert.equal((await call("PUT", "/users/seller-a", "director-a", editBody(seller, { phone: "123" }))).status, 400);
  assert.equal(seller.phone, "5541900000004", "inválido não altera");
  assert.equal((await call("PUT", "/users/seller-a", "director-a", editBody(seller, { phone: "" }))).status, 200);
  assert.equal(seller.phone, null, "vazio limpa");

  // Leitura: diretor e gerente veem o celular na lista; vendedor não lista usuários.
  seller.phone = "5541900000004";
  const listed = await call("GET", "/users", "manager-a");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.find((user: Row) => user.id === "seller-a").phone, "5541900000004");
  assert.equal((await call("GET", "/users", "seller-a")).status, 403);
  assert.equal((await call("PUT", "/users/seller-a", "seller-a", editBody(seller, { phone: "41 90000-0005" }))).status, 403, "vendedor não edita nem o próprio");
  assert.equal(seller.phone, "5541900000004");

  // Próprio cadastro: o gerente edita o próprio celular, mas não o próprio papel; o diretor também não.
  const manager = byId("manager-a");
  const ownPhone = await call("PUT", "/users/manager-a", "manager-a", editBody(manager, { phone: "(51) 90000-0006" }));
  assert.equal(ownPhone.status, 200, JSON.stringify(ownPhone.json));
  assert.equal(manager.phone, "5551900000006");
  assert.equal((await call("PUT", "/users/manager-a", "manager-a", editBody(manager, { role: "vendedor" }))).status, 400);
  assert.equal((await call("PUT", "/users/manager-a", "manager-a", editBody(manager, { role: "diretor" }))).status, 400);
  assert.equal(manager.role, "gerente");
  const director = byId("director-a");
  assert.equal((await call("PUT", "/users/director-a", "director-a", editBody(director, { phone: "(51) 90000-0007" }))).status, 200);
  assert.equal(director.phone, "5551900000007");
  assert.equal((await call("PUT", "/users/director-a", "director-a", editBody(director, { role: "gerente" }))).status, 400);
  assert.equal(director.role, "diretor");

  console.log("user phone tests passed");
} finally {
  console.info = originalInfo;
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}
