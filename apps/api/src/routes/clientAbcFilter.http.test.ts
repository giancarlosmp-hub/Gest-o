import assert from "node:assert/strict";
import { once } from "node:events";
import { classifyAbcCurve } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: filtro GET /clients?abc=A|B|C pela mesma Curva ABC do Dashboard (ganhos efetivos do CRM
// nos últimos 90 dias, só clientes da carteira, sem arquivados) e a classe em cada cliente da lista.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const client = (id: string, ownerSellerId: string, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, ownerSellerId, state: "PR", isArchived: false, lastPurchaseDate: null, financialProfile: null, tenantId: "tenant-a", ...extra,
});
const clients: Row[] = [
  client("a1", "seller-a"),
  client("a2", "seller-a"),
  client("a3", "seller-a", { state: "SC" }),
  client("a4", "seller-a"),
  client("a5", "seller-a"),
  client("a-sem-compra", "seller-a"),
  client("a-compra-antiga", "seller-a"),
  client("a-cancelado", "seller-a"),
  client("a-arquivado", "seller-a", { isArchived: true }),
  client("b1", "seller-b"),
  client("b2", "seller-b"),
  client("b3", "seller-b"),
];
const won = (id: string, clientId: string, value: number, closedAt = daysAgo(10), ownerSellerId = clients.find((row) => row.id === clientId)!.ownerSellerId): Row => ({
  id, clientId, value, closedAt, ownerSellerId, stage: "ganho", expectedCloseDate: closedAt,
});
const wonOpportunities: Row[] = [
  won("opp-a1", "a1", 500),
  // Oportunidade de outro vendedor em cliente de A: conta para o cliente (carteira = dono do cliente).
  won("opp-a2", "a2", 400, daysAgo(10), "seller-b"),
  won("opp-a3", "a3", 300),
  won("opp-a4", "a4", 150),
  won("opp-a4-2", "a4", 50),
  won("opp-a5", "a5", 100),
  won("opp-antiga", "a-compra-antiga", 9000, daysAgo(120)),
  won("opp-cancelada", "a-cancelado", 7000),
  won("opp-arquivado", "a-arquivado", 8000),
  won("opp-b1", "b1", 1000),
  won("opp-b2", "b2", 50),
  won("opp-b3", "b3", 50),
];
// Pedido cancelado no ERP zera o ganho: o cliente não entra na curva.
const erpOrders: Row[] = [
  { id: "order-cancelado", opportunityId: "opp-cancelada", tenantId: "tenant-a", status: "sent", operationalOrderStatus: "CANCELADO", pedidoIdImportacao: "PED-FICTICIO-1", erpOrderId: null, erpOrderNumber: null, supersedesErpOrderSyncId: null, payloadSent: {} },
];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const inRange = (date: Date | null, range: Row) =>
  Boolean(date) && (!range.gte || date! >= range.gte) && (!range.lt || date! < range.lt) && (!range.lte || date! <= range.lte);
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (value as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (value as Row[]).some((part) => matches(row, part));
    if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
    if (value && typeof value === "object" && "equals" in value) return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
    if (value && typeof value === "object" && ("gte" in value || "lt" in value || "lte" in value)) return inRange(row[key], value);
    return row[key] === value;
  });
const clientById = (id: string) => clients.find((row) => row.id === id)!;

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
  findMany: async ({ where }: any) => {
    if (where?.opportunityId) return erpOrders.filter((order) => where.opportunityId.in.includes(order.opportunityId) && order.status === where.status);
    return [];
  },
});
setModel("opportunity", {
  findMany: async ({ where }: any) => {
    const { client: clientWhere, ...rest } = where ?? {};
    return wonOpportunities
      .filter((row) => matches(row, rest) && (!clientWhere || matches(clientById(row.clientId), clientWhere)))
      .map((row) => ({ ...row, client: { tenantId: clientById(row.clientId).tenantId } }));
  },
});

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
const classes = ["A", "B", "C"] as const;
const noClass = ["a-sem-compra", "a-compra-antiga", "a-cancelado", "a-arquivado"];

