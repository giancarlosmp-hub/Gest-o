import assert from "node:assert/strict";
import { once } from "node:events";
import { isProposalWithoutResponse } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { brazilTodayKey } from "../utils/dateRange.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: filtro "Esfriando" de GET /clients (?status=esfriando) e "Propostas sem retorno" de
// GET /opportunities (?noResponse=true). A contagem dos alertas da Central do Dia é igual ao total da lista
// filtrada, para vendedor e gestão; cliente em cobrança e arquivado ficam fora dos dois. Prisma simulado.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
// Meio-dia de Brasília do dia de Brasília N dias antes de hoje.
const contactDaysAgo = (days: number) => new Date(Date.parse(`${brazilTodayKey()}T15:00:00.000Z`) - days * DAY_MS);
const dueDaysAgo = (days: number) => `${new Date(Date.parse(`${brazilTodayKey()}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10)}T03:00:00.000Z`;
const overdueTitles = { partnerTitles: [{ DOCTO: "DOC-FICTICIO", PARCELA: 1, DATA_VENCIMENTO: dueDaysAgo(40), DSCRECEITA: "VENDAS", VALOR: 10, SALDO_CAPITAL: 10 }], openTitlesTotal: 10, overdueTitlesTotal: 10 };

const users: Row[] = [
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const client = (id: string, ownerSellerId: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, fantasyName: null, city: "Cidade Ficticia", state: "PR", region: "Sul", ownerSellerId, isArchived: false,
  lastPurchaseDate, financialProfile: null, partnerTitles: null, openTitlesTotal: 0, overdueTitlesTotal: 0, ...extra,
});
const clients: Row[] = [
  client("a-esfriando-10m", "seller-a", daysAgo(304)),
  client("a-esfriando-sc", "seller-a", daysAgo(320), { state: "SC" }),
  client("a-ativo-8m", "seller-a", daysAgo(243)),
  client("a-cobranca", "seller-a", daysAgo(310), overdueTitles),
  client("a-arquivado", "seller-a", daysAgo(300), { isArchived: true }),
  client("a-inativo", "seller-a", daysAgo(400)),
  client("b-esfriando", "seller-b", daysAgo(300)),
];
const opportunity = (id: string, clientId: string, extra: Row = {}): Row => ({
  id, title: `Oportunidade ficticia ${id}`, clientId, ownerSellerId: clients.find((row) => row.id === clientId)!.ownerSellerId, stage: "proposta",
  value: 1000, probability: 50, proposalDate: daysAgo(30), followUpDate: contactDaysAgo(-5), expectedCloseDate: contactDaysAgo(-30), lastContactAt: null,
  closedAt: null, createdAt: daysAgo(30), ...extra,
});
const opportunities: Row[] = [
  opportunity("opp-6d", "a-ativo-8m", { lastContactAt: contactDaysAgo(6) }),
  opportunity("opp-7d", "a-ativo-8m", { lastContactAt: contactDaysAgo(7) }),
  opportunity("opp-8d", "a-ativo-8m", { lastContactAt: contactDaysAgo(8) }),
  opportunity("opp-followup-9d", "a-esfriando-10m", { followUpDate: contactDaysAgo(9) }),
  opportunity("opp-contato-recente", "a-esfriando-10m", { lastContactAt: contactDaysAgo(2), followUpDate: contactDaysAgo(20) }),
  opportunity("opp-negociacao-20d", "a-ativo-8m", { stage: "negociacao", lastContactAt: contactDaysAgo(20) }),
  opportunity("opp-cobranca-10d", "a-cobranca", { lastContactAt: contactDaysAgo(10) }),
  opportunity("opp-arquivado-10d", "a-arquivado", { lastContactAt: contactDaysAgo(10) }),
  opportunity("opp-b-10d", "b-esfriando", { lastContactAt: contactDaysAgo(10) }),
];

const clientById = (id: string) => clients.find((row) => row.id === id)!;
const matchValue = (value: any, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition && !condition.in.includes(value)) return false;
  if ("notIn" in condition && condition.notIn.includes(value)) return false;
  if ("equals" in condition && String(value ?? "").toLowerCase() !== String(condition.equals).toLowerCase()) return false;
  if ("lt" in condition && !(value !== null && value !== undefined && value < condition.lt)) return false;
  if ("gt" in condition && !(value !== null && value !== undefined && value > condition.gt)) return false;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (Array.isArray(condition) ? condition : [condition]).every((part: Row) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "client") return matches(clientById(row.clientId), condition);
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select, include }: any) =>
    clients
      .filter((row) => matches(row, where))
      .map((row) => (include?.ownerSeller ? { ...row, ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio" } } : pick(row, select))),
  count: async ({ where }: any) => clients.filter((row) => matches(row, where)).length,
});
setModel("erpOrderSync", { findMany: async () => [] });
const opportunityRows = (where: Row) => opportunities.filter((row) => matches(row, where));
setModel("opportunity", {
  findMany: async ({ where, select, include, distinct, skip, take }: any) => {
    let rows = opportunityRows(where);
    if (distinct) rows = rows.filter((row, index) => rows.findIndex((other) => other.clientId === row.clientId) === index);
    const shaped = rows.map((row) =>
      select ? pick(row, select) : { ...row, ...(include?.client ? { client: clientById(row.clientId) } : {}), ...(include?.ownerSeller ? { ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio", isActive: true } } : {}) }
    );
    return skip === undefined ? shaped : shaped.slice(skip, skip + take);
  },
  count: async ({ where }: any) => opportunityRows(where).length,
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` },
  });
  return { status: response.status, json: (await response.json()) as any };
};
// A contagem do alerta na Central do Dia (countProposalsWithoutResponse em apps/web/src/lib/proposalsNoResponse.ts):
// a regra compartilhada sobre as oportunidades abertas, sem cliente em cobrança.
const countProposalsWithoutResponse = (rows: Row[]) => rows.filter((row) => !row.clientInCollection && isProposalWithoutResponse(row, new Date())).length;
const ids = (items: Row[]) => items.map((item) => item.id).sort();

