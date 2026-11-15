import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// GET /events: a linha do tempo é do cliente. Depois da troca de carteira, o vendedor novo vê o histórico inteiro
// (com o autor de cada evento) e o vendedor antigo deixa de ver o cliente. Dados fictícios; Prisma simulado.
type Row = Record<string, any>;

const users: Row[] = [
  { id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A" },
  { id: "seller-b", role: "vendedor", name: "Vendedor Ficticio B" },
  { id: "manager-a", role: "gerente", name: "Gerente Ficticio" },
  { id: "director-a", role: "diretor", name: "Diretor Ficticio" }
];
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 10, 12, minutes));

// cliente-x passou de seller-a para seller-b; cliente-arq está arquivado, dono seller-b, com oportunidade antiga de seller-a.
const clients: Row[] = [
  { id: "cliente-x", name: "Cliente Ficticio X", ownerSellerId: "seller-b", isArchived: false },
  { id: "cliente-arq", name: "Cliente Ficticio Arquivado", ownerSellerId: "seller-b", isArchived: true },
  { id: "cliente-y", name: "Cliente Ficticio Y", ownerSellerId: "seller-a", isArchived: false }
];
const opportunities: Row[] = [
  { id: "opp-antiga", title: "Oportunidade ficticia antiga", clientId: "cliente-x", ownerSellerId: "seller-a" },
  { id: "opp-nova", title: "Oportunidade ficticia nova", clientId: "cliente-x", ownerSellerId: "seller-b" },
  { id: "opp-arq", title: "Oportunidade ficticia arquivada", clientId: "cliente-arq", ownerSellerId: "seller-a" },
  { id: "opp-y", title: "Oportunidade ficticia Y", clientId: "cliente-y", ownerSellerId: "seller-a" }
];
const timeline: Row[] = [
  { id: "ev-a1", type: "status", description: "Evento ficticio 1 de A", clientId: "cliente-x", opportunityId: "opp-antiga", ownerSellerId: "seller-a", createdAt: at(1) },
  { id: "ev-a2", type: "comentario", description: "Evento ficticio 2 de A", clientId: "cliente-x", opportunityId: "opp-antiga", ownerSellerId: "seller-a", createdAt: at(2) },
  // Evento antigo sem clientId, só ligado à oportunidade do cliente.
  { id: "ev-a3", type: "mudanca_etapa", description: "Evento ficticio 3 de A", clientId: null, opportunityId: "opp-antiga", ownerSellerId: "seller-a", createdAt: at(3) },
  { id: "ev-a4", type: "status", description: "Evento ficticio 4 de A", clientId: "cliente-x", opportunityId: null, ownerSellerId: "seller-a", createdAt: at(4) },
  { id: "ev-b1", type: "comentario", description: "Evento ficticio 1 de B", clientId: "cliente-x", opportunityId: "opp-nova", ownerSellerId: "seller-b", createdAt: at(5) },
  { id: "ev-b2", type: "status", description: "Evento ficticio 2 de B", clientId: "cliente-x", opportunityId: null, ownerSellerId: "seller-b", createdAt: at(6) },
  { id: "ev-arq-a", type: "comentario", description: "Evento ficticio arquivado de A", clientId: "cliente-arq", opportunityId: "opp-arq", ownerSellerId: "seller-a", createdAt: at(7) },
  { id: "ev-arq-b", type: "status", description: "Evento ficticio arquivado de B", clientId: "cliente-arq", opportunityId: null, ownerSellerId: "seller-b", createdAt: at(8) },
  { id: "ev-y", type: "status", description: "Evento ficticio de Y", clientId: "cliente-y", opportunityId: "opp-y", ownerSellerId: "seller-a", createdAt: at(9) }
];

