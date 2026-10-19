import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AiProviderError, type AiChatRequest, type AiProvider } from "../services/ai/aiProvider.js";
import { aiService } from "../services/ai/aiService.js";
import { __timelineIntelligenceCache } from "../services/timelineIntelligenceService.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: contexto de IA pela regra oficial da carteira, filtro do que vai ao provedor, arquivados fora
// dos pontos de IA e da Central do Dia, /ai/status só para gestão e teto diário de chamadas por usuário.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number) => new Date(Date.now() + days * DAY_MS);

// Dados sensíveis inventados gravados no cadastro e nos textos: nenhum pode chegar ao provedor.
const SENSITIVE = {
  cnpj: "12.345.678/0001-95",
  cpf: "123.456.789-09",
  phone: "(11) 98765-4321",
  email: "cliente.ficticio@exemplo.test",
  address: "Rua das Flores Ficticias, 123",
  cep: "01234-567",
  ie: "123.456.789.110"
};

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" }
];
const client = (id: string, lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, tenantId: "tenant-a", name: `Cliente Ficticio ${id}`, fantasyName: null, city: "Cidade Ficticia", state: "PR", region: "Sul",
  ownerSellerId: "seller-a", isArchived: false, archiveReason: null, potentialHa: 120, lastPurchaseDate, lastPurchaseValue: 4321.98,
  financialProfile: null, openTitlesTotal: 8765.43, overdueTitlesTotal: 1111.11, createdAt: daysAgo(2000),
  cnpj: SENSITIVE.cnpj, cpf: SENSITIVE.cpf, phone: SENSITIVE.phone, email: SENSITIVE.email, address: SENSITIVE.address, zipCode: SENSITIVE.cep, stateRegistration: SENSITIVE.ie,
  ...extra
});
const clients: Row[] = [
  client("ativo", daysAgo(30)),
  client("esfriando", daysAgo(300)),
  client("recente", daysAgo(450)),
  client("ex", daysAgo(900)),
  client("ex-pedido", daysAgo(900)),
  client("prospect", null),
  client("arquivado", daysAgo(450), { isArchived: true, archiveReason: "Arquivado manualmente" })
];
// Pedido sent do CRM mais recente que o ERP: o ex-cliente no ERP é ativo.
const erpOrders: Row[] = [{ clientId: "ex-pedido", opportunityId: "opp-ex-pedido", status: "sent", sentAt: daysAgo(20), createdAt: daysAgo(20) }];
const opportunity = (id: string, clientId: string, extra: Row = {}): Row => ({
  id, clientId, title: `Oportunidade ficticia ${id}`, value: 55555, probability: 70, stage: "negociacao", ownerSellerId: "seller-a",
  notes: `Cliente pediu retorno no ${SENSITIVE.phone} ou ${SENSITIVE.email}`, crop: "soja", productOffered: "Semente ficticia",
  followUpDate: daysAgo(3), expectedCloseDate: daysAhead(10), proposalDate: null, lastContactAt: daysAgo(5), closedAt: null, createdAt: daysAgo(20), ...extra
});
const opportunities: Row[] = [
  opportunity("opp-ex-pedido", "ex-pedido"),
  opportunity("opp-ex", "ex"),
  opportunity("opp-arquivado", "arquivado", { value: 99999 })
];
const activities: Row[] = clients.map((row) => ({
  id: `act-${row.id}`, clientId: row.id, opportunityId: null, ownerSellerId: "seller-a", type: "ligacao", done: true,
  dueDate: daysAgo(10), date: daysAgo(10), createdAt: daysAgo(10), product: null, result: null,
  notes: `Conversa com o comprador; CPF ${SENSITIVE.cpf}, entregar na ${SENSITIVE.address}, CEP ${SENSITIVE.cep}`,
  description: `Ligação para ${SENSITIVE.phone}`
}));
const appConfig = new Map<string, string>();

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
    if (key === "NOT") return !matches(row, condition);
    if (key === "client") { const related = clientOf(row); return related ? matches(related, condition) : false; }
    if (key === "opportunity") return matches(row, condition);
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((key) => !(select[key] && typeof select[key] === "object")).map((key) => [key, row[key]])) : { ...row });
const projectOpportunity = (row: Row, select?: Row) => ({
  ...pick(row, select),
  client: pick(clientOf(row)!, select?.client?.select),
  ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio", isActive: true },
  timelineEvents: [],
  activities: activities.filter((activity) => activity.clientId === row.clientId).map((activity) => pick(activity, select?.activities?.select))
});

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const queries: Record<string, Row[]> = { opportunityAggregate: [], opportunityCount: [] };

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
  findUnique: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, name: user.id, role: user.role, isActive: true } : null;
  },
  findMany: async () => [{ id: "seller-a", name: "Vendedor Ficticio", _count: { opportunities: 3, activities: 7, clients: 7 } }]
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => {
    const row = clients.find((candidate) => matches(candidate, where));
    return row ? pick(row, select) : null;
  },
  findMany: async ({ where, select }: any) => clients.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), activities: [] }))
});
setModel("opportunity", {
  count: async ({ where }: any) => { queries.opportunityCount.push(where); return opportunities.filter((row) => matches(row, where)).length; },
  aggregate: async ({ where }: any) => {
    queries.opportunityAggregate.push(where);
    const rows = opportunities.filter((row) => matches(row, where));
    return { _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) }, _count: rows.length };
  },
  findFirst: async ({ where, select }: any) => {
    const row = opportunities.find((candidate) => matches(candidate, where));
    return row ? projectOpportunity(row, select) : null;
  },
  findMany: async ({ where, select, include }: any) =>
    opportunities.filter((row) => matches(row, where)).map((row) => (include ? { ...row, client: pick(clientOf(row)!, include.client?.select), ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio", isActive: true } } : projectOpportunity(row, select)))
});
setModel("activity", {
  count: async ({ where }: any) => activities.filter((row) => matches(row, where)).length,
  aggregate: async ({ where }: any) => {
    const rows = activities.filter((row) => matches(row, where));
    return { _max: { date: rows[0]?.date ?? null, createdAt: rows[0]?.createdAt ?? null } };
  },
  findMany: async ({ where, select }: any) => activities.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), opportunity: null }))
});
setModel("timelineEvent", { findFirst: async () => null, findMany: async () => [] });
setModel("opportunityChangeLog", { findMany: async () => [] });
setModel("erpOrderSync", {
  findMany: async ({ where }: any) =>
    erpOrders
      .filter((order) => order.status === where.status && matches(order, where.opportunity))
      .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, orderStatus: null, operationalOrderStatus: "UNKNOWN", opportunity: { clientId: order.clientId } })),
  findFirst: async ({ where }: any) => erpOrders.find((order) => order.opportunityId === where?.opportunityId) ?? null
});
setModel("knowledgeDocument", { findMany: async () => [], findFirst: async () => null });
setModel("appConfig", {
  findUnique: async ({ where }: any) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    appConfig.set(where.key, appConfig.has(where.key) ? update.value : create.value);
    return { key: where.key, value: appConfig.get(where.key) };
  }
});

