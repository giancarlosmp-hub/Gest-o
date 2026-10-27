import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { __conversationalCrmInternals } from "../services/conversationalCrmService.js";
import { planningIntelligenceService } from "../services/planningIntelligenceService.js";
import { brazilTodayKey } from "../utils/dateRange.js";
import { signAccessToken } from "../utils/jwt.js";

// Assistente Comercial: "quem devo atender hoje" com as prioridades da Central do Dia, agenda do dia sem o
// planejamento semanal, textos sem termos internos e a IA da agenda na cota de quem está vendo. Dados fictícios,
// IA simulada (nada sai da máquina).
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const today = brazilTodayKey();
// 10h de Brasília de hoje.
const todayAt10 = new Date(`${today}T13:00:00.000Z`);

const users: Row[] = [
  { id: "director-a", role: "diretor", name: "Diretor Ficticio" },
  { id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A" },
  { id: "seller-b", role: "vendedor", name: "Vendedor Ficticio B" }
];
const baseClient = { tenantId: "tenant-a", fantasyName: null, state: "PR", region: "Sul", isArchived: false, archiveReason: null, lastPurchaseValue: 1000, financialProfile: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: daysAgo(2000) };
const clients: Row[] = [
  { ...baseClient, id: "cliente-a", name: "Cliente Ficticio A", city: "Cidade Ficticia", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(450) },
  { ...baseClient, id: "cliente-b", name: "Cliente Ficticio B", city: "Cidade Ficticia", ownerSellerId: "seller-a", lastPurchaseDate: daysAgo(30) },
  { ...baseClient, id: "cliente-c", name: "Cliente Ficticio C", city: "Outra Cidade", ownerSellerId: "seller-b", lastPurchaseDate: daysAgo(30) }
];
const baseOpportunity = { probability: 50, notes: null, crop: "soja", productOffered: "Semente ficticia", expectedCloseDate: daysAgo(-10), proposalDate: null, closedAt: null, createdAt: daysAgo(20) };
const opportunities: Row[] = [
  { ...baseOpportunity, id: "opp-a1", clientId: "cliente-a", title: "Oportunidade ficticia A1", value: 5000, stage: "negociacao", ownerSellerId: "seller-a", followUpDate: daysAgo(3), lastContactAt: daysAgo(15) },
  { ...baseOpportunity, id: "opp-a2", clientId: "cliente-a", title: "Oportunidade ficticia A2", value: 500, stage: "prospeccao", ownerSellerId: "seller-a", followUpDate: daysAgo(-5), lastContactAt: daysAgo(2) },
  { ...baseOpportunity, id: "opp-b", clientId: "cliente-b", title: "Oportunidade ficticia B", value: 2000, stage: "proposta", ownerSellerId: "seller-a", followUpDate: daysAgo(-2), lastContactAt: daysAgo(4) },
  { ...baseOpportunity, id: "opp-c", clientId: "cliente-c", title: "Oportunidade ficticia C", value: 9000, stage: "negociacao", ownerSellerId: "seller-b", followUpDate: daysAgo(5), lastContactAt: daysAgo(20) }
];
const agendaEvents: Row[] = [
  { id: "evento-a", sellerId: "seller-a", title: "Visita ficticia", type: "visita", startDateTime: todayAt10, endDateTime: new Date(todayAt10.getTime() + 3_600_000), status: "agendado", city: "Cidade Ficticia", clientId: "cliente-a", opportunityId: null, updatedAt: daysAgo(1) }
];

const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  if ("not" in condition) return value !== condition.not;
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
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((key) => !(select[key] && typeof select[key] === "object")).map((key) => [key, row[key]])) : { ...row });
const projectOpportunity = (row: Row, select?: Row) => ({
  ...pick(row, select),
  client: pick(clientOf(row)!, select?.client?.select),
  timelineEvents: [],
  activities: []
});
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

