import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: carteira do Dashboard pela última compra do ERP, selo no detalhe do cliente e
// vendedores inativos nos rankings (só aparecem com valor > 0, marcados "(desligado)").
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", name: "Diretora Ficticia", role: "diretor", isActive: true },
  { id: "seller-ativo", name: "Vendedor Ficticio Ativo", role: "vendedor", isActive: true },
  { id: "seller-desligado-com-venda", name: "Vendedor Ficticio Com Venda", role: "vendedor", isActive: false },
  { id: "seller-desligado-sem-venda", name: "Vendedor Ficticio Sem Venda", role: "vendedor", isActive: false },
];
const clients: Row[] = [
  { id: "c-ativo", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: daysAgo(30), financialProfile: null },
  { id: "c-recente", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: daysAgo(540), financialProfile: null },
  { id: "c-ex", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: daysAgo(900), financialProfile: null },
  { id: "c-prospect", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: null, financialProfile: null },
  { id: "c-perfil", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: daysAgo(60).toISOString() } },
  { id: "c-pedido-enviado", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: daysAgo(900), financialProfile: null },
  { id: "c-pedido-pendente", ownerSellerId: "seller-ativo", isArchived: false, lastPurchaseDate: daysAgo(900), financialProfile: null },
  { id: "c-arquivado", ownerSellerId: "seller-ativo", isArchived: true, lastPurchaseDate: daysAgo(10), financialProfile: null },
  { id: "c-outro-vendedor", ownerSellerId: "seller-desligado-com-venda", isArchived: false, lastPurchaseDate: null, financialProfile: null },
];
const erpOrders: Row[] = [
  { clientId: "c-pedido-enviado", status: "sent", sentAt: daysAgo(10), createdAt: daysAgo(10) },
  { clientId: "c-pedido-pendente", status: "pending", sentAt: null, createdAt: daysAgo(5) },
  { clientId: "c-pedido-pendente", status: "error", sentAt: null, createdAt: daysAgo(4) },
  { clientId: "c-arquivado", status: "sent", sentAt: daysAgo(3), createdAt: daysAgo(3) },
];
const wonOpportunities: Row[] = [
  { id: "opp-ativo", ownerSellerId: "seller-ativo", clientId: "c-ativo", value: 1000 },
  { id: "opp-desligado", ownerSellerId: "seller-desligado-com-venda", clientId: "c-outro-vendedor", value: 1500 },
].map((row) => ({
  ...row,
  stage: "ganho",
  title: "Oportunidade Ficticia",
  closedAt: daysAgo(1),
  expectedCloseDate: daysAgo(1),
  proposalDate: daysAgo(5),
  client: { tenantId: "tenant-a" },
  ownerSeller: { name: users.find((user) => user.id === row.ownerSellerId)!.name },
}));

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
    return row[key] === value;
  });
const clientWheres: Row[] = [];

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (where?.isActive === undefined || row.isActive === where.isActive));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null } : null;
  },
  findMany: async ({ where }: any) => users.filter((user) => matches(user, where)),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select }: any) => {
    clientWheres.push(where);
    return clients.filter((client) => matches(client, where)).map((client) => pick(client, select));
  },
  findFirst: async ({ where }: any) => {
    const row = clients.find((client) => client.id === where?.id);
    return row ? { ...row, name: "Cliente Ficticio", city: "Cidade Ficticia", state: "PR", tenantId: "tenant-a", code: null, lastPurchaseValue: null } : null;
  },
  count: async () => 0,
});
setModel("erpOrderSync", {
  findMany: async ({ where }: any) => {
    if (!where?.opportunity) return [];
    return erpOrders
      .filter((order) => order.status === where.status && matches(clients.find((client) => client.id === order.clientId)!, where.opportunity.client))
      .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, opportunity: { clientId: order.clientId } }));
  },
});
setModel("opportunity", {
  findMany: async ({ where }: any) => {
    if (where?.stage !== "ganho") return [];
    return wonOpportunities.filter((opportunity) => matches(opportunity, where.ownerSellerId ? { ownerSellerId: where.ownerSellerId } : {}));
  },
  count: async () => 0,
});
setModel("goal", { findMany: async () => [] });
setModel("activity", { findMany: async () => [], count: async () => 0, aggregate: async () => ({ _max: { date: null, createdAt: null } }) });
setModel("appConfig", { upsert: async () => ({ value: "10" }) });

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

