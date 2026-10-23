import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { planningIntelligenceService } from "../services/planningIntelligenceService.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: score de prioridade, prioridades do dia, IA Comercial (gestão) e planejamento semanal pela
// regra oficial da carteira, sem clientes arquivados.
type Row = Record<string, any>;

// Sem IA no teste: as respostas são as determinísticas.
(aiService as any).chat = async () => null;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number) => new Date(Date.now() + days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "seller-a", role: "vendedor" },
];
const client = (id: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, city: "Cidade Ficticia", state: "PR", region: "Sul", ownerSellerId: "seller-a", isArchived: false,
  lastPurchaseDate, lastPurchaseValue: null, financialProfile: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: daysAgo(2000), timelineEvents: [], ...extra,
});
// 8 ex-clientes: o planejamento só leva os 5 de compra mais recente por semana.
const exClients = Array.from({ length: 8 }, (_, index) => client(`ex-${index + 1}`, daysAgo(800 + index * 10)));
const clients: Row[] = [
  client("ativo", daysAgo(30)),
  // Ativo com R$ 18.000,00 em títulos vencidos (overdueTitlesTotal é soma em R$, não quantidade).
  client("ativo-titulos", daysAgo(30), { overdueTitlesTotal: 18000 }),
  client("esfriando-antigo", daysAgo(340)),
  client("esfriando", daysAgo(300)),
  client("recente-novo", daysAgo(400)),
  client("recente-velho", daysAgo(600)),
  client("ex-pedido", daysAgo(900)),
  client("ex-cancelado", daysAgo(900)),
  ...exClients,
  client("prospect", null),
  client("arquivado-recente", daysAgo(450), { isArchived: true }),
  client("arquivado-ex", daysAgo(900), { isArchived: true }),
];
const erpOrders: Row[] = [
  // Pedido sent mais recente que o ERP: ex-cliente no ERP vira esfriando.
  { clientId: "ex-pedido", status: "sent", sentAt: daysAgo(290), createdAt: daysAgo(290) },
  // Sent cancelado depois no ERP não conta.
  { clientId: "ex-cancelado", status: "sent", sentAt: daysAgo(10), createdAt: daysAgo(10), operationalOrderStatus: "CANCELADO" },
];
const opportunity = (id: string, clientId: string, extra: Row = {}): Row => ({
  id, clientId, title: `Oportunidade ${id}`, value: 1000, stage: "prospeccao", ownerSellerId: "seller-a", notes: null,
  followUpDate: daysAhead(10), proposalDate: null, expectedCloseDate: null, lastContactAt: daysAgo(1), createdAt: daysAgo(5), ...extra,
});
const opportunities: Row[] = [
  opportunity("opp-recente", "recente-novo"),
  opportunity("opp-esfriando", "esfriando"),
  opportunity("opp-ex", "ex-1"),
  opportunity("opp-ex-pedido", "ex-pedido"),
  opportunity("opp-ex-cancelado", "ex-cancelado"),
  opportunity("opp-ativo", "ativo"),
  opportunity("opp-titulos", "ativo-titulos"),
  opportunity("opp-prospect", "prospect"),
  opportunity("opp-arquivado", "arquivado-recente", { followUpDate: daysAgo(2), value: 90000 }),
];
const activities: Row[] = [
  { id: "act-ativo", clientId: "ativo", opportunityId: null, ownerSellerId: "seller-a", type: "ligacao", done: false, dueDate: daysAhead(1), date: daysAhead(1), city: null, description: "Ligar", notes: null, createdAt: daysAgo(1), product: null },
  { id: "act-sem-cliente", clientId: null, opportunityId: null, ownerSellerId: "seller-a", type: "ligacao", done: false, dueDate: daysAhead(2), date: daysAhead(2), city: null, description: "Tarefa interna", notes: null, createdAt: daysAgo(1), product: null },
  { id: "act-arquivado", clientId: "arquivado-ex", opportunityId: null, ownerSellerId: "seller-a", type: "visita", done: false, dueDate: daysAgo(3), date: daysAgo(3), city: null, description: "Visitar", notes: null, createdAt: daysAgo(4), product: null },
];