const opportunityQueries: Row[] = [];
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.name, role: user.role, region: null, isActive: true } : null;
  },
  findUnique: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, name: user.name, role: user.role, isActive: true } : null;
  },
  findMany: async ({ where }: any) => users.filter((row) => matches(row, where)).map((row) => ({ id: row.id, name: row.name, _count: { opportunities: 1, activities: 1, clients: 1 } }))
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => { const row = clients.find((candidate) => matches(candidate, where)); return row ? pick(row, select) : null; },
  findMany: async ({ where, select }: any) => clients.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), activities: [], timelineEvents: [] }))
});
setModel("opportunity", {
  count: async ({ where }: any) => opportunities.filter((row) => matches(row, where)).length,
  aggregate: async ({ where }: any) => { const rows = opportunities.filter((row) => matches(row, where)); return { _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) }, _count: rows.length }; },
  findMany: async ({ where, select }: any) => { opportunityQueries.push(where); return opportunities.filter((row) => matches(row, where)).map((row) => projectOpportunity(row, select)); }
});
setModel("activity", { findMany: async () => [], count: async () => 0 });
setModel("agendaEvent", {
  findMany: async ({ where, select }: any) => agendaEvents.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), client: select?.client ? pick(clientOf(row)!, select.client.select) : undefined, opportunity: null, stops: [] }))
});
setModel("sellerTerritoryCity", { findMany: async () => [] });
// Visitas pela carteira (valor estimado do cliente e última visita): valores padrão e nenhuma visita registrada.
setModel("appConfig", { findMany: async () => [] });
setModel("agendaStop", { groupBy: async () => [] });
setModel("activity", { groupBy: async () => [] });
setModel("erpOrderSync", { findMany: async () => [], findFirst: async () => null });
setModel("appConfig", { findUnique: async () => null });

// IA simulada: registra quem é cobrado (userId) e qual fluxo chamou; responde vazio, então vale o texto do sistema.
const aiCalls: Array<{ system: string; userId: string | null | undefined }> = [];
(aiService as any).chat = async (request: { system?: string }, options: { userId?: string | null } = {}) => {
  aiCalls.push({ system: request.system ?? "", userId: options.userId });
  return null;
};
const planningCalls: Row[] = [];
const originalWeeklyPlan = planningIntelligenceService.generateWeeklyCommercialPlan.bind(planningIntelligenceService);
planningIntelligenceService.generateWeeklyCommercialPlan = async (input) => { planningCalls.push(input); return originalWeeklyPlan(input); };

const logged: Row[] = [];
const originalInfo = console.info;
console.info = (payload: unknown) => { if (payload && typeof payload === "object") logged.push(payload as Row); };
const plannedCapability = () => logged.filter((entry) => entry.message === "[crm-assistant] plan-deterministic").at(-1)?.meta?.capability;

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
const ask = (question: string, userId = "seller-a") => call("POST", "/ai/crm-assistant/query", userId, { question, refresh: true });

// Tudo o que a tela mostra como texto: resposta, avisos, cards e o painel Evidências (rótulos dos filtros).
const visibleText = (json: Row) => JSON.stringify([
  json.answer, json.warnings, json.summary?.ordering, json.filtersApplied?.map((f: Row) => f.label),
  json.results?.map((r: Row) => [r.title, r.subtitle, r.reason, r.action?.label])
]);
const FORBIDDEN = [
  ...__conversationalCrmInternals.CRM_QUERY_CAPABILITIES, "seller-a", "seller-b", "director-a", "sellerId", "priorityScore", "deterministic",
  "Cache em memória", "Gerentes usam", "Plano determinístico", "coordenadas confiáveis", "Compromisso da agenda", "Base de Conhecimento",
  "Falha controlada", "Critérios:", "Ordenação:", "CommercialInsightsService"
];
const assertNoTechnicalText = (json: Row, label: string) => {
  const text = visibleText(json);
  for (const term of FORBIDDEN) assert(!text.includes(term), `${label}: texto da tela não contém "${term}"`);
};

