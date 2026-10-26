import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: "sem comprar", "esfriando" e "primeira venda" no Assistente Comercial e o alerta
// "Clientes esfriando" da Central do Dia, todos pela regra oficial da carteira (classifyPortfolioStatus).
type Row = Record<string, any>;

// Sem IA no teste: a resposta é a determinística.
(aiService as any).chat = async () => null;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const client = (id: string, ownerSellerId: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, fantasyName: null, city: "Cidade Ficticia", state: "PR", ownerSellerId, isArchived: false, lastPurchaseDate, financialProfile: null, ...extra,
});
// 22 ex-clientes do vendedor A: com os 2 inativos recentes e o ex-cliente de pedido cancelado, passam de 20.
const manyExClients = Array.from({ length: 22 }, (_, index) => client(`a-ex-${String(index + 1).padStart(2, "0")}`, "seller-a", daysAgo(800 + index)));
const clients: Row[] = [
  client("a-ativo", "seller-a", daysAgo(30)),
  client("a-esfriando", "seller-a", daysAgo(300)),
  client("a-esfriando-perfil", "seller-a", null, { financialProfile: { DATA_ULTFATURA: daysAgo(320).toISOString() } }),
  client("a-esfriando-pedido", "seller-a", daysAgo(900)),
  client("a-ativo-pedido", "seller-a", daysAgo(500)),
  client("a-recente", "seller-a", daysAgo(500)),
  client("a-recente-2", "seller-a", daysAgo(420)),
  ...manyExClients,
  client("a-ex-cancelado", "seller-a", daysAgo(900)),
  client("a-prospect-z", "seller-a", null, { name: "Cliente Ficticio Zeta" }),
  client("a-prospect-a", "seller-a", null, { name: "Cliente Ficticio Alfa" }),
  client("a-arquivado-recente", "seller-a", daysAgo(500), { isArchived: true }),
  client("a-arquivado-esfriando", "seller-a", daysAgo(300), { isArchived: true }),
  client("a-arquivado-prospect", "seller-a", null, { isArchived: true }),
  client("b-recente", "seller-b", daysAgo(450)),
  client("b-esfriando", "seller-b", daysAgo(310)),
  client("b-prospect", "seller-b", null),
];
const erpOrders: Row[] = [
  { clientId: "a-esfriando-pedido", status: "sent", sentAt: daysAgo(290), createdAt: daysAgo(290) },
  { clientId: "a-ativo-pedido", status: "sent", sentAt: daysAgo(15), createdAt: daysAgo(15) },
  { clientId: "a-ex-cancelado", status: "sent", sentAt: daysAgo(10), createdAt: daysAgo(10), operationalOrderStatus: "CANCELADO" },
  { clientId: "a-recente", status: "pending", sentAt: null, createdAt: daysAgo(5) },
  { clientId: "a-arquivado-recente", status: "sent", sentAt: daysAgo(280), createdAt: daysAgo(280) },
];

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
const clientQueries: Row[] = [];

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select }: any) => {
    clientQueries.push(where);
    return clients.filter((row) => matches(row, where)).map((row) => pick(row, select));
  },
  count: async () => {
    throw new Error("a contagem vem da regra oficial, não de count no banco");
  },
});
setModel("erpOrderSync", {
  findMany: async ({ where }: any) =>
    erpOrders
      .filter((order) => order.status === where.status && matches(clients.find((row) => row.id === order.clientId)!, where.opportunity.client))
      .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, orderStatus: order.orderStatus ?? null, operationalOrderStatus: order.operationalOrderStatus ?? "UNKNOWN", opportunity: { clientId: order.clientId } })),
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const tokenFor = (userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  return signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
};
const get = async (path: string, userId: string) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokenFor(userId)}` } });
  return { status: response.status, json: (await response.json()) as any };
};
const ask = async (question: string, userId: string, extra: Row = {}) => {
  const response = await fetch(`${baseUrl}/ai/crm-assistant/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ question, refresh: true, ...extra }),
  });
  return { status: response.status, json: (await response.json()) as any };
};
const resultIds = (json: any) => json.results.map((item: Row) => item.entityId);
const exIdsByRecency = manyExClients.map((row) => row.id);