try {
  // Regra pura: 20% / 50% arredondados para cima, sem faturamento fora, empate desempatado pelo id.
  assert.deepEqual(
    [...classifyAbcCurve(new Map([["z", 50], ["y", 50], ["x", 1000], ["w", 0]])).entries()],
    [["x", "A"], ["y", "B"], ["z", "C"]],
  );

  // Gestão (carteira inteira): 8 clientes com faturamento -> A 2, B 2, C 4.
  const expectedAll: Record<string, string[]> = { A: ["a1", "b1"], B: ["a2", "a3"], C: ["a4", "a5", "b2", "b3"] };
  const dashboard = await get("/dashboard/portfolio");
  assert.equal(dashboard.status, 200);
  for (const abc of classes) {
    const list = await get(`/clients?page=1&pageSize=20&abc=${abc}`);
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list.json), expectedAll[abc], `classe ${abc}`);
    assert.equal(list.json.total, dashboard.json.abcCurve[abc].clients, `total de ${abc} = Dashboard`);
    assert(list.json.items.every((item: Row) => item.abcClass === abc), `classe ${abc} em cada linha`);
  }
  assert.equal(Math.round(dashboard.json.abcCurve.A.percentRevenue), Math.round((1500 / 2600) * 100));
  assert.equal(dashboard.json.totalClients, 11, "carteira continua com todos os não arquivados");

  // Sem compra em 90 dias, só com ganho cancelado ou arquivado: fora de A, B e C.
  for (const abc of classes) {
    const list = await get(`/clients?page=1&pageSize=20&abc=${abc}`);
    assert(!ids(list.json).some((id: string) => noClass.includes(id)), `sem compra fora de ${abc}`);
  }
  assert.deepEqual((await get("/clients?page=1&pageSize=20&abc=A&includeArchived=1")).json, { items: [], total: 0, page: 1, pageSize: 20 });

  // Vendedor: só a própria carteira, classificada só com ela, e bate com o Dashboard dele.
  const expectedSellerA: Record<string, string[]> = { A: ["a1"], B: ["a2", "a3"], C: ["a4", "a5"] };
  const sellerDashboard = await get("/dashboard/portfolio", "seller-a");
  for (const abc of classes) {
    const list = await get(`/clients?page=1&pageSize=20&abc=${abc}&ownerSellerId=seller-b`, "seller-a");
    assert.deepEqual(ids(list.json), expectedSellerA[abc], `vendedor A classe ${abc}`);
    assert.equal(list.json.total, sellerDashboard.json.abcCurve[abc].clients, `vendedor A: total de ${abc} = Dashboard`);
  }
  const expectedSellerB: Record<string, string[]> = { A: ["b1"], B: ["b2"], C: ["b3"] };
  for (const abc of classes) {
    assert.deepEqual(ids((await get(`/clients?page=1&pageSize=20&abc=${abc}`, "seller-b")).json), expectedSellerB[abc], `vendedor B classe ${abc}`);
  }

  // Gestão com filtro de vendedor = Dashboard filtrado pelo mesmo vendedor.
  const dashboardSellerA = await get("/dashboard/portfolio?sellerId=seller-a");
  for (const abc of classes) {
    const list = await get(`/clients?page=1&pageSize=20&abc=${abc}&ownerSellerId=seller-a`, "manager-a");
    assert.deepEqual(ids(list.json), expectedSellerA[abc]);
    assert.equal(list.json.total, dashboardSellerA.json.abcCurve[abc].clients);
  }

  // Combina com outro filtro: a classe vem da carteira inteira, a UF só recorta a lista.
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=20&abc=B&uf=SC")).json), ["a3"]);
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=20&abc=A&uf=SC")).json), []);
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=20&abc=C&status=prospect")).json), ["a4", "a5", "b2", "b3"]);

  // ?abc= inválido é ignorado e a lista sem filtro não traz a classe.
  const invalid = await get("/clients?page=1&pageSize=20&abc=D");
  assert.equal(invalid.json.total, 11);
  assert(invalid.json.items.every((item: Row) => !("abcClass" in item)));
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_ABC_FILTER=PASS rule=PASS dashboard_total=PASS no_revenue_excluded=PASS archived_excluded=PASS seller_scope=PASS seller_filter=PASS combined=PASS invalid_ignored=PASS");
