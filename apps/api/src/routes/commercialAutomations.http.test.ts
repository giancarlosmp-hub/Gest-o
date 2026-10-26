import assert from "node:assert/strict";
import { once } from "node:events";
import { mock } from "node:test";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import {
  COMMERCIAL_AUTOMATIONS_CONFIG_KEY,
  COMMERCIAL_AUTOMATIONS_HISTORY_KEY,
  DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG,
  WORKFLOW_INACTIVE_CLIENT_ORIGIN,
  runCommercialAutomations,
  simulateCommercialAutomations
} from "../services/commercialAutomationsService.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: automação de clientes sem compra pela regra oficial da carteira (só inativos recentes),
// com teto diário por vendedor no dia de Brasília. "Agora" = segunda 19/10/2026 09:00 em Brasília.
type Row = Record<string, any>;
const DAY_MS = 86_400_000;
const now = new Date("2026-10-19T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor", isActive: true },
  { id: "manager-a", role: "gerente", isActive: true },
  { id: "seller-a", role: "vendedor", isActive: true },
  { id: "seller-b", role: "vendedor", isActive: true },
  { id: "seller-off", role: "vendedor", isActive: false },
];
const client = (id: string, ownerSellerId: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, ownerSellerId, isArchived: false, lastPurchaseDate, lastPurchaseValue: 90000, financialProfile: null, ...extra,
});
const clients: Row[] = [
  // Fora pela situação: ativo, esfriando, ex-cliente, prospect e arquivado.
  client("ativo", "seller-a", daysAgo(30)),
  client("esfriando", "seller-a", daysAgo(300)),
  client("ex-cliente", "seller-a", daysAgo(900)),
  client("prospect", "seller-a", null),
  client("arquivado", "seller-a", daysAgo(450), { isArchived: true }),
  // seller-a: 7 inativos recentes; o teto de 5 leva os de compra mais recente.
  ...[600, 400, 550, 420, 500, 450, 480].map((days) => client(`a-${days}`, "seller-a", daysAgo(days))),
  // Vendedor desligado.
  client("off-1", "seller-off", daysAgo(430)),
  // seller-b: oportunidade aberta, automação há 30 dias (perdida), automação há 100 dias e um sem nada.
  client("b-aberta", "seller-b", daysAgo(410)),
  client("b-auto-30", "seller-b", daysAgo(415)),
  client("b-auto-100", "seller-b", daysAgo(420)),
  client("b-livre", "seller-b", daysAgo(700)),
  // Inativo recente só pelo perfil do ERP (DATA_ULTFATURA).
  client("b-perfil", "seller-b", null, { financialProfile: { DATA_ULTFATURA: daysAgo(380).toISOString() } }),
  // Ativo só pelo pedido CRM enviado: fica fora.
  client("b-pedido", "seller-b", daysAgo(500)),
];
const crmOrders: Row[] = [{ clientId: "b-pedido", status: "sent", sentAt: daysAgo(20), createdAt: daysAgo(20), orderStatus: null, operationalOrderStatus: "UNKNOWN" }];
const automationNotes = `${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\nFicticio.`;
let opportunities: Row[] = [];
let activities: Row[] = [];
let agendaEvents: Row[] = [];
let timelineEvents: Row[] = [];
const resetOpportunities = () => {
  opportunities = [
    { id: "opp-aberta", clientId: "b-aberta", ownerSellerId: "seller-b", stage: "negociacao", notes: null, createdAt: daysAgo(10) },
    { id: "opp-auto-30", clientId: "b-auto-30", ownerSellerId: "seller-b", stage: "perdido", notes: automationNotes, createdAt: daysAgo(30) },
    { id: "opp-auto-100", clientId: "b-auto-100", ownerSellerId: "seller-b", stage: "perdido", notes: automationNotes, createdAt: daysAgo(100) },
    // Já criadas hoje para seller-b (dia de Brasília): 4 de 5; a das 23:30 de ontem em Brasília não conta.
    ...["ativo", "esfriando", "ex-cliente", "prospect"].map((clientId, index) => ({
      id: `opp-hoje-${index}`, clientId, ownerSellerId: "seller-b", stage: "ganho", notes: automationNotes, createdAt: new Date("2026-10-19T03:30:00.000Z"),
    })),
    { id: "opp-ontem", clientId: "ativo", ownerSellerId: "seller-a", stage: "ganho", notes: automationNotes, createdAt: new Date("2026-10-19T02:30:00.000Z") },
  ];
  activities = [];
  agendaEvents = [];
  timelineEvents = [];
};
const appConfig = new Map<string, string>();
const writes: string[] = [];
let clock = now;