const originalInfo = console.info;
console.info = () => undefined; // /dashboard/summary loga diagnóstico fora de produção.
try {
  // Carteira: 4 faixas, arquivado fora, pedido sent conta e pending/error não.
  const portfolio = await get("/dashboard/portfolio");
  assert.equal(portfolio.status, 200);
  assert.deepEqual(portfolio.json.walletStatus, { ativo: 3, inativoRecente: 1, exCliente: 2, prospect: 2 });
  assert.equal(portfolio.json.totalClients, 8, "total = não arquivados");
  assert(clientWheres.every((where) => where.isArchived === false), "carteira só consulta não arquivados");

  // Filtro por vendedor que já existia.
  const bySeller = await get("/dashboard/portfolio?sellerId=seller-ativo");
  assert.deepEqual(bySeller.json.walletStatus, { ativo: 3, inativoRecente: 1, exCliente: 2, prospect: 1 });
  assert.equal(bySeller.json.totalClients, 7);
  const asSeller = await get("/dashboard/portfolio", "seller-ativo");
  assert.equal(asSeller.json.totalClients, 7, "vendedor vê só a própria carteira");

  // Selo no detalhe do cliente.
  assert.equal((await get("/clients/c-pedido-enviado")).json.commercialSummary.portfolioStatus, "ativo");
  assert.equal((await get("/clients/c-pedido-pendente")).json.commercialSummary.portfolioStatus, "exCliente");
  assert.equal((await get("/clients/c-recente")).json.commercialSummary.portfolioStatus, "inativoRecente");
  assert.equal((await get("/clients/c-prospect")).json.commercialSummary.portfolioStatus, "prospect");

  // Performance da equipe.
  const summary = await get("/dashboard/summary");
  assert.equal(summary.status, 200);
  assert.deepEqual(
    summary.json.performance.map((row: Row) => [row.sellerId, row.seller, row.revenue]),
    [
      ["seller-desligado-com-venda", "Vendedor Ficticio Com Venda (desligado)", 1500],
      ["seller-ativo", "Vendedor Ficticio Ativo", 1000],
    ],
    "inativo sem valor some; inativo com valor aparece marcado",
  );

  // Consistência (valor = vendido nos meses do ranking).
  const consistency = await get("/reports/consistency");
  assert.equal(consistency.status, 200);
  assert.deepEqual(
    consistency.json.ranking.map((row: Row) => row.sellerName).sort(),
    ["Vendedor Ficticio Ativo", "Vendedor Ficticio Com Venda (desligado)"],
  );

  // Destaques da semana: o inativo com venda pode ganhar (marcado); com métrica zero, só ativos concorrem.
  const highlights = await get("/reports/weekly-highlights");
  assert.equal(highlights.status, 200);
  assert.equal(highlights.json.bestResult.sellerName, "Vendedor Ficticio Com Venda (desligado)");
  for (const key of ["bestEvolution", "bestExecutor", "bestConversion"]) {
    assert.equal(highlights.json[key].sellerId, "seller-ativo", `${key}: inativo com métrica zero não aparece`);
  }
} finally {
  console.info = originalInfo;
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("DASHBOARD_PORTFOLIO_RANKING=PASS wallet_bands=PASS archived_excluded=PASS seller_filter=PASS client_badge=PASS performance=PASS consistency=PASS weekly_highlights=PASS");