// Avaliador mínimo de where do Prisma para os filtros usados nestas rotas.
const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  // Totais de títulos (filtro de cobrança): comparação numérica.
  if ("gt" in condition) return typeof value === "number" && value > condition.gt;
  const time = (value as Date).getTime();
  if ("lt" in condition && !(time < condition.lt.getTime())) return false;
  if ("lte" in condition && !(time <= condition.lte.getTime())) return false;
  if ("gte" in condition && !(time >= condition.gte.getTime())) return false;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "NOT") return !matches(row, condition);
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    if (key === "opportunity") return matches(row, condition);
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const queries: Record<string, Row[]> = { client: [], opportunity: [], activity: [] };

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [{ id: "seller-a", name: "Vendedor Ficticio", region: "Sul" }],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select }: any) => {
    queries.client.push(where);
    return clients.filter((row) => matches(row, where)).map((row) => pick(row, select));
  },
});
setModel("opportunity", {
  findMany: async ({ where, select }: any) => {
    queries.opportunity.push(where);
    return opportunities
      .filter((row) => matches(row, where ?? {}))
      .map((row) => ({ ...pick(row, select), client: pick(clientOf(row)!, select?.client?.select), activities: [], timelineEvents: [], items: [] }));
  },
});
setModel("activity", {
  findMany: async ({ where, select }: any) => {
    queries.activity.push(where);
    return activities.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), client: row.clientId ? pick(clientOf(row)!, { name: true, city: true }) : null }));
  },
});
setModel("erpOrderSync", {
  findMany: async ({ where }: any) =>
    erpOrders
      .filter((order) => order.status === where.status && matches(order, where.opportunity))
      .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, orderStatus: order.orderStatus ?? null, operationalOrderStatus: order.operationalOrderStatus ?? "UNKNOWN", opportunity: { clientId: order.clientId } })),
});
setModel("agendaEvent", { findMany: async () => [] });
setModel("product", { findMany: async () => [] });
setModel("opportunityItem", { findMany: async () => [] });
setModel("knowledgeDocument", { findMany: async () => [], findFirst: async () => null });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, json: (await response.json()) as any };
};
const OVERDUE_TITLES_REASON = "R$ 18.000,00 em títulos vencidos";
const reasonsOf = (items: Row[], key: string, id: string) => items.find((item) => item[key] === id)?.priorityReasons as string[];