const matchValue = (value: any, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    if ("in" in condition && !condition.in.includes(value)) return false;
    if ("contains" in condition && !(typeof value === "string" && value.includes(condition.contains))) return false;
    if ("gte" in condition && !(value != null && value >= condition.gte)) return false;
    return true;
  }
  return value === condition;
};
const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    if (key === "opportunity") return matches(row, condition);
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => {
  if (!select) return { ...row };
  const picked: Row = Object.fromEntries(Object.keys(select).filter((key) => key !== "ownerSeller").map((key) => [key, row[key]]));
  if (select.ownerSeller) picked.ownerSeller = { isActive: users.find((user) => user.id === row.ownerSellerId)?.isActive ?? false };
  return picked;
};
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", { findMany: async ({ where, select }: any) => clients.filter((row) => matches(row, where)).map((row) => pick(row, select)) });
setModel("erpOrderSync", {
  findMany: async ({ where }: any) =>
    crmOrders.filter((order) => order.status === where.status && matches(order, where.opportunity)).map((order) => ({ ...order, opportunity: { clientId: order.clientId } })),
});
setModel("opportunity", {
  findMany: async ({ where, select }: any) => opportunities.filter((row) => matches(row, where)).map((row) => pick(row, select)),
  create: async ({ data }: any) => {
    writes.push("opportunity");
    const row = { id: `opp-nova-${opportunities.length}`, createdAt: clock, ...data };
    opportunities.push(row);
    return row;
  },
});
setModel("activity", { create: async ({ data }: any) => { writes.push("activity"); activities.push(data); return data; } });
setModel("agendaEvent", { create: async ({ data }: any) => { writes.push("agendaEvent"); agendaEvents.push(data); return data; } });
setModel("timelineEvent", { create: async ({ data }: any) => { writes.push("timelineEvent"); timelineEvents.push(data); return data; } });
setModel("appConfig", {
  findUnique: async ({ where }: any) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    if (!appConfig.has(where.key)) { writes.push(`appConfig:${where.key}`); appConfig.set(where.key, create.value); }
    else if (update?.value !== undefined) { writes.push(`appConfig:${where.key}`); appConfig.set(where.key, update.value); }
    return { value: appConfig.get(where.key) };
  },
});
(prisma as any).$transaction = async (callback: any) => callback(prisma);

const saveConfig = (overrides: Row) =>
  appConfig.set(COMMERCIAL_AUTOMATIONS_CONFIG_KEY, JSON.stringify({ inactiveClientWorkflow: { ...DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow, ...overrides } }));
const history = () => JSON.parse(appConfig.get(COMMERCIAL_AUTOMATIONS_HISTORY_KEY) ?? "[]");
const created = () => opportunities.filter((row) => row.id.startsWith("opp-nova"));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const request = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
};