const results: string[] = [];
try {
  // 1. Vendedor: "Quem devo atender hoje?" usa as prioridades da Central do Dia, só da carteira dele.
  opportunityQueries.length = 0;
  const priorities = await ask("Quem devo atender hoje?");
  assert.equal(priorities.status, 200);
  assert.equal(plannedCapability(), "today_priorities");
  assert(opportunityQueries.every((where) => where.ownerSellerId === "seller-a"), "escopo do vendedor");
  const titles = priorities.json.results.map((r: Row) => r.title);
  assert.deepEqual(titles, ["Cliente Ficticio A", "Cliente Ficticio B"], "um card por cliente, do mais urgente para o menos");
  assert.equal(priorities.json.results[0].entityId, "opp-a1", "card do cliente traz a oportunidade mais urgente");
  assert.equal(priorities.json.answer, "Encontrei 2 cliente(s) para atender hoje, do mais urgente para o menos urgente.");
  assert.deepEqual(priorities.json.filtersApplied.map((f: Row) => f.label), ["Vendedor: Vendedor Ficticio A"]);
  assertNoTechnicalText(priorities.json, "prioridades");
  for (const question of ["Quais clientes devo visitar hoje?", "Prioridades de hoje", "O que fazer hoje?", "quem devo ligar hoje"]) {
    assert.equal((await ask(question)).status, 200);
    assert.equal(plannedCapability(), "today_priorities", question);
  }
  results.push("today_priorities=PASS");

  // 2. "Minha agenda de hoje" continua na agenda do dia, com o dia de Brasília, sem o planejamento semanal nem IA da agenda.
  planningCalls.length = 0; aiCalls.length = 0;
  const agenda = await ask("Minha agenda de hoje");
  assert.equal(agenda.status, 200);
  assert.equal(plannedCapability(), "agenda_day_summary");
  assert.deepEqual(agenda.json.results.map((r: Row) => r.entityId), ["evento-a"]);
  assert.equal(agenda.json.answer, `Encontrei 1 compromisso(s) na agenda de ${today.split("-").reverse().join("/")}, em ordem de horário.`);
  assert.equal(planningCalls.length, 0, "agenda do Assistente não gera o planejamento semanal");
  assert(!aiCalls.some((c) => c.system.includes("Agenda Inteligente")), "agenda do Assistente não chama a IA da agenda");
  assertNoTechnicalText(agenda.json, "agenda");
  assert.equal((await ask("Compromissos de hoje")).status, 200);
  assert.equal(plannedCapability(), "agenda_day_summary");
  results.push("agenda_day_summary_without_weekly_plan=PASS");

  // 3. Outras respostas também sem termos internos (lista, agregado de vendedores, planejamento e campanha).
  for (const [question, userId] of [["follow-ups vencidos", "seller-a"], ["pipeline por vendedor", "director-a"], ["Como está meu planejamento da semana?", "seller-a"], ["Clientes sem atividade recente", "director-a"]] as const) {
    const response = await ask(question, userId);
    assert.equal(response.status, 200, question);
    assertNoTechnicalText(response.json, question);
  }
  results.push("no_technical_text=PASS");

  // 4. Diretor abrindo a agenda de um vendedor: a IA do planejamento (encaixes) conta na cota do diretor.
  planningCalls.length = 0; aiCalls.length = 0;
  const directorAgenda = await call("GET", `/ai/agenda-intelligence/day?date=${today}&sellerId=seller-a&refresh=true`, "director-a");
  assert.equal(directorAgenda.status, 200);
  assert.equal(planningCalls.length, 1);
  assert.equal(planningCalls[0].viewerUserId, "director-a");
  const planningAi = aiCalls.filter((c) => c.system.includes("planejamento comercial semanal"));
  assert.equal(planningAi.length, 1);
  assert.equal(planningAi[0].userId, "director-a", "IA do planejamento na cota do diretor");
  assert(aiCalls.every((c) => c.userId === "director-a"), "nenhuma chamada cobrada do vendedor");
  results.push("director_agenda_ai_quota=PASS");

  // 5. Painel Evidências e cabeçalho da tela: sem intent cru, sem campo/operador e fonte como IA ou Sistema.
  const webSource = readFileSync(new URL("../../../web/src/pages/CrmAssistantPage.tsx", import.meta.url), "utf8");
  assert(webSource.includes("{f.label}"));
  assert(!webSource.includes("{f.field} {f.operator}"));
  assert(!webSource.includes("response.intent"));
  assert(webSource.includes('=== "ai" ? "IA" : "Sistema"'));
  assert(!webSource.includes("CRM Assistant") && !webSource.includes("catálogo seguro"));
  const routeSource = readFileSync(new URL("./conversationalCrmRoutes.ts", import.meta.url), "utf8");
  assert(routeSource.includes("Não foi possível responder agora. Tente de novo.") && !routeSource.includes("Falha controlada"));
  results.push("evidence_panel_labels=PASS");

  console.log(`CRM_ASSISTANT_TODAY=PASS ${results.join(" ")}`);
} finally {
  console.info = originalInfo;
  server.close();
}