const opportunityOf = (row: Row) => opportunities.find((candidate) => candidate.id === row.opportunityId) ?? null;
const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return ([] as Row[]).concat(condition).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "opportunity") { const related = opportunityOf(row); return related ? matches(related, condition) : false; }
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    if (key === "opportunities") return opportunities.some((opportunity) => opportunity.clientId === row.id && matches(opportunity, condition.some));
    if (condition === null) return row[key] === null || row[key] === undefined;
    if (typeof condition === "object") throw new Error(`Filtro não simulado: ${key}`);
    return row[key] === condition;
  });

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.name, role: user.role, region: null, isActive: true } : null;
  },
  findUnique: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, name: user.name, role: user.role, isActive: true } : null;
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", { findFirst: async ({ where }: any) => { const row = clients.find((candidate) => matches(candidate, where)); return row ? { id: row.id } : null; } });
setModel("opportunity", { findFirst: async ({ where }: any) => { const row = opportunities.find((candidate) => matches(candidate, where)); return row ? { id: row.id } : null; } });
setModel("timelineEvent", {
  findMany: async ({ where, cursor, skip = 0, take }: any) => {
    const sorted = timeline.filter((event) => matches(event, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    const start = cursor ? sorted.findIndex((event) => event.id === cursor.id) + skip : 0;
    return sorted.slice(start, start + take).map((event) => {
      const owner = users.find((user) => user.id === event.ownerSellerId)!;
      const opportunity = opportunityOf(event);
      const client = clientOf(event);
      return {
        ...event,
        ownerSeller: { id: owner.id, name: owner.name },
        opportunity: opportunity ? { id: opportunity.id, title: opportunity.title } : null,
        client: client ? { id: client.id, name: client.name } : null
      };
    });
  }
});

const originalInfo = console.info;
console.info = () => undefined;
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (userId: string, path: string) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const ids = (json: any) => (json.items as Row[]).map((item) => item.id);
const ALL_X = ["ev-b2", "ev-b1", "ev-a4", "ev-a3", "ev-a2", "ev-a1"];

try {
  // (a) Vendedor novo vê todo o histórico do cliente, com o autor de cada evento preservado.
  const sellerB = await get("seller-b", "/events?clientId=cliente-x&take=20");
  assert.equal(sellerB.status, 200);
  assert.deepEqual(ids(sellerB.json), ALL_X);
  assert.equal(sellerB.json.items.find((item: Row) => item.id === "ev-a2").ownerSeller.name, "Vendedor Ficticio A");
  assert.equal(sellerB.json.items.find((item: Row) => item.id === "ev-b1").ownerSeller.name, "Vendedor Ficticio B");
  assert.equal(sellerB.json.nextCursor, null);

  // (b) Vendedor antigo deixa de ver o cliente: 404 na ficha e na linha do tempo.
  assert.equal((await get("seller-a", "/clients/cliente-x")).status, 404);
  const sellerAClient = await get("seller-a", "/events?clientId=cliente-x");
  assert.equal(sellerAClient.status, 404);
  assert.equal(sellerAClient.json.items, undefined, "nenhum evento vaza no 404");
  assert.equal((await get("seller-a", "/events?clientId=cliente-x&opportunityId=opp-antiga")).status, 404);

  // (c) Vendedor antigo continua vendo a própria oportunidade antiga e todos os eventos dela.
  const sellerAOpp = await get("seller-a", "/events?opportunityId=opp-antiga");
  assert.equal(sellerAOpp.status, 200);
  assert.deepEqual(ids(sellerAOpp.json), ["ev-a3", "ev-a2", "ev-a1"]);

  // (d) Vendedor novo não abre a linha do tempo da oportunidade antiga, que não é dele.
  assert.equal((await get("seller-b", "/events?opportunityId=opp-antiga")).status, 404);
  assert.equal((await get("seller-b", "/events?clientId=cliente-x&opportunityId=opp-antiga")).status, 404);
  assert.deepEqual(ids((await get("seller-b", "/events?opportunityId=opp-nova")).json), ["ev-b1"]);

  // (e) Gerente e diretor veem tudo do cliente e da oportunidade.
  for (const userId of ["manager-a", "director-a"]) {
    assert.deepEqual(ids((await get(userId, "/events?clientId=cliente-x&take=20")).json), ALL_X, userId);
    assert.deepEqual(ids((await get(userId, "/events?opportunityId=opp-antiga")).json), ["ev-a3", "ev-a2", "ev-a1"], userId);
  }
  assert.equal((await get("manager-a", "/events?clientId=cliente-inexistente")).status, 404);

  // (f) Cliente arquivado segue a regra da ficha: o dono e o vendedor com oportunidade do cliente veem o histórico inteiro.
  for (const userId of ["seller-a", "seller-b"]) {
    const archived = await get(userId, "/events?clientId=cliente-arq");
    assert.equal(archived.status, 200, userId);
    assert.deepEqual(ids(archived.json), ["ev-arq-b", "ev-arq-a"], userId);
  }
  assert.equal((await get("seller-b", "/events?clientId=cliente-y")).status, 404, "cliente ativo de outra carteira");

  // (g) Paginação por cursor continua funcionando com o histórico inteiro.
  const page1 = await get("seller-b", "/events?clientId=cliente-x&take=4");
  assert.deepEqual(ids(page1.json), ALL_X.slice(0, 4));
  assert.equal(page1.json.nextCursor, "ev-a3");
  const page2 = await get("seller-b", `/events?clientId=cliente-x&take=4&cursor=${page1.json.nextCursor}`);
  assert.deepEqual(ids(page2.json), ALL_X.slice(4));
  assert.equal(page2.json.nextCursor, null);

  // (h) Sem cliente nem oportunidade, o filtro continua sendo o vendedor do evento.
  assert.deepEqual(ids((await get("seller-b", "/events?take=50")).json), ["ev-arq-b", "ev-b2", "ev-b1"]);
  assert.deepEqual(ids((await get("seller-a", "/events?take=50")).json), ["ev-y", "ev-arq-a", "ev-a4", "ev-a3", "ev-a2", "ev-a1"]);
  assert.equal(ids((await get("manager-a", "/events?take=50")).json).length, timeline.length);

  console.log("clientTimelineOwnerChange.http.test: ok");
} finally {
  console.info = originalInfo;
  server.close();
}