// Provedor de IA falso: guarda o que receberia e responde conforme o fluxo.
const received: AiChatRequest[] = [];
let providerMode: "ok" | "fail" = "ok";
const fakeProvider: AiProvider = {
  name: "fake-provider",
  model: "fake/model-free",
  mode: "fake",
  getStatus: () => ({ provider: "fake-provider", model: "fake/model-free", configured: true, mode: "fake" }),
  chat: async (request) => {
    received.push(request);
    if (providerMode === "fail") throw new AiProviderError("falha", { status: 500, elapsedMs: 1, code: "http_500" });
    const content = request.messages.map((message) => message.content).join("\n");
    const reply = content.includes("Gere uma sugestão")
      ? JSON.stringify({ status: "parado", summary: "Resumo da IA ficticia", recommendation: "Reativar", nextAction: "Ligar hoje", riskLevel: "alto" })
      : JSON.stringify({ message: "Bom dia! Mensagem ficticia da IA." });
    return { content: reply, model: "fake/model-free", elapsedMs: 1, usage: { totalTokens: 21 } };
  }
};
(aiService as any).provider = fakeProvider;
const setAi = (enabled: boolean) => { env.aiChatEnabled = enabled; };

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
// Texto exato que o provedor receberia (system e mensagens).
const lastSent = () => {
  const request = received.at(-1)!;
  return [request.system ?? "", ...request.messages.map((message) => message.content)].join("\n");
};
const assertNothingSensitive = (sent: string) => {
  for (const value of Object.values(SENSITIVE)) assert(!sent.includes(value), `vazou ${value}`);
  for (const value of ["4321.98", "8765.43", "1111.11", "55555", "99999"]) assert(!sent.includes(value), `vazou valor ${value}`);
  assert.doesNotMatch(sent, /"(id|clientId|opportunityId)":/, "ids internos ficam fora");
  for (const field of ["potentialHa", "archiveReason", "isArchived"]) assert(!sent.includes(field), `vazou ${field}`);
};