try {
  // Prioridades do dia: score pela situação oficial, sem arquivados e sem o falso "workflow".
  const today = await get("/ai/today-priorities", "seller-a");
  assert.equal(today.status, 200);
  const todayIds = today.json.map((item: Row) => item.opportunityId);
  assert(!todayIds.includes("opp-arquivado"), "oportunidade de cliente arquivado fica fora das prioridades do dia");
  assert(queries.opportunity.every((where) => where.client?.isArchived === false), "consulta de oportunidades exclui arquivados");
  assert.match(reasonsOf(today.json, "opportunityId", "opp-recente")[0], /^Inativo recente: sem comprar há mais de 12 meses \(última compra em \d{2}\/\d{2}\/\d{4}\)$/);
  assert.match(reasonsOf(today.json, "opportunityId", "opp-esfriando")[0], /^Esfriando: ativo sem comprar há mais de 9 meses/);
  assert.match(reasonsOf(today.json, "opportunityId", "opp-ex")[0], /^Ex-cliente: sem comprar há mais de 24 meses/);
  assert.match(reasonsOf(today.json, "opportunityId", "opp-ex-pedido")[0], /^Esfriando:/, "pedido sent mais recente que o ERP define a última compra");
  assert.match(reasonsOf(today.json, "opportunityId", "opp-ex-cancelado")[0], /^Ex-cliente:/, "pedido sent cancelado não conta");
  assert.deepEqual(reasonsOf(today.json, "opportunityId", "opp-ativo"), []);
  assert.deepEqual(reasonsOf(today.json, "opportunityId", "opp-titulos"), [OVERDUE_TITLES_REASON], "total dos títulos vencidos em R$, não quantidade");
  assert(today.json.every((item: Row) => item.opportunityId === "opp-titulos" || !item.priorityReasons.some((reason: string) => /títulos?/.test(reason))), "sem títulos vencidos, sem texto de títulos");
  assert.deepEqual(reasonsOf(today.json, "opportunityId", "opp-prospect"), []);
  assert(today.json.every((item: Row) => !item.priorityReasons.some((reason: string) => /Workflow/.test(reason))), "sem o falso workflow de cliente sem compra");
  const scoreOf = (id: string) => today.json.find((item: Row) => item.opportunityId === id).priorityScore;
  assert.deepEqual([scoreOf("opp-recente"), scoreOf("opp-esfriando"), scoreOf("opp-ex"), scoreOf("opp-ativo"), scoreOf("opp-prospect")], [30, 20, 10, 0, 0]);

  // IA Comercial (gestão): arquivados fora de clientes, oportunidades e atividades.
  queries.client.length = 0; queries.opportunity.length = 0; queries.activity.length = 0;
  const insights = await get("/ai/commercial-insights?refresh=true", "director-a");
  assert.equal(insights.status, 200);
  const insightIds = insights.json.priorities.map((item: Row) => item.entityId);
  for (const archived of ["arquivado-recente", "arquivado-ex", "opp-arquivado"]) assert(!insightIds.includes(archived), `${archived} fora da IA Comercial`);
  assert(queries.client.every((where) => where.isArchived === false), "clientes sem arquivados");
  assert(queries.opportunity.every((where) => where.client?.isArchived === false), "oportunidades sem arquivados");
  assert(queries.activity.length > 0 && queries.activity.every((where) => !activities.filter((row) => matches(row, where)).some((row) => row.id === "act-arquivado")), "atividades sem arquivados");
  assert(activities.filter((row) => matches(row, queries.activity[0])).some((row) => row.id === "act-sem-cliente"), "atividade sem cliente continua");
  const insightReason = (id: string) => insights.json.priorities.find((item: Row) => item.entityId === id)?.reason as string | undefined;
  assert.match(insightReason("opp-recente")!, /^Inativo recente/);
  assert.match(insightReason("recente-velho")!, /^Inativo recente/);
  assert.equal(insightReason("ativo"), undefined, "ativo sem sinal não entra no ranking");
  assert.equal(insightReason("opp-titulos"), OVERDUE_TITLES_REASON);

  // Planejamento semanal: arquivados fora; reativação = inativos recentes, esfriando e no máximo 5 ex-clientes.
  queries.opportunity.length = 0; queries.activity.length = 0;
  const plan = await get("/ai/commercial-planning/week?weekStart=2026-10-19&refresh=true", "seller-a");
  assert.equal(plan.status, 200);
  assert.equal(plan.json.weekStart, "2026-10-19");
  const actions: Row[] = [...plan.json.days.flatMap((day: Row) => day.suggestedActions), ...plan.json.unallocatedPriorities];
  assert(!actions.some((action) => ["arquivado-recente", "arquivado-ex"].includes(action.clientId)), "arquivados fora do planejamento");
  assert(queries.opportunity.every((where) => where.client?.isArchived === false));
  assert(queries.activity.every((where) => JSON.stringify(where.OR) === JSON.stringify([{ clientId: null }, { client: { isArchived: false } }])));
  const reactivation = actions.filter((action) => action.source === "inactive_client").sort((a, b) => b.score - a.score);
  const reactivationIds = reactivation.map((action) => action.clientId);
  assert.deepEqual(
    [...reactivationIds].sort(),
    ["recente-novo", "recente-velho", "esfriando-antigo", "esfriando", "ex-pedido", "ex-1", "ex-2", "ex-3", "ex-4", "ex-5"].sort(),
    "prospect, ativo, ex-clientes além dos 5 de compra mais recente e o ex-cliente de pedido cancelado ficam fora"
  );
  const firstIndexOf = (prefix: RegExp) => reactivation.findIndex((action) => prefix.test(action.reason));
  assert(firstIndexOf(/^Inativo recente/) < firstIndexOf(/^Esfriando/) && firstIndexOf(/^Esfriando/) < firstIndexOf(/^Ex-cliente/), "inativo recente, depois esfriando, depois ex-cliente");
  assert(reactivationIds.includes("ex-pedido") && reactivation.find((action) => action.clientId === "ex-pedido")!.reason.startsWith("Esfriando"));
  assert.equal(actions.find((action) => action.opportunityId === "opp-titulos")?.reason, OVERDUE_TITLES_REASON, "motivo do planejamento");
  assert(actions.every((action) => !/títulos?/.test(action.reason) || action.opportunityId === "opp-titulos"), "cliente sem títulos vencidos não traz texto de títulos");

  // Sem weekStart: próximos 5 dias úteis a partir de hoje em Brasília. Sexta 22h em Brasília (já sábado em UTC) ainda
  // começa na sexta; sábado 0h30 em Brasília pula para a segunda.
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-10-24T01:00:00.000Z");
    const fridayNight = await planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: "seller-a", viewerRole: "vendedor", refresh: true });
    assert.equal(fridayNight.weekStart, "2026-10-23");
    Date.now = () => Date.parse("2026-10-24T03:30:00.000Z");
    const saturdayEarly = await planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: "seller-a", viewerRole: "vendedor", refresh: true });
    assert.equal(saturdayEarly.weekStart, "2026-10-26");
  } finally {
    Date.now = realNow;
  }

  console.log("portfolio priority planning http: ok");
} finally {
  server.close();
}