try {
  // "Sem comprar" = inativo recente + ex-cliente; prospects e arquivados fora. Contagem real, lista top 20.
  const withoutPurchase = await ask("Quais clientes estão sem comprar?", "seller-a");
  assert.equal(withoutPurchase.status, 200);
  assert.equal(withoutPurchase.json.summary.totalResults, 25, "contagem real: 2 inativos recentes + 23 ex-clientes");
  assert.equal(withoutPurchase.json.results.length, 20, "lista limitada aos 20 primeiros");
  assert.deepEqual(resultIds(withoutPurchase.json), ["a-recente-2", "a-recente", ...exIdsByRecency.slice(0, 18)], "inativo recente primeiro; depois ex-cliente da compra mais recente");
  assert.match(withoutPurchase.json.answer, /25 cliente\(s\) sem comprar: 2 inativo\(s\) recente\(s\).*23 ex-cliente\(s\).*Mostrando os 20 primeiros/);
  assert.equal(withoutPurchase.json.source, "deterministic");
  assert.equal(withoutPurchase.json.summary.ordering, "inativo recente primeiro, depois ex-cliente; compra mais recente primeiro");
  const firstPageIds = resultIds(withoutPurchase.json);
  for (const excluded of ["a-ativo", "a-esfriando", "a-ativo-pedido", "a-prospect-a", "a-prospect-z", "a-arquivado-recente", "a-arquivado-prospect", "b-recente"]) {
    assert(!firstPageIds.includes(excluded), `${excluded} não é "sem comprar" do vendedor A`);
  }
  const recentResult = withoutPurchase.json.results.find((item: Row) => item.entityId === "a-recente");
  assert.equal(recentResult.subtitle, "Cidade Ficticia/PR • Inativo recente");
  assert.match(recentResult.reason, /^Última compra em \d{2}\/\d{2}\/\d{4} \(ERP\)\.$/);
  assert.equal(withoutPurchase.json.results[2].subtitle, "Cidade Ficticia/PR • Ex-cliente");
  assert(clientQueries.every((where) => where.isArchived === false), "toda consulta de cliente exclui arquivados");

  // Período e valor não se aplicam: saem dos filtros e viram aviso.
  const withDays = await ask("Quais clientes estão sem comprar há 200 dias?", "seller-a");
  assert.equal(withDays.json.summary.totalResults, 25);
  assert.deepEqual(withDays.json.filtersApplied, [{ field: "sellerId", operator: "=", value: "seller-a", label: "Vendedor: selecionado" }]);
  assert(withDays.json.warnings.some((warning: string) => /Período informado não aplicado/.test(warning)));

  // O aviso acompanha a pergunta mesmo quando a resposta vem do cache do mesmo plano.
  await ask("Quais clientes estão sem comprar?", "seller-b", { refresh: false });
  const cachedWithDays = await ask("Quais clientes estão sem comprar há 200 dias?", "seller-b", { refresh: false });
  assert(cachedWithDays.json.warnings.some((warning: string) => /Período informado não aplicado/.test(warning)));
  const cachedPlain = await ask("Quais clientes estão sem comprar?", "seller-b", { refresh: false });
  assert(!cachedPlain.json.warnings.some((warning: string) => /Período informado não aplicado/.test(warning)), "aviso não fica preso no cache");

  // Escopo: vendedor B só vê a carteira dele; o gestor vê todos.
  assert.deepEqual(resultIds((await ask("Quais clientes estão sem comprar?", "seller-b")).json), ["b-recente"]);
  assert.equal((await ask("Quais clientes estão sem comprar?", "manager-a")).json.summary.totalResults, 26);
  const sellerScope = await ask("Quais clientes estão sem comprar?", "manager-a", { context: { sellerId: "seller-b" } });
  assert.deepEqual(resultIds(sellerScope.json), ["b-recente"]);

  // "Esfriando" = ativo há mais de 9 meses; alerta e assistente devolvem os mesmos clientes e a mesma contagem.
  const coolingAnswer = await ask("Quais clientes estão esfriando?", "seller-a");
  assert.equal(coolingAnswer.status, 200);
  assert.deepEqual(resultIds(coolingAnswer.json), ["a-esfriando-perfil", "a-esfriando", "a-esfriando-pedido"], "compra mais antiga primeiro");
  assert.equal(coolingAnswer.json.summary.totalResults, 3);
  assert.match(coolingAnswer.json.results.find((item: Row) => item.entityId === "a-esfriando-pedido").reason, /\(pedido do CRM\)/);
  const coolingAlert = await get("/clients/alerts/cooling", "seller-a");
  assert.equal(coolingAlert.status, 200);
  assert.equal(coolingAlert.json.count, coolingAnswer.json.summary.totalResults, "alerta e assistente: mesma contagem");
  assert.deepEqual(coolingAlert.json.clients.map((item: Row) => item.id), resultIds(coolingAnswer.json), "alerta e assistente: mesmos clientes");
  assert.deepEqual(coolingAlert.json.items, coolingAlert.json.clients);
  assert.equal(coolingAlert.json.months, 9);
  assert.equal(coolingAlert.json.clients[2].lastPurchaseSource, "pedidoCrm");
  assert.equal((await get("/clients/alerts/cooling?limit=1", "seller-a")).json.count, 3, "limit corta a lista, não a contagem");
  assert.equal((await get("/clients/alerts/cooling?limit=1", "seller-a")).json.clients.length, 1);
  assert.deepEqual((await get("/clients/alerts/cooling", "seller-b")).json.clients.map((item: Row) => item.id), ["b-esfriando"]);
  const directorAlert = await get("/clients/alerts/cooling", "director-a");
  const directorAnswer = await ask("Quais clientes estão esfriando?", "director-a");
  assert.equal(directorAlert.json.count, 4);
  assert.equal(directorAnswer.json.summary.totalResults, directorAlert.json.count);

  // Filtro de valor em "esfriando": não há valor confiável, então sai da resposta com aviso.
  const coolingWithValue = await ask("Quais clientes acima de R$ 100 mil estão esfriando?", "seller-a");
  assert.equal(coolingWithValue.json.summary.totalResults, 3);
  assert(!coolingWithValue.json.filtersApplied.some((filter: Row) => filter.field === "minimumValue"));
  assert(coolingWithValue.json.warnings.some((warning: string) => /Filtro de valor não aplicado/.test(warning)));

  // Primeira venda: só prospects (nunca compraram), por nome; arquivados fora.
  const firstSale = await ask("Quais clientes nunca compraram?", "seller-a");
  assert.equal(firstSale.status, 200);
  assert.deepEqual(resultIds(firstSale.json), ["a-prospect-a", "a-prospect-z"]);
  assert.equal(firstSale.json.results[0].reason, "Nunca comprou: oportunidade de primeira venda.");
  assert.match(firstSale.json.answer, /2 prospect\(s\) que nunca compraram/);
  assert.deepEqual(resultIds((await ask("Clientes para primeira venda", "seller-b")).json), ["b-prospect"]);

  console.log("PORTFOLIO_WITHOUT_PURCHASE_COOLING=PASS without_purchase=PASS real_count=PASS archived_excluded=PASS scope=PASS cooling_same_rule=PASS first_sale=PASS");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