const results: string[] = [];
try {
  // 1. Esfriando: ativo com última compra há mais de 9 meses; 8 meses não entra, 10 entra. Cobrança e arquivado fora.
  for (const [userId, expected] of [
    ["seller-a", ["a-esfriando-10m", "a-esfriando-sc"]],
    ["manager-a", ["a-esfriando-10m", "a-esfriando-sc", "b-esfriando"]],
  ] as const) {
    const alert = await get("/clients/alerts/cooling", userId);
    const list = await get("/clients?page=1&pageSize=50&status=esfriando", userId);
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list.json.items), [...expected], `esfriando de ${userId}`);
    assert.equal(list.json.total, alert.json.count, `contagem do alerta = total da lista (${userId})`);
    assert.deepEqual(ids(alert.json.clients), ids(list.json.items), `alerta e lista: mesmos clientes (${userId})`);
    assert(list.json.items.every((item: Row) => item.portfolioStatus === "ativo"), "esfriando é sempre ativo no selo");
  }
  results.push("cooling_count_equals_list=PASS cooling_8m_out_10m_in=PASS cooling_without_collection=PASS");

  // Combina com UF; com "Em cobrança" a lista fica vazia (esfriando não inclui cobrança); arquivados nunca.
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=50&status=esfriando&uf=SC", "seller-a")).json.items), ["a-esfriando-sc"]);
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=50&status=esfriando&uf=PR", "manager-a")).json.items), ["a-esfriando-10m", "b-esfriando"]);
  const withCollection = await get("/clients?page=1&pageSize=50&status=esfriando&cobranca=1", "seller-a");
  assert.deepEqual([withCollection.json.items, withCollection.json.total], [[], 0]);
  assert.equal((await get("/clients?page=1&pageSize=50&status=esfriando&includeArchived=1", "manager-a")).json.total, 0);
  // A situação "ativo" continua igual: inclui os esfriando, o de 8 meses e o em cobrança.
  assert.deepEqual(ids((await get("/clients?page=1&pageSize=50&status=ativo", "seller-a")).json.items), ["a-ativo-8m", "a-cobranca", "a-esfriando-10m", "a-esfriando-sc"]);
  results.push("cooling_with_uf=PASS cooling_with_collection_empty=PASS active_unchanged=PASS");

  // 2. Propostas sem retorno: contato há 6 e 7 dias não entra, há 8 entra; sem lastContactAt vale o followUpDate.
  for (const [userId, expected] of [
    ["seller-a", ["opp-8d", "opp-followup-9d"]],
    ["manager-a", ["opp-8d", "opp-b-10d", "opp-followup-9d"]],
  ] as const) {
    const central = await get("/opportunities?status=open&excludeArchivedClients=true", userId);
    const alertCount = countProposalsWithoutResponse(central.json);
    const list = await get("/opportunities?status=open&noResponse=true", userId);
    const paged = await get("/opportunities?status=open&noResponse=true&page=1&pageSize=20", userId);
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list.json), [...expected], `sem retorno de ${userId}`);
    assert.equal(alertCount, list.json.length, `contagem do alerta = itens da lista (${userId})`);
    assert.equal(paged.json.total, alertCount, `contagem do alerta = total paginado (${userId})`);
  }
  results.push("no_response_count_equals_list=PASS no_response_6d_out_7d_out_8d_in=PASS no_response_without_collection=PASS");

  // A mesma regra no banco (corte) e na função compartilhada (contagem e etiqueta), fora cobrança e arquivado.
  const managerList = ids((await get("/opportunities?status=open&noResponse=true", "manager-a")).json);
  const now = new Date();
  for (const row of opportunities.filter((item) => !["a-cobranca", "a-arquivado"].includes(item.clientId))) {
    assert.equal(managerList.includes(row.id), isProposalWithoutResponse(row, now), `${row.id}: filtro e função concordam`);
  }
  results.push("filter_and_shared_rule_agree=PASS");

  console.log(`COOLING_PROPOSALS_FILTERS=PASS ${results.join(" ")}`);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