const results: string[] = [];
try {
  // 1. Sugestão inteligente determinística pela situação oficial (sem os 60/90 dias).
  setAi(false);
  const suggestion = async (clientId: string, userId = "seller-a") => call("POST", "/ai/client-suggestion", userId, { clientId });
  const recente = await suggestion("recente");
  assert.equal(recente.status, 200);
  assert.equal(recente.json.status, "parado");
  assert.match(recente.json.recommendation, /^Reativar/);
  assert.match(recente.json.summary, /Situação da carteira: Inativo recente\./);
  // O ex-cliente tem oportunidade aberta: a sugestão é de negociação, mas o resumo traz a situação oficial.
  assert.match((await suggestion("ex")).json.summary, /Situação da carteira: Ex-cliente\./);
  results.push("suggestion_reactivation=PASS");
  const prospect = await suggestion("prospect");
  assert.match(prospect.json.recommendation, /primeira venda/i);
  assert.match(prospect.json.summary, /Situação da carteira: Prospect\./);
  const esfriando = await suggestion("esfriando");
  assert.equal(esfriando.json.status, "ativo");
  assert.match(esfriando.json.recommendation, /^Manutenção e recompra/);
  assert.match(esfriando.json.summary, /Situação da carteira: Ativo \(esfriando\)\./);
  const ativo = await suggestion("ativo");
  assert.equal(ativo.json.riskLevel, "baixo");
  assert.match(ativo.json.recommendation, /^Manter acompanhamento/);
  // Pedido sent do CRM define a última compra (ERP antigo, pedido recente): ativo, não ex-cliente.
  assert.match((await suggestion("ex-pedido")).json.summary, /Situação da carteira: Ativo\./);
  results.push("suggestion_official_status=PASS");

  // 2. Mensagem de WhatsApp determinística coerente com a situação.
  const whatsapp = async (clientId: string, userId = "seller-a") => call("POST", "/ai/assistant-whatsapp-message", userId, { clientId });
  assert.match((await whatsapp("recente")).json.message, /Faz um tempo que não movimentamos pedidos/);
  assert.match((await whatsapp("prospect")).json.message, /Queria me apresentar/);
  assert.match((await whatsapp("esfriando")).json.message, /reposição/);
  assert.match((await whatsapp("ativo")).json.message, /Queria retomar nosso contato/);
  assert.equal((await whatsapp("ativo")).json.source, "deterministic");
  results.push("whatsapp_official_status=PASS");

  // 3. Com IA: contexto oficial chega ao provedor e nada sensível sai.
  setAi(true);
  const aiSuggestion = await suggestion("recente");
  assert.equal(aiSuggestion.json.source, "ai");
  let sent = lastSent();
  assert.match(sent, /Inativo recente/);
  assert.match(sent, /Reativação/);
  assert.match(sent, /Cliente Ficticio recente/);
  assert.match(sent, /Cidade Ficticia/);
  assertNothingSensitive(sent);
  const aiWhatsapp = await whatsapp("prospect");
  assert.equal(aiWhatsapp.json.source, "ai");
  sent = lastSent();
  assert.match(sent, /Prospect/);
  assert.match(sent, /Primeira venda/);
  assertNothingSensitive(sent);
  const message = await call("GET", "/ai/opportunity-message?opportunityId=opp-ex-pedido", "seller-a");
  assert.equal(message.status, 200);
  sent = lastSent();
  assert.match(sent, /"situacaoCarteira":"Ativo"/);
  assert.doesNotMatch(sent, /"valor"|"probabilidade"/);
  assertNothingSensitive(sent);
  received.length = 0;
  __timelineIntelligenceCache.clear();
  const aiTimeline = await call("GET", "/ai/timeline-intelligence/client/recente?refresh=true", "seller-a");
  assert.equal(aiTimeline.status, 200);
  sent = lastSent();
  assert.match(sent, /Inativo recente/);
  assertNothingSensitive(sent);
  results.push("provider_payload_filtered=PASS");

  // 4. Arquivado fora de cada ponto de IA.
  assert.equal((await suggestion("arquivado")).status, 404);
  assert.equal((await whatsapp("arquivado")).status, 404);
  assert.equal((await call("POST", "/ai/opportunity-insight", "seller-a", { opportunityId: "opp-arquivado" })).status, 409);
  assert.equal((await call("GET", "/ai/opportunity-message?opportunityId=opp-arquivado", "seller-a")).status, 409);
  assert.equal((await call("GET", "/ai/timeline-intelligence/client/arquivado", "seller-a")).status, 404);
  assert.equal((await call("GET", "/ai/timeline-intelligence/opportunity/opp-arquivado", "seller-a")).status, 404);
  assert.equal((await call("POST", "/ai/opportunity-insight", "seller-a", { opportunityId: "opp-ex" })).status, 200, "não arquivado continua");
  // Central do Dia (follow-ups vencidos, alertas e "Oportunidades críticas").
  const central = await call("GET", "/opportunities?status=open&excludeArchivedClients=true", "seller-a");
  assert.equal(central.status, 200);
  assert.deepEqual(central.json.map((row: Row) => row.id).sort(), ["opp-ex", "opp-ex-pedido"]);
  const pipelinePage = await call("GET", "/opportunities?status=open", "seller-a");
  assert(pipelinePage.json.some((row: Row) => row.id === "opp-arquivado"), "sem o parâmetro, a tela de oportunidades segue igual");
  results.push("archived_excluded=PASS");

  // 5. Assistente Comercial: follow-ups vencidos e pipeline sem arquivados; score com o pedido sent do CRM.
  setAi(false);
  const ask = async (question: string, userId: string) => call("POST", "/ai/crm-assistant/query", userId, { question, refresh: true });
  const overdue = await ask("follow-ups vencidos", "seller-a");
  assert.equal(overdue.status, 200);
  const overdueIds = overdue.json.results.map((row: Row) => row.entityId);
  assert.deepEqual([...overdueIds].sort(), ["opp-ex", "opp-ex-pedido"]);
  const reasonOf = (id: string) => overdue.json.results.find((row: Row) => row.entityId === id).reason as string;
  assert.match(reasonOf("opp-ex"), /Ex-cliente/);
  assert.doesNotMatch(reasonOf("opp-ex-pedido"), /Ex-cliente|Inativo recente/, "pedido sent do CRM torna o cliente ativo no score");
  queries.opportunityAggregate.length = 0; queries.opportunityCount.length = 0;
  const pipeline = await ask("pipeline por vendedor", "director-a");
  assert.equal(pipeline.status, 200);
  assert(queries.opportunityAggregate.length > 0 && queries.opportunityAggregate.every((where) => where.client?.isArchived === false));
  assert(queries.opportunityCount.length > 0 && queries.opportunityCount.every((where) => where.client?.isArchived === false));
  assert.match(pipeline.json.results[0].subtitle, /Pipeline R\$ 111\.110/, "pipeline soma só oportunidades de clientes não arquivados");
  // Timeline: mesmo score oficial.
  __timelineIntelligenceCache.clear();
  const timelineReasons = async (opportunityId: string) => (await call("GET", `/ai/timeline-intelligence/opportunity/${opportunityId}?refresh=true`, "seller-a")).json.priority.reasons.join(" | ");
  assert.match(await timelineReasons("opp-ex"), /Ex-cliente/);
  assert.doesNotMatch(await timelineReasons("opp-ex-pedido"), /Ex-cliente|Inativo recente/);
  results.push("crm_order_in_score=PASS");

  // 6. /ai/status só para diretor e gerente; teto configurável só pelo diretor.
  assert.equal((await call("GET", "/ai/status", "seller-a")).status, 403);
  const status = await call("GET", "/ai/status", "manager-a");
  assert.equal(status.status, 200);
  assert.equal(status.json.dailyCallLimitPerUser, 50);
  assert.equal((await call("GET", "/ai/status", "director-a")).status, 200);
  assert.equal((await call("PUT", "/ai/usage-config", "seller-a", { dailyCallLimitPerUser: 1 })).status, 403);
  assert.equal((await call("PUT", "/ai/usage-config", "manager-a", { dailyCallLimitPerUser: 1 })).status, 403);
  assert.equal((await call("PUT", "/ai/usage-config", "director-a", { dailyCallLimitPerUser: 0 })).status, 400);
  assert.equal((await call("PUT", "/ai/usage-config", "director-a", { dailyCallLimitPerUser: 1 })).status, 200);
  assert.equal((await call("GET", "/ai/status", "director-a")).json.dailyCallLimitPerUser, 1);
  results.push("ai_status_management_only=PASS");

  // 7. Teto estourado: fallback determinístico sem erro (o gerente ainda não usou a IA hoje).
  setAi(true);
  received.length = 0;
  const first = await suggestion("recente", "manager-a");
  assert.equal(first.json.source, "ai");
  const second = await suggestion("recente", "manager-a");
  assert.equal(second.status, 200);
  assert.equal(second.json.source, "deterministic");
  const thirdWhatsapp = await whatsapp("recente", "manager-a");
  assert.equal(thirdWhatsapp.status, 200);
  assert.equal(thirdWhatsapp.json.source, "deterministic");
  assert.equal(received.length, 1, "acima do teto o provedor não é chamado");
  results.push("daily_limit_fallback=PASS");

  // 8. Falha do provedor: fallback determinístico sem erro.
  assert.equal((await call("PUT", "/ai/usage-config", "director-a", { dailyCallLimitPerUser: 50 })).status, 200);
  providerMode = "fail";
  const failed = await suggestion("prospect", "director-a");
  assert.equal(failed.status, 200);
  assert.equal(failed.json.source, "deterministic");
  assert.match(failed.json.recommendation, /primeira venda/i);
  const failedWhatsapp = await whatsapp("prospect", "director-a");
  assert.equal(failedWhatsapp.status, 200);
  assert.equal(failedWhatsapp.json.source, "deterministic");
  results.push("provider_failure_fallback=PASS");

  console.log(`AI_CONTEXT_OFFICIAL_RULE=PASS ${results.join(" ")}`);
} finally {
  server.close();
}