try {
  // Padrão: desligada, etapa prospeccao, prazo 2 dias úteis, teto 5.
  assert.equal(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow.enabled, false);
  assert.equal(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow.initialOpportunityStage, "prospeccao");
  assert.equal(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow.returnDeadlineBusinessDays, 2);
  assert.equal(DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow.dailyLimitPerSeller, 5);

  // Etapa inválida é recusada ao salvar, com erro claro; nada é gravado.
  const validConfig = { inactiveClientWorkflow: { ...DEFAULT_COMMERCIAL_AUTOMATIONS_CONFIG.inactiveClientWorkflow } };
  const invalidStage = await request("PUT", "/settings/commercial-automations", "director-a", { inactiveClientWorkflow: { ...validConfig.inactiveClientWorkflow, initialOpportunityStage: "follow_up" } });
  assert.equal(invalidStage.status, 400);
  assert.equal(invalidStage.json.message, "Etapa inicial inválida. Use prospeccao, negociacao ou proposta.");
  for (const stage of ["ganho", "perdido"]) {
    const closed = await request("PUT", "/settings/commercial-automations", "director-a", { inactiveClientWorkflow: { ...validConfig.inactiveClientWorkflow, initialOpportunityStage: stage } });
    assert.equal(closed.status, 400, `etapa ${stage} recusada`);
  }
  const invalidLimit = await request("PUT", "/settings/commercial-automations", "director-a", { inactiveClientWorkflow: { ...validConfig.inactiveClientWorkflow, dailyLimitPerSeller: 0 } });
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.json.message, "Teto diário deve ser de 1 a 50 por vendedor.");
  const invalidDeadline = await request("PUT", "/settings/commercial-automations", "director-a", { inactiveClientWorkflow: { ...validConfig.inactiveClientWorkflow, returnDeadlineBusinessDays: 3 } });
  assert.equal(invalidDeadline.status, 400);
  assert.equal(appConfig.has(COMMERCIAL_AUTOMATIONS_CONFIG_KEY), false, "configuração inválida não é gravada");
  // Configuração antiga sem teto recebe o padrão 5 ao salvar.
  const { dailyLimitPerSeller: _omitted, ...legacyWorkflow } = validConfig.inactiveClientWorkflow;
  const saved = await request("PUT", "/settings/commercial-automations", "director-a", { inactiveClientWorkflow: legacyWorkflow });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.inactiveClientWorkflow.dailyLimitPerSeller, 5);
  assert.equal(saved.json.inactiveClientWorkflow.enabled, false);
  const sellerPut = await request("PUT", "/settings/commercial-automations", "manager-a", validConfig);
  assert.equal(sellerPut.status, 403, "só diretor altera");

  // Simulação: só inativos recentes, sem gravar nada.
  resetOpportunities();
  writes.length = 0;
  const simulation = await simulateCommercialAutomations(now);
  assert.deepEqual(writes, [], "simulação não grava");
  assert.equal(simulation.enabled, false);
  assert.deepEqual(simulation.configIssues, []);
  assert.equal(simulation.dayKey, "2026-10-19");
  assert.equal(simulation.dailyLimitPerSeller, 5);
  // 7 de seller-a + off-1 + 5 de seller-b (b-pedido é ativo pelo pedido CRM).
  assert.equal(simulation.inactiveRecentClients, 13);
  assert.deepEqual(simulation.skipped, { inactiveSeller: 1, openOpportunity: 1, recentAutomation: 1, dailyLimit: 2 + 2 });
  assert.equal(simulation.eligibleClients, 10);
  // seller-a: 5 (a das 23:30 de ontem não conta); seller-b: 1 (4 de 5 já usados hoje).
  assert.equal(simulation.wouldCreate, 6);
  // A rota simula com o relógio real: fixa o Date no "agora" do teste só durante a chamada.
  mock.timers.enable({ apis: ["Date"], now });
  const httpSimulation = await request("GET", "/commercial-automations/simulation", "manager-a");
  mock.timers.reset();
  assert.equal(httpSimulation.status, 200);
  assert.equal(httpSimulation.json.wouldCreate, 6);
  assert.equal((await request("GET", "/commercial-automations/simulation", "seller-a")).status, 403);
  assert.deepEqual(writes, [], "rota de simulação não grava");

  // Desligada: não cria nada; a execução fica no histórico.
  const disabled = await runCommercialAutomations("manual", now);
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.reason, "workflow_disabled");
  assert.deepEqual(created(), []);
  assert.deepEqual(writes, [`appConfig:${COMMERCIAL_AUTOMATIONS_HISTORY_KEY}`]);
  assert.equal(history()[0].reason, "workflow_disabled");

  // Configuração salva antiga (etapa follow_up, prazo 3) ligada: não troca a etapa em silêncio, não cria nada.
  saveConfig({ enabled: true, initialOpportunityStage: "follow_up", returnDeadlineBusinessDays: 3 });
  const legacy = await runCommercialAutomations("scheduler", now);
  assert.equal(legacy.reason, "invalid_config");
  assert.deepEqual(legacy.configIssues, ["Prazo de retorno deve ser de 1 ou 2 dias úteis.", "Etapa inicial inválida. Use prospeccao, negociacao ou proposta."]);
  assert.deepEqual(created(), []);
  assert.deepEqual((await simulateCommercialAutomations(now)).configIssues, legacy.configIssues, "simulação mostra o problema da configuração");

  // Ligada e válida: cria só para inativos recentes, até o teto diário por vendedor.
  saveConfig({ enabled: true });
  const run = await runCommercialAutomations("scheduler", now);
  assert.equal(run.skipped, false);
  assert.equal(run.createdOpportunities, 6);
  assert.equal(run.createdAgendaEvents, 6);
  assert.equal(activities.length, 0, "automação não cria atividade pendente");
  assert.equal(run.createdTimelineEvents, 6);
  assert.deepEqual(run.skippedByReason, simulation.skipped, "a simulação antecipa a execução");
  const createdIds = created().map((row) => row.clientId);
  assert.deepEqual(createdIds, ["b-perfil", "a-400", "a-420", "a-450", "a-480", "a-500"], "compra mais recente primeiro; excedente fica para depois");
  for (const outside of ["ativo", "esfriando", "ex-cliente", "prospect", "arquivado", "off-1", "b-aberta", "b-auto-30", "b-pedido"]) {
    assert(!createdIds.includes(outside), `${outside} fica fora`);
  }
  const first = created().find((row) => row.clientId === "a-400")!;
  const firstCall = agendaEvents.find((row) => row.opportunityId === first.id)!;
  assert.equal(first.title, "Reativação – Cliente Ficticio a-400");
  assert.equal(first.value, 0, "valor 0 não infla o pipeline");
  assert.equal(first.stage, "prospeccao");
  assert.equal(first.ownerSellerId, "seller-a");
  assert(first.notes.startsWith(`${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\n`), "origem marcada como automação");
  assert.equal(first.followUpDate.toISOString(), "2026-10-21T00:00:00.000Z", "segunda + 2 dias úteis = quarta");
  assert.equal(firstCall.type, "ligacao", "compromisso de Ligação na Agenda");
  assert.equal(firstCall.sellerId, "seller-a");
  assert.equal(firstCall.clientId, "a-400");
  assert.equal(firstCall.opportunityId, first.id);
  assert.equal(firstCall.startDateTime.toISOString(), "2026-10-21T12:00:00.000Z", "quarta às 9h de Brasília");
  assert.equal(firstCall.endDateTime.toISOString(), "2026-10-21T12:30:00.000Z");
  assert.equal(timelineEvents.find((row) => row.opportunityId === first.id)!.type, "status");
  assert.equal(history()[0].createdOpportunities, 6);
  assert.deepEqual(history()[0].skippedByReason, run.skippedByReason);

  // Mesma data em Brasília (23:00 BRT): teto já usado, não cria mais.
  clock = new Date("2026-10-20T02:00:00.000Z");
  const sameDay = await runCommercialAutomations("scheduler", clock);
  assert.equal(sameDay.dayKey, "2026-10-19");
  assert.equal(sameDay.createdOpportunities, 0);
  assert.equal(sameDay.skippedByReason.dailyLimit, 4, "a-550, a-600, b-auto-100 e b-livre esperam");

  // Sexta: o excedente entra; quem já tem oportunidade aberta não duplica. Prazo: terça seguinte.
  clock = new Date("2026-10-23T12:00:00.000Z");
  const friday = await runCommercialAutomations("scheduler", clock);
  assert.deepEqual(created().slice(6).map((row) => row.clientId), ["b-auto-100", "a-550", "a-600", "b-livre"]);
  assert.equal(friday.skippedByReason.openOpportunity, 1 + 6);
  assert.equal(created()[6].followUpDate.toISOString(), "2026-10-27T00:00:00.000Z");
  assert.equal(agendaEvents[6].startDateTime.toISOString(), "2026-10-27T12:00:00.000Z", "terça às 9h de Brasília");

  // Não recria em 90 dias, mesmo com a oportunidade da automação encerrada (b-auto-100 voltou porque a anterior
  // tinha mais de 90 dias).
  for (const row of created()) row.stage = "perdido";
  clock = new Date("2026-12-01T12:00:00.000Z");
  const later = await runCommercialAutomations("scheduler", clock);
  assert.equal(later.createdOpportunities, 0);
  // b-livre virou ex-cliente em dezembro e sai da lista; os outros 9 criados + b-auto-30 ficam fora pelos 90 dias.
  assert.equal(later.inactiveRecentClients, 12);
  assert.equal(later.skippedByReason.recentAutomation, 9 + 1);

  // Histórico persistente, mais recente primeiro, exposto na rota.
  const historyResponse = await request("GET", "/commercial-automations/history", "director-a");
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(historyResponse.json.history.map((entry: Row) => entry.createdOpportunities), [0, 4, 0, 6, 0, 0]);
  assert.deepEqual(historyResponse.json.history.map((entry: Row) => entry.trigger), ["scheduler", "scheduler", "scheduler", "scheduler", "scheduler", "manual"]);

  console.log("commercial automations tests passed");
} finally {
  server.close();
}
