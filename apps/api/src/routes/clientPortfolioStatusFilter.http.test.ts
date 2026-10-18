import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: filtro GET /clients?status= pela situação da carteira (mesma regra do card do Dashboard)
// e selo da situação em cada cliente da lista.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const client = (id: string, ownerSellerId: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, ownerSellerId, state: "PR", isArchived: false, lastPurchaseDate, financialProfile: null, ...extra,
});
const clients: Row[] = [
  client("a-ativo", "seller-a", daysAgo(30)),
  client("a-ativo-pedido", "seller-a", daysAgo(900)),
  client("a-ativo-perfil", "seller-a", null, { state: "SC", financialProfile: { DATA_ULTFATURA: daysAgo(60).toISOString() } }),
  client("a-recente", "seller-a", daysAgo(540)),
  client("a-ex", "seller-a", daysAgo(900)),
  client("a-ex-cancelado", "seller-a", daysAgo(900)),
  client("a-prospect", "seller-a", null),
  client("a-arquivado-ativo", "seller-a", daysAgo(10), { isArchived: true }),
  client("a-arquivado-prospect", "seller-a", null, { isArchived: true }),
  client("b-ativo", "seller-b", daysAgo(20)),
  client("b-prospect", "seller-b", null),
];
const erpOrders: Row[] = [
  { clientId: "a-ativo-pedido", status: "sent", sentAt: daysAgo(10), createdAt: daysAgo(10) },
  { clientId: "a-ex", status: "pending", sentAt: null, createdAt: daysAgo(5) },
  { clientId: "a-ex-cancelado", status: "sent", sentAt: daysAgo(6), createdAt: daysAgo(6), operationalOrderStatus: "CANCELADO" },
  { clientId: "a-arquivado-ativo", status: "sent", sentAt: daysAgo(3), createdAt: daysAgo(3) },
];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
    if (value && typeof value === "object" && "equals" in value) return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
    return row[key] === value;
  });

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select, include, skip, take }: any) => {
    const rows = clients
      .filter((row) => matches(row, where))
      .map((row) => (include?.ownerSeller ? { ...row, ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio" } } : pick(row, select)));
    return skip === undefined ? rows : rows.slice(skip, skip + take);
  },
  count: async ({ where }: any) => clients.filter((row) => matches(row, where)).length,
});
setModel("erpOrderSync", {
  findMany: async ({ where }: any) =>
    erpOrders
      .filter((order) => order.status === where.status && matches(clients.find((row) => row.id === order.clientId)!, where.opportunity.client))
      .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, orderStatus: order.orderStatus ?? null, operationalOrderStatus: order.operationalOrderStatus ?? "UNKNOWN", opportunity: { clientId: order.clientId } })),
});
setModel("opportunity", { findMany: async () => [] });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId = "director-a") => {
  const user = users.find((row) => row.id === userId)!;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` },
  });
  return { status: response.status, json: (await response.json()) as any };
};
const ids = (json: any) => json.items.map((item: Row) => item.id).sort();

try {
  // Cada situação filtra pela mesma regra do Dashboard (pedido sent conta; pending e cancelado não).
  const expectedBySituation: Record<string, string[]> = {
    ativo: ["a-ativo", "a-ativo-pedido", "a-ativo-perfil", "b-ativo"],
    inativoRecente: ["a-recente"],
    exCliente: ["a-ex", "a-ex-cancelado"],
    prospect: ["a-prospect", "b-prospect"],
  };
  const dashboard = await get("/dashboard/portfolio");
  assert.equal(dashboard.status, 200);
  for (const [status, expected] of Object.entries(expectedBySituation)) {
    const list = await get(`/clients?page=1&pageSize=20&status=${status}`);
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list.json), expected, `situação ${status}`);
    assert.equal(list.json.total, dashboard.json.walletStatus[status], `total de ${status} = fatia do Dashboard`);
    assert(list.json.items.every((item: Row) => item.portfolioStatus === status), `selo ${status}`);
  }

  // Combina com o filtro de vendedor; o total bate com o Dashboard do mesmo vendedor.
  const dashboardSellerA = await get("/dashboard/portfolio?sellerId=seller-a");
  for (const status of Object.keys(expectedBySituation)) {
    const list = await get(`/clients?page=1&pageSize=20&status=${status}&ownerSellerId=seller-a`, "manager-a");
    assert(list.json.items.every((item: Row) => item.ownerSellerId === "seller-a"));
    assert.equal(list.json.total, dashboardSellerA.json.walletStatus[status], `total de ${status} do vendedor = fatia do Dashboard`);
  }
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=20&status=ativo&ownerSellerId=seller-a", "manager-a")).json), ["a-ativo", "a-ativo-pedido", "a-ativo-perfil"]);

  // Combina com os demais filtros e com a paginação.
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=20&status=ativo&uf=SC")).json), ["a-ativo-perfil"]);
  const page1 = await get("/clients?page=1&pageSize=3&status=ativo");
  const page2 = await get("/clients?page=2&pageSize=3&status=ativo");
  assert.equal(page1.json.items.length, 3);
  assert.equal(page2.json.items.length, 1);
  assert.equal(page2.json.total, 4);
  assert.deepEqual([...ids(page1.json), ...ids(page2.json)].sort(), expectedBySituation.ativo);

  // Arquivado nunca aparece, nem com "Mostrar arquivados".
  for (const status of Object.keys(expectedBySituation)) {
    const list = await get(`/clients?page=1&pageSize=20&status=${status}`);
    assert(!ids(list.json).some((id: string) => id.includes("arquivado")), `arquivado fora de ${status}`);
  }
  const archivedOnly = await get("/clients?page=1&pageSize=20&status=ativo&includeArchived=1");
  assert.deepEqual(archivedOnly.json, { items: [], total: 0, page: 1, pageSize: 20 });

  // ?status= inválido é ignorado: lista todos os não arquivados.
  const invalid = await get("/clients?page=1&pageSize=20&status=ativos");
  assert.equal(invalid.json.total, 9);
  assert.equal(invalid.json.items.length, 9);
  const invalidNoPage = await get("/clients?status=inativos_antigos");
  assert(Array.isArray(invalidNoPage.json), "sem paginação continua no formato antigo");
  assert.equal(invalidNoPage.json.length, 9);

  // Lista sem filtro de situação também traz o selo de cada cliente.
  const all = await get("/clients?page=1&pageSize=20");
  const statusById = Object.fromEntries(all.json.items.map((item: Row) => [item.id, item.portfolioStatus]));
  for (const [status, expected] of Object.entries(expectedBySituation)) {
    for (const id of expected) assert.equal(statusById[id], status, `selo de ${id}`);
  }

  // Vendedor usa o filtro só dentro da própria carteira (ownerSellerId de outro é ignorado).
  const sellerList = await get("/clients?page=1&pageSize=20&status=ativo&ownerSellerId=seller-b", "seller-a");
  assert.deepEqual(ids(sellerList.json), ["a-ativo", "a-ativo-pedido", "a-ativo-perfil"]);
  const sellerDashboard = await get("/dashboard/portfolio", "seller-a");
  assert.equal(sellerList.json.total, sellerDashboard.json.walletStatus.ativo);
  const sellerB = await get("/clients?page=1&pageSize=20&status=prospect", "seller-b");
  assert.deepEqual(ids(sellerB.json), ["b-prospect"]);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_PORTFOLIO_STATUS_FILTER=PASS bands=PASS seller_filter=PASS dashboard_total=PASS pagination=PASS archived_excluded=PASS invalid_ignored=PASS seller_scope=PASS");
