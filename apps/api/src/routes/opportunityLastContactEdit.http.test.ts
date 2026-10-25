import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios; Prisma simulado. Último contato da oportunidade: a edição só avança a data (outro campo não muda
// o valor; data anterior ou vazia é ignorada, também para gerente e diretor) e o contato por WhatsApp avança a data.
type Row = Record<string, any>;

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
];
const CURRENT = new Date("2026-10-20T14:30:00.000Z");
const clients: Row[] = [{ id: "cli-a", name: "Cliente Ficticio A", ownerSellerId: "seller-a", isArchived: false, tenantId: "tenant-a" }];
const opportunities: Row[] = [
  {
    id: "opp-a", title: "Proposta ficticia", value: 1000, stage: "proposta", probability: 50, notes: null, clientId: "cli-a", ownerSellerId: "seller-a",
    proposalDate: new Date("2026-10-01T12:00:00.000Z"), followUpDate: new Date("2026-11-05T12:00:00.000Z"), expectedCloseDate: new Date("2026-11-30T12:00:00.000Z"),
    lastContactAt: CURRENT, closedAt: null, createdAt: new Date("2026-10-01T12:00:00.000Z"),
  },
];
const activities: Row[] = [];
const updates: Row[] = [];

const matchValue = (value: any, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("lt" in condition) return value !== null && value !== undefined && value < condition.lt;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    return matchValue(row[key], condition);
  });
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
const opportunity = () => opportunities[0];

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", { findFirst: async ({ where }: any) => clients.find((row) => matches(row, where)) ?? null });
setModel("opportunity", {
  findUnique: async ({ where }: any) => {
    const row = opportunities.find((item) => item.id === where.id);
    return row ? { ...row, ownerSeller: { name: "Vendedor Ficticio" }, client: { tenantId: "tenant-a" } } : null;
  },
  findFirst: async ({ where }: any) => opportunities.find((row) => matches(row, where)) ?? null,
  update: async ({ where, data }: any) => {
    const row = opportunities.find((item) => item.id === where.id)!;
    updates.push(data);
    Object.assign(row, data);
    return { ...row };
  },
  updateMany: async ({ where, data }: any) => {
    const rows = opportunities.filter((row) => matches(row, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
});
setModel("activity", { create: async ({ data }: any) => { const row = { id: `act-${activities.length + 1}`, ...data }; activities.push(row); return row; } });
setModel("timelineEvent", { create: async ({ data }: any) => ({ id: "tl-ficticio", ...data }) });
(prisma as any).$transaction = async (callback: any) => (typeof callback === "function" ? callback(prisma) : Promise.all(callback));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as any };
};

const results: string[] = [];
try {
  // Editar outro campo não muda o último contato.
  const other = await call("PUT", "/opportunities/opp-a", "seller-a", { title: "Proposta ficticia revisada" });
  assert.equal(other.status, 200);
  assert.equal(opportunity().title, "Proposta ficticia revisada");
  assert.equal(opportunity().lastContactAt.toISOString(), CURRENT.toISOString());
  assert.equal(new Date(other.json.lastContactAt).toISOString(), CURRENT.toISOString());
  results.push("other_field_keeps_last_contact=PASS");

  // Voltar a data (dia anterior, o mesmo dia sem hora ou vazio) é ignorado; os demais campos são gravados.
  for (const [userId, lastContactAt] of [
    ["seller-a", "2026-10-10T12:00:00.000Z"],
    ["seller-a", "2026-10-20"],
    ["seller-a", ""],
    ["manager-a", "2026-10-01T12:00:00.000Z"],
    ["director-a", "2026-10-01T12:00:00.000Z"],
  ] as const) {
    const back = await call("PUT", "/opportunities/opp-a", userId, { lastContactAt, notes: `Nota ficticia ${userId}` });
    assert.equal(back.status, 200, `${userId} ${lastContactAt}`);
    assert.equal(opportunity().lastContactAt.toISOString(), CURRENT.toISOString(), `${userId} não volta para ${lastContactAt || "vazio"}`);
    assert.equal(new Date(back.json.lastContactAt).toISOString(), CURRENT.toISOString(), "a resposta mostra o valor gravado");
    assert.equal(opportunity().notes, `Nota ficticia ${userId}`, "o resto da edição é gravado");
  }
  assert(updates.every((data) => !("lastContactAt" in data)), "o update comum nunca grava lastContactAt");
  results.push("going_back_ignored_all_roles=PASS");

  // Data mais recente avança.
  const forward = await call("PUT", "/opportunities/opp-a", "seller-a", { lastContactAt: "2026-10-22T13:15:00.000Z" });
  assert.equal(forward.status, 200);
  assert.equal(opportunity().lastContactAt.toISOString(), "2026-10-22T13:15:00.000Z");
  assert.equal(new Date(forward.json.lastContactAt).toISOString(), "2026-10-22T13:15:00.000Z");
  results.push("newer_date_advances=PASS");

  // Contato por WhatsApp com oportunidade: a atividade criada avança o último contato.
  const before = Date.now();
  const whatsapp = await call("POST", "/assistant-whatsapp/contact", "seller-a", { clientId: "cli-a", opportunityId: "opp-a" });
  assert.equal(whatsapp.status, 201);
  assert.equal(activities.at(-1)!.opportunityId, "opp-a");
  assert(opportunity().lastContactAt.getTime() >= before, "WhatsApp avança o último contato para agora");
  assert.equal(opportunity().lastContactAt.getTime(), activities.at(-1)!.date.getTime(), "a data é a da atividade");
  results.push("whatsapp_advances=PASS");

  console.log(`OPPORTUNITY_LAST_CONTACT_EDIT=PASS ${results.join(" ")}`);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
