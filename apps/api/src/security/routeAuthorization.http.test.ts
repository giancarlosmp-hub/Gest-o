import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; tenants: string[] }> = {
  "seller-a": { role: "vendedor", tenants: ["tenant-a"] },
  "seller-b": { role: "vendedor", tenants: ["tenant-a"] },
  "manager-a": { role: "gerente", tenants: ["tenant-a"] },
  "director-a": { role: "diretor", tenants: ["tenant-a"] },
  "seller-c": { role: "vendedor", tenants: ["tenant-b"] },
  "seller-no-tenant": { role: "vendedor", tenants: [] },
};

let clients: Row[] = [];
let opportunities: Row[] = [];
let contacts: Row[] = [];

const resetData = () => {
  clients = [
    { id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente A", cnpjNormalized: "11111111000111", isArchived: false },
    { id: "client-b", tenantId: "tenant-a", ownerSellerId: "seller-b", name: "Cliente B", cnpjNormalized: "11111111000111", isArchived: false },
    { id: "client-other", tenantId: "tenant-b", ownerSellerId: "seller-c", name: "Cliente Outro Tenant", cnpjNormalized: "11111111000111", isArchived: false },
  ];
  opportunities = [
    { id: "opp-a", clientId: "client-a", ownerSellerId: "seller-a" },
    { id: "opp-a2", clientId: "client-a", ownerSellerId: "seller-a" },
    { id: "opp-b", clientId: "client-b", ownerSellerId: "seller-b" },
    { id: "opp-other", clientId: "client-other", ownerSellerId: "seller-c" },
  ];
  contacts = [
    { id: "contact-a", clientId: "client-a", ownerSellerId: "seller-a", name: "Contato A" },
    { id: "contact-b", clientId: "client-b", ownerSellerId: "seller-b", name: "Contato B" },
    { id: "contact-orphan-b", clientId: null, ownerSellerId: "seller-b", name: "Contato sem cliente B" },
    { id: "contact-other", clientId: "client-other", ownerSellerId: "seller-c", name: "Contato Outro Tenant" },
  ];
};

const membershipsOf = (userId: string) => (users[userId]?.tenants ?? []).map((tenantId) => ({ tenantId, status: "active" }));
const clientById = (id: string | null) => clients.find((client) => client.id === id) ?? null;

const opportunityView = (row: Row) => ({
  ...row,
  title: `Oportunidade ${row.id}`,
  stage: "prospeccao",
  crop: null,
  productOffered: null,
  value: 1000,
  probability: null,
  notes: null,
  followUpDate: null,
  lastContactAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  client: clientById(row.clientId),
  ownerSeller: { name: row.ownerSellerId },
  timelineEvents: [],
  activities: [],
});
const contactView = (row: Row) => ({ ...row, client: clientById(row.clientId), ownerSeller: { tenantMemberships: membershipsOf(row.ownerSellerId) } });

// Strict evaluator: any where key the fixture does not model fails the test instead of matching silently.
const matches = (row: Row | null, where: Row | undefined): boolean => {
  if (!where) return true;
  if (!row) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "OR") return (expected as Row[]).some((branch) => matches(row, branch));
    if (!(key in row)) throw new Error(`where key não modelada no teste: ${key}`);
    const actual = row[key];
    if (expected === null) return actual === null;
    if (typeof expected === "object" && "some" in expected) return (actual as Row[]).some((item) => matches(item, expected.some));
    if (typeof expected === "object" && "not" in expected) return actual !== expected.not;
    if (typeof expected === "object") return matches(actual, expected);
    return actual === expected;
  });
};

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null } : null),
});
setModel("tenantMembership", {
  findMany: async ({ where }: any) => membershipsOf(where.userId).map(({ tenantId }) => ({ tenantId })),
});
setModel("knowledgeDocument", { findMany: async () => [] });
setModel("opportunity", {
  findFirst: async ({ where }: any) => opportunities.map(opportunityView).find((row) => matches(row, where)) ?? null,
  delete: async ({ where }: any) => {
    const removed = opportunities.find((row) => row.id === where.id);
    opportunities = opportunities.filter((row) => row.id !== where.id);
    return removed;
  },
});
setModel("client", {
  findFirst: async ({ where }: any) => clients.find((row) => matches(row, where)) ?? null,
  findMany: async ({ where }: any) => clients.filter((row) => matches(row, where)).map((row) => ({ ...row, _count: { opportunities: 0, activities: 0, timelineEvents: 0 } })),
  groupBy: async ({ where }: any) => {
    const counts = new Map<string, number>();
    for (const row of clients.filter((client) => matches(client, where))) counts.set(row.cnpjNormalized, (counts.get(row.cnpjNormalized) ?? 0) + 1);
    return [...counts].filter(([, count]) => count > 1).map(([cnpjNormalized, count]) => ({ cnpjNormalized, _count: { cnpjNormalized: count } }));
  },
  delete: async ({ where }: any) => {
    const removed = clients.find((row) => row.id === where.id);
    clients = clients.filter((row) => row.id !== where.id);
    return removed;
  },
});
setModel("contact", {
  findFirst: async ({ where }: any) => contacts.map(contactView).find((row) => matches(row, where)) ?? null,
  update: async ({ where, data }: any) => {
    const index = contacts.findIndex((row) => row.id === where.id);
    contacts[index] = { ...contacts[index], ...data };
    return contacts[index];
  },
  delete: async ({ where }: any) => {
    const removed = contacts.find((row) => row.id === where.id);
    contacts = contacts.filter((row) => row.id !== where.id);
    return removed;
  },
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = (userId: string, method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const status = async (userId: string, method: string, path: string, body?: unknown) => (await call(userId, method, path, body)).status;
const exists = (rows: Row[], id: string) => rows.some((row) => row.id === id);

try {
  // Vendedor A não lê, edita nem apaga registros do vendedor B: 404 sem revelar existência.
  resetData();
  assert.equal(await status("seller-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-b" }), 404);
  assert.equal(await status("seller-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-b"), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/opportunities/opp-b"), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/companies/client-b"), 404);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-b", { name: "Invasor" }), 404);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-orphan-b", { name: "Invasor" }), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-b"), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-orphan-b"), 404);
  assert(exists(opportunities, "opp-b") && exists(clients, "client-b"), "registros de B não podem ser apagados por A");
  assert(exists(contacts, "contact-b") && exists(contacts, "contact-orphan-b"), "contatos de B não podem ser apagados por A");
  assert.equal(contacts.find((row) => row.id === "contact-b")?.name, "Contato B", "contato de B não pode ser editado por A");

  // Vendedor A mantém acesso aos próprios registros, sem poder repassar dono nem apontar para cliente alheio.
  assert.equal(await status("seller-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-a" }), 200);
  assert.equal(await status("seller-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-a"), 200);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-a", { name: "Contato A2", ownerSellerId: "seller-b" }), 200);
  assert.equal(contacts.find((row) => row.id === "contact-a")?.ownerSellerId, "seller-a", "vendedor não pode transferir o contato para outro dono");
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-a", { clientId: "client-b" }), 404);
  assert.equal(contacts.find((row) => row.id === "contact-a")?.clientId, "client-a");
  assert.equal(await status("seller-a", "DELETE", "/api/opportunities/opp-a2"), 204);
  assert(!exists(opportunities, "opp-a2"));
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-a"), 204);

  // Gerente pode tudo dentro do próprio tenant, inclusive contato sem cliente vinculado.
  resetData();
  assert.equal(await status("manager-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-b" }), 200);
  assert.equal(await status("manager-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-b"), 200);
  assert.equal(await status("manager-a", "PUT", "/api/contacts/contact-b", { name: "Editado pelo gerente" }), 200);
  assert.equal(contacts.find((row) => row.id === "contact-b")?.name, "Editado pelo gerente");
  assert.equal(await status("manager-a", "PUT", "/api/contacts/contact-orphan-b", { name: "Órfão editado" }), 200);
  assert.equal(await status("manager-a", "DELETE", "/api/contacts/contact-orphan-b"), 204);
  assert.equal(await status("manager-a", "DELETE", "/api/opportunities/opp-b"), 204);
  assert.equal(await status("manager-a", "DELETE", "/api/companies/client-b"), 204);
  assert(!exists(opportunities, "opp-b") && !exists(clients, "client-b") && !exists(contacts, "contact-orphan-b"));

  // Gerente e diretor não alcançam registros de outro tenant.
  for (const userId of ["manager-a", "director-a"]) {
    assert.equal(await status(userId, "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-other" }), 404);
    assert.equal(await status(userId, "GET", "/api/ai/opportunity-message?opportunityId=opp-other"), 404);
    assert.equal(await status(userId, "DELETE", "/api/opportunities/opp-other"), 404);
    assert.equal(await status(userId, "DELETE", "/api/companies/client-other"), 404);
    assert.equal(await status(userId, "PUT", "/api/contacts/contact-other", { name: "Cross-tenant" }), 404);
    assert.equal(await status(userId, "DELETE", "/api/contacts/contact-other"), 404);
  }
  assert(exists(opportunities, "opp-other") && exists(clients, "client-other") && exists(contacts, "contact-other"));

  // duplicate-documents: 403 para vendedor; gerente/diretor só enxergam o próprio tenant.
  resetData();
  assert.equal(await status("seller-a", "GET", "/api/clients/diagnostics/duplicate-documents"), 403);
  for (const userId of ["manager-a", "director-a"]) {
    const response = await call(userId, "GET", "/api/clients/diagnostics/duplicate-documents");
    assert.equal(response.status, 200);
    const payload = await response.json() as { duplicates: Array<{ totalClients: number; clients: Row[] }> };
    assert.equal(payload.duplicates.length, 1);
    assert.equal(payload.duplicates[0].totalClients, 2);
    assert.deepEqual(payload.duplicates[0].clients.map((client) => client.id).sort(), ["client-a", "client-b"]);
  }

  // Sem tenant ativo: 403 explícito, sem tocar nos dados.
  assert.equal(await status("seller-no-tenant", "DELETE", "/api/opportunities/opp-a"), 403);
  assert.equal(await status("seller-no-tenant", "GET", "/api/ai/opportunity-message?opportunityId=opp-a"), 403);
  assert(exists(opportunities, "opp-a"));

  console.log("route authorization HTTP regression passed");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
