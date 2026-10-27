import assert from "node:assert/strict";
import { once } from "node:events";
import { CLIENT_IN_COLLECTION_RECOMMENDATION, COLLECTION_OVERDUE_DAYS, isClientInCollection } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import type { AiChatRequest, AiProvider } from "../services/ai/aiProvider.js";
import { aiService } from "../services/ai/aiService.js";
import { collectionStatusOf } from "../services/clientCollection.js";
import { __commercialInsightsInternals } from "../services/commercialInsightsService.js";
import { simulateCommercialAutomations } from "../services/commercialAutomationsService.js";
import { brazilTodayKey } from "../utils/dateRange.js";
import { signAccessToken } from "../utils/jwt.js";

// Regra de cobrança: título de venda vencido há mais de 30 dias (dia de Brasília), de qualquer valor, tira o
// cliente das sugestões de venda e o põe na lista "Em cobrança". Dados fictícios; Prisma e IA simulados.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
// Vencimento como o ERP grava: meia-noite de Brasília em ISO, N dias antes de hoje (dia de Brasília).
const dueDaysAgo = (days: number) => `${new Date(Date.parse(`${brazilTodayKey()}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10)}T03:00:00.000Z`;
const title = (days: number, extra: Row = {}) => ({ DOCTO: "DOC-FICTICIO", PARCELA: 1, DATA_VENCIMENTO: dueDaysAgo(days), DSCRECEITA: "VENDAS", VALOR: 10, SALDO_CAPITAL: 10, ...extra });

const users: Row[] = [
  { id: "director-a", role: "diretor", name: "Diretor Ficticio" },
  { id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A" },
  { id: "seller-b", role: "vendedor", name: "Vendedor Ficticio B" }
];
const baseClient = { tenantId: "tenant-a", code: null, cnpj: null, fantasyName: null, state: "PR", region: "Sul", city: "Cidade Ficticia", clientType: "PJ", segment: null, potentialHa: null, isArchived: false, archiveReason: null, lastPurchaseValue: 1000, financialProfile: null, partnerTitles: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: daysAgo(2000) };
const withTitles = (titles: Row[]) => {
  const open = titles.reduce((sum, row) => sum + Math.max(Number(row.SALDO_CAPITAL), 0), 0);
  return { partnerTitles: titles, openTitlesTotal: open, overdueTitlesTotal: open };
};
const clients: Row[] = [
  // Inativos recentes (última compra há 450 dias): 31 dias de atraso (R$ 10) entra em cobrança; 30 dias e reembolso não.
  { ...baseClient, id: "c-31", name: "Cliente Ficticio 31 Dias", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(450), ...withTitles([title(31)]) },
  { ...baseClient, id: "c-30", name: "Cliente Ficticio 30 Dias", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(450), ...withTitles([title(30)]) },
  { ...baseClient, id: "c-reembolso", name: "Cliente Ficticio Reembolso", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(450), ...withTitles([title(90, { DSCRECEITA: "REEMBOLSO" })]) },
  // Esfriando (ativo há 300 dias): um em cobrança (venda entrega futura), outro sem títulos.
  { ...baseClient, id: "c-esfriando-cobranca", name: "Cliente Ficticio Esfriando Cobranca", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(300), ...withTitles([title(45, { DSCRECEITA: "Venda Entrega Futura" })]) },
  { ...baseClient, id: "c-esfriando", name: "Cliente Ficticio Esfriando", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(300) },
  // Prospects: um em cobrança, outro não.
  { ...baseClient, id: "c-prospect-cobranca", name: "Cliente Ficticio Prospect Cobranca", ownerSellerId: "seller-a", lastPurchaseDate: null, ...withTitles([title(40)]) },
  { ...baseClient, id: "c-prospect", name: "Cliente Ficticio Prospect", ownerSellerId: "seller-a", lastPurchaseDate: null },
  // Título pago (saldo 0) há 200 dias: não conta.
  { ...baseClient, id: "c-pago", name: "Cliente Ficticio Pago", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(450), partnerTitles: [title(200, { SALDO_CAPITAL: 0 })], openTitlesTotal: 0, overdueTitlesTotal: 0 },
  // Outro vendedor em cobrança: fora do escopo de seller-a.
  { ...baseClient, id: "c-b-cobranca", name: "Cliente Ficticio B Cobranca", ownerSellerId: "seller-b", lastPurchaseDate: daysAgo(450), ...withTitles([title(60)]) }
];
const baseOpportunity = { probability: 50, notes: null, crop: "soja", season: null, areaHa: null, productOffered: "Semente ficticia", expectedCloseDate: daysAgo(-10), proposalDate: daysAgo(20), closedAt: null, createdAt: daysAgo(20), lastContactAt: daysAgo(15), plantingForecastDate: null };
const opportunities: Row[] = ["c-31", "c-30", "c-reembolso", "c-esfriando-cobranca"].map((clientId) => ({
  ...baseOpportunity, id: `opp-${clientId}`, clientId, title: `Oportunidade ficticia ${clientId}`, value: 5000, stage: "negociacao", ownerSellerId: "seller-a", followUpDate: daysAgo(3)
}));

const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  if ("contains" in condition) return typeof value === "string" && value.toLowerCase().includes(String(condition.contains).toLowerCase());
  if ("gt" in condition) return typeof value === "number" && value > condition.gt;
  if ("not" in condition) return value !== condition.not;
  if ("equals" in condition) return value === condition.equals;
  if (!(value instanceof Date)) return false;
  const time = value.getTime();
  if ("lt" in condition && !(time < condition.lt.getTime())) return false;
  if ("lte" in condition && !(time <= condition.lte.getTime())) return false;
  if ("gte" in condition && !(time >= condition.gte.getTime())) return false;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return ([] as Row[]).concat(condition).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "NOT") return !([] as Row[]).concat(condition).some((part) => matches(row, part));
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    if (key === "opportunities" || key === "activities") return false;
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((key) => !(select[key] && typeof select[key] === "object")).map((key) => [key, row[key]])) : { ...row });
const projectOpportunity = (row: Row, select?: Row, include?: Row) =>
  include
    ? { ...row, client: pick(clientOf(row)!, include.client?.select), ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio", isActive: true } }
    : { ...pick(row, select), client: select?.client ? pick(clientOf(row)!, select.client.select) : undefined, timelineEvents: [], activities: [], items: [] };
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
  },
  findMany: async () => users.filter((row) => row.role === "vendedor").map((row) => ({ id: row.id, name: row.name, region: null }))
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
const sortRows = (rows: Row[], orderBy: any) => {
  const order = ([] as Row[]).concat(orderBy ?? [])[0];
  const [field, direction] = order ? Object.entries(order)[0] as [string, string] : ["name", "asc"];
  return [...rows].sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (direction === "desc" ? -1 : 1));
};
setModel("client", {
  findFirst: async ({ where, select }: any) => { const row = clients.find((candidate) => matches(candidate, where)); return row ? pick(row, select) : null; },
  findMany: async ({ where, select, include, orderBy }: any) =>
    sortRows(clients.filter((row) => matches(row, where)), orderBy).map((row) => ({
      ...pick(row, select),
      ...(include?.ownerSeller ? { ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio" } } : {}),
      ...(select?.ownerSeller ? { ownerSeller: { isActive: true } } : {}),
      ...(select?.timelineEvents ? { timelineEvents: [] } : {})
    })),
  count: async ({ where }: any) => clients.filter((row) => matches(row, where)).length
});
setModel("opportunity", {
  count: async ({ where }: any) => opportunities.filter((row) => matches(row, where)).length,
  aggregate: async ({ where }: any) => { const rows = opportunities.filter((row) => matches(row, where)); return { _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) }, _count: rows.length }; },
  findFirst: async ({ where, select }: any) => { const row = opportunities.find((candidate) => matches(candidate, where)); return row ? projectOpportunity(row, select) : null; },
  findMany: async ({ where, select, include }: any) => opportunities.filter((row) => matches(row, where)).map((row) => projectOpportunity(row, select, include))
});
setModel("activity", {
  findMany: async () => [],
  count: async () => 0,
  aggregate: async () => ({ _max: { date: null, createdAt: null } })
});
setModel("timelineEvent", { findFirst: async () => null, findMany: async () => [] });
setModel("agendaEvent", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => [] });
// Visitas pela carteira (valor estimado do cliente e última visita): valores padrão e nenhuma visita registrada.
setModel("appConfig", { findMany: async () => [] });
setModel("agendaStop", { groupBy: async () => [] });
setModel("activity", { groupBy: async () => [] });
setModel("erpOrderSync", { findMany: async () => [], findFirst: async () => null });
setModel("product", { findMany: async () => [] });
setModel("opportunityItem", { findMany: async () => [] });
setModel("knowledgeDocument", { findMany: async () => [], findFirst: async () => null });
const appConfig = new Map<string, string>();
setModel("appConfig", {
  findUnique: async ({ where }: any) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    appConfig.set(where.key, appConfig.has(where.key) ? update.value ?? appConfig.get(where.key) : create.value);
    return { key: where.key, value: appConfig.get(where.key) };
  }
});

// IA falsa: guarda o que receberia; na sugestão, devolve uma reativação (que a regra de cobrança deve descartar).
const received: AiChatRequest[] = [];
const fakeProvider: AiProvider = {
  name: "fake-provider",
  model: "fake/model-free",
  mode: "fake",
  getStatus: () => ({ provider: "fake-provider", model: "fake/model-free", configured: true, mode: "fake" }),
  chat: async (request) => {
    received.push(request);
    const content = request.messages.map((message) => message.content).join("\n");
    const reply = content.includes("Gere uma sugestão")
      ? JSON.stringify({ status: "parado", summary: "Resumo da IA ficticia", recommendation: "Reativar o cliente com oferta", nextAction: "Ligar e ofertar hoje", riskLevel: "medio" })
      : JSON.stringify({});
    return { content: reply, model: "fake/model-free", elapsedMs: 1, usage: { totalTokens: 21 } };
  }
};
(aiService as any).provider = fakeProvider;
env.aiChatEnabled = false;

const originalInfo = console.info;
console.info = () => undefined;

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const ask = async (question: string, userId = "seller-a") => {
  const response = await call("POST", "/ai/crm-assistant/query", userId, { question, refresh: true });
  assert.equal(response.status, 200, question);
  return response.json.results.map((item: Row) => item.entityId) as string[];
};
const IN_COLLECTION = ["c-31", "c-esfriando-cobranca", "c-prospect-cobranca"];
const opportunityIdsOf = (clientIds: string[]) => clientIds.map((id) => `opp-${id}`);

try {
  // Regra única (shared): 30 dias ainda não é cobrança; 31 é. Só títulos de venda com saldo contam.
  assert.equal(COLLECTION_OVERDUE_DAYS, 30);
  assert.equal(isClientInCollection(30), false);
  assert.equal(isClientInCollection(31), true);
  assert.equal(isClientInCollection(null), false);
  assert.deepEqual(collectionStatusOf(clients.find((row) => row.id === "c-31")!), { oldestOverdueDays: 31, overdueTitlesTotal: 10 }, "R$ 10 basta");
  for (const id of ["c-30", "c-reembolso", "c-pago", "c-esfriando", "c-prospect"]) {
    assert.equal(collectionStatusOf(clients.find((row) => row.id === id)!), null, `${id} não está em cobrança`);
  }
  assert.equal(collectionStatusOf(clients.find((row) => row.id === "c-esfriando-cobranca")!)?.oldestOverdueDays, 45, "venda entrega futura conta");

  // Prioridades do dia (Central do Dia e "Minha IA Comercial"): sem o cliente em cobrança.
  const priorities = await call("GET", "/ai/today-priorities", "seller-a");
  assert.equal(priorities.status, 200);
  const priorityIds = priorities.json.map((item: Row) => item.opportunityId).sort();
  assert.deepEqual(priorityIds, opportunityIdsOf(["c-30", "c-reembolso"]).sort(), "30 dias e reembolso continuam; 31 dias sai");

  // Planejamento semanal (reativação, ligações, visitas, follow-ups) e encaixes da Agenda.
  const plan = await call("GET", "/ai/commercial-planning/week?refresh=true", "seller-a");
  assert.equal(plan.status, 200);
  const plannedClientIds = new Set([...plan.json.days.flatMap((day: Row) => day.suggestedActions), ...plan.json.unallocatedPriorities].map((action: Row) => action.clientId));
  for (const id of IN_COLLECTION) assert(!plannedClientIds.has(id), `${id} fora do planejamento`);
  for (const id of ["c-30", "c-reembolso", "c-esfriando"]) assert(plannedClientIds.has(id), `${id} continua no planejamento`);

  // Assistente Comercial: prioridades, sem comprar, esfriando e primeira venda.
  assert.deepEqual((await ask("Quem devo atender hoje?")).sort(), opportunityIdsOf(["c-30", "c-reembolso"]).sort());
  const withoutPurchase = await ask("Quais clientes estão sem comprar?");
  assert(!withoutPurchase.includes("c-31"), "sem comprar: 31 dias fora");
  for (const id of ["c-30", "c-reembolso", "c-pago"]) assert(withoutPurchase.includes(id), `sem comprar: ${id} continua`);
  assert.deepEqual(await ask("Quais clientes estão esfriando?"), ["c-esfriando"]);
  assert.deepEqual(await ask("Quais clientes nunca compraram?"), ["c-prospect"]);

  // Alerta de esfriando da Central do Dia.
  const cooling = await call("GET", "/clients/alerts/cooling", "seller-a");
  assert.equal(cooling.json.count, 1);
  assert.deepEqual(cooling.json.clients.map((item: Row) => item.id), ["c-esfriando"]);

  // IA Comercial do gestor: nem a oportunidade nem o cliente em cobrança entram nas prioridades.
  const insights = await __commercialInsightsInternals.collectDeterministicContext();
  const insightIds = insights.priorities.map((item) => item.entityId);
  for (const id of [...IN_COLLECTION, "c-b-cobranca", ...opportunityIdsOf(IN_COLLECTION)]) assert(!insightIds.includes(id), `${id} fora da IA do gestor`);
  assert(insightIds.includes("opp-c-30"), "30 dias continua na IA do gestor");

  // Automação de inativos recentes: cobrança fica fora da criação e aparece na simulação.
  const simulation = await simulateCommercialAutomations();
  // Inativos recentes: c-31, c-30, c-reembolso, c-pago (seller-a) e c-b-cobranca (seller-b).
  assert.equal(simulation.inactiveRecentClients, 5);
  assert.equal(simulation.inCollection, 2, "c-31 e c-b-cobranca ficam fora");
  assert.equal(simulation.skipped.openOpportunity, 2, "c-30 e c-reembolso já têm oportunidade aberta");
  assert.equal(simulation.eligibleClients, 1);
  assert.equal(simulation.wouldCreate, 1, "só c-pago seria criado");

  // Lista "Em cobrança" no escopo do usuário, com dias do título mais antigo e total vencido.
  const list = await call("GET", "/clients?cobranca=1&page=1&pageSize=10&sort=name_asc", "seller-a");
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 3);
  assert.deepEqual(list.json.items.map((item: Row) => item.id).sort(), [...IN_COLLECTION].sort());
  const item31 = list.json.items.find((item: Row) => item.id === "c-31");
  assert.deepEqual(item31.collection, { oldestOverdueDays: 31, overdueTitlesTotal: 10 });
  assert.equal(item31.portfolioStatus, "inativoRecente");
  assert.equal(item31.partnerTitles.every((row: Row) => !("DSCRECEITA" in row)), true, "títulos continuam projetados");
  const directorList = await call("GET", "/clients?cobranca=1&page=1&pageSize=10", "director-a");
  assert.equal(directorList.json.total, 4, "gestor vê a carteira inteira");
  const combined = await call("GET", "/clients?cobranca=1&status=prospect&page=1&pageSize=10", "seller-a");
  assert.deepEqual(combined.json.items.map((item: Row) => item.id), ["c-prospect-cobranca"], "combina com a situação");
  const regular = await call("GET", "/clients?page=1&pageSize=20", "seller-a");
  assert.equal(regular.json.items.find((item: Row) => item.id === "c-30").collection, null, "selo só para quem está em cobrança");
  assert.deepEqual(regular.json.items.find((item: Row) => item.id === "c-31").collection, { oldestOverdueDays: 31, overdueTitlesTotal: 10 });

  // Contagem da Central do Dia.
  assert.equal((await call("GET", "/clients/alerts/collection", "seller-a")).json.count, 3);
  assert.equal((await call("GET", "/clients/alerts/collection", "seller-b")).json.count, 1);

  // Oportunidades abertas continuam na tela, com o aviso.
  const opportunityList = await call("GET", "/opportunities?status=open&excludeArchivedClients=true", "seller-a");
  assert.equal(opportunityList.status, 200);
  const flags = Object.fromEntries(opportunityList.json.map((item: Row) => [item.id, item.clientInCollection]));
  assert.deepEqual(flags, { "opp-c-31": true, "opp-c-30": false, "opp-c-reembolso": false, "opp-c-esfriando-cobranca": true });

  // Sugestão inteligente: determinística, sem reativação.
  const suggestion = await call("POST", "/ai/client-suggestion", "seller-a", { clientId: "c-31" });
  assert.equal(suggestion.status, 200);
  assert.equal(suggestion.json.source, "deterministic");
  assert.equal(suggestion.json.recommendation, CLIENT_IN_COLLECTION_RECOMMENDATION);
  assert.doesNotMatch(`${suggestion.json.recommendation} ${suggestion.json.nextAction}`, /reativ|ofert(e|ar) (produto|condição)/i);
  assert.match(suggestion.json.summary, /Situação da carteira: Em cobrança\./);
  // Com a IA ligada, ela recebe só "situação: Em cobrança" (sem valores nem dias) e a recomendação continua a fixa.
  env.aiChatEnabled = true;
  received.length = 0;
  const aiSuggestion = await call("POST", "/ai/client-suggestion", "seller-a", { clientId: "c-31" });
  env.aiChatEnabled = false;
  assert.equal(aiSuggestion.json.source, "ai");
  assert.equal(aiSuggestion.json.recommendation, CLIENT_IN_COLLECTION_RECOMMENDATION);
  assert.notEqual(aiSuggestion.json.nextAction, "Ligar e ofertar hoje");
  assert.equal(aiSuggestion.json.status, "acompanhamento");
  const prompt = received.map((request) => request.messages.map((message) => message.content).join("\n")).join("\n");
  assert.match(prompt, /"carteira":\{"situacao":"Em cobrança"\}/);
  assert.doesNotMatch(prompt, /R\$|overdueTitlesTotal|oldestOverdueDays|SALDO_CAPITAL|DATA_VENCIMENTO|"abordagem"|"ultimaCompra"|Reativação:/);
  // Cliente fora de cobrança segue a regra da carteira (reativação para inativo recente).
  const regularSuggestion = await call("POST", "/ai/client-suggestion", "seller-a", { clientId: "c-reembolso" });
  assert.notEqual(regularSuggestion.json.recommendation, CLIENT_IN_COLLECTION_RECOMMENDATION);

  // Resumo do cliente.
  const summary = await call("GET", "/ai/client-summary/c-31", "seller-a");
  assert.equal(summary.status, 200);
  const summaryText = JSON.stringify(summary.json);
  assert.match(summaryText, new RegExp(CLIENT_IN_COLLECTION_RECOMMENDATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(summaryText, /reativar relacionamento/i);
  const regularSummary = await call("GET", "/ai/client-summary/c-30", "seller-a");
  assert.doesNotMatch(JSON.stringify(regularSummary.json), /Cliente em cobrança/);

  console.info = originalInfo;
  console.log("CLIENT_COLLECTION=PASS rule=PASS priorities=PASS planning=PASS assistant=PASS cooling=PASS manager_ai=PASS automation=PASS list=PASS count=PASS opportunities=PASS suggestion=PASS summary=PASS");
} finally {
  console.info = originalInfo;
  server.close();
}
