import assert from "node:assert/strict";
import { once } from "node:events";
import { CLIENT_IN_COLLECTION_RECOMMENDATION } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import type { AiChatRequest, AiProvider } from "../services/ai/aiProvider.js";
import { aiService } from "../services/ai/aiService.js";
import { SUGGESTION_BY_APPROACH } from "../services/clientSuggestion.js";
import { isSellerObservationEvent } from "../services/sellerObservation.js";
import { brazilTodayKey } from "../utils/dateRange.js";
import { signAccessToken } from "../utils/jwt.js";

// Registros de sistema na timeline (sincronização, pedido ERP, mensagem do WhatsApp oficial) não viram observação
// recente nem contexto da IA; o Resumo automático segue a situação oficial da carteira. Dados fictícios; Prisma e
// IA simulados.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const dueDaysAgo = (days: number) => `${new Date(Date.parse(`${brazilTodayKey()}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10)}T03:00:00.000Z`;

const SELLER_NOTE = "Cliente ficticio pediu retorno sobre a proposta de semente";
const SYSTEM_NOTE = "Registro tecnico ficticio gravado pela sincronizacao";
const WHATSAPP_NOTE = "Mensagem ficticia recebida pelo canal oficial";

const users: Row[] = [{ id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A" }];
const baseClient = { tenantId: "tenant-a", code: null, cnpj: null, fantasyName: null, state: "PR", region: "Sul", city: "Cidade Ficticia", clientType: "PJ", segment: null, potentialHa: null, isArchived: false, archiveReason: null, lastPurchaseValue: 1000, financialProfile: null, partnerTitles: null, openTitlesTotal: 0, overdueTitlesTotal: 0, ownerSellerId: "seller-a", createdAt: daysAgo(2000) };
const overdueTitle = { DOCTO: "DOC-FICTICIO", PARCELA: 1, DATA_VENCIMENTO: dueDaysAgo(45), DSCRECEITA: "VENDAS", VALOR: 10, SALDO_CAPITAL: 10 };
const clients: Row[] = [
  // Inativo recente (última compra há 450 dias), com histórico: atividade, ganho antigo e notas na timeline.
  { ...baseClient, id: "c-inativo", name: "Cliente Ficticio Inativo", lastPurchaseDate: daysAgo(450) },
  // Inativo recente sem nenhum registro no CRM.
  { ...baseClient, id: "c-inativo-vazio", name: "Cliente Ficticio Inativo Vazio", lastPurchaseDate: daysAgo(450) },
  { ...baseClient, id: "c-prospect", name: "Cliente Ficticio Prospect", lastPurchaseDate: null },
  { ...baseClient, id: "c-cobranca", name: "Cliente Ficticio Cobranca", lastPurchaseDate: daysAgo(450), partnerTitles: [overdueTitle], openTitlesTotal: 10, overdueTitlesTotal: 10 },
  { ...baseClient, id: "c-insight", name: "Cliente Ficticio Insight", lastPurchaseDate: daysAgo(100) }
];
const baseOpportunity = { probability: 50, notes: null, crop: "soja", season: null, areaHa: null, productOffered: "Semente ficticia", expectedCloseDate: daysAgo(-10), proposalDate: daysAgo(20), createdAt: daysAgo(30), lastContactAt: daysAgo(5), plantingForecastDate: null, ownerSellerId: "seller-a", value: 5000 };
const opportunities: Row[] = [
  { ...baseOpportunity, id: "opp-ganha", clientId: "c-inativo", title: "Venda ficticia antiga", stage: "ganho", closedAt: daysAgo(450), followUpDate: daysAgo(460) },
  { ...baseOpportunity, id: "opp-insight", clientId: "c-insight", title: "Oportunidade ficticia insight", stage: "negociacao", closedAt: null, followUpDate: daysAgo(-5) }
];
const timeline: Row[] = [
  // Observação do vendedor: comentário ligado a uma oportunidade.
  { id: "ev-seller", type: "comentario", description: SELLER_NOTE, clientId: "c-inativo", opportunityId: "opp-ganha", ownerSellerId: "seller-a", createdAt: daysAgo(20) },
  // Registros de sistema mais novos: status sem oportunidade (sincronização) e comentário sem oportunidade (WhatsApp oficial).
  { id: "ev-system", type: "status", description: SYSTEM_NOTE, clientId: "c-inativo", opportunityId: null, ownerSellerId: "seller-a", createdAt: daysAgo(2) },
  { id: "ev-whatsapp", type: "comentario", description: WHATSAPP_NOTE, clientId: "c-inativo", opportunityId: null, ownerSellerId: "seller-a", createdAt: daysAgo(1) },
  // Oportunidade: comentário do vendedor e, depois, evento de sistema com texto que o parser leria como desinteresse.
  { id: "ev-insight-seller", type: "comentario", description: "Cliente ficticio pediu proposta com desconto", clientId: "c-insight", opportunityId: "opp-insight", ownerSellerId: "seller-a", createdAt: daysAgo(10) },
  { id: "ev-insight-system", type: "status", description: "Geracao de pedido ficticio falhou: encerrar fluxo tecnico", clientId: "c-insight", opportunityId: "opp-insight", ownerSellerId: "seller-a", createdAt: daysAgo(1) }
];
const activities: Row[] = [
  { id: "act-1", type: "ligacao", notes: "Ligacao ficticia de acompanhamento", description: null, result: null, done: true, date: daysAgo(60), dueDate: daysAgo(60), createdAt: daysAgo(60), clientId: "c-inativo", opportunityId: null, ownerSellerId: "seller-a" }
];

const clientOf = (row: Row) => clients.find((candidate) => candidate.id === row.clientId) ?? null;
const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  if ("not" in condition) return condition.not === null ? value !== null && value !== undefined : value !== condition.not;
  if (!(value instanceof Date)) return false;
  const time = value.getTime();
  if ("lt" in condition && !(time < condition.lt.getTime())) return false;
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
    return matchValue(row[key], condition);
  });
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((key) => !(select[key] && typeof select[key] === "object")).map((key) => [key, row[key]])) : { ...row });
const newestFirst = (rows: Row[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
const projectOpportunity = (row: Row, select?: Row) => ({
  ...pick(row, select),
  client: select?.client ? pick(clientOf(row)!, select.client.select) : undefined,
  timelineEvents: select?.timelineEvents
    ? newestFirst(timeline.filter((event) => event.opportunityId === row.id && matches(event, select.timelineEvents.where))).map((event) => pick(event, select.timelineEvents.select))
    : [],
  activities: select?.activities ? activities.filter((activity) => activity.opportunityId === row.id) : []
});
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
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", { findFirst: async ({ where, select }: any) => { const row = clients.find((candidate) => matches(candidate, where)); return row ? pick(row, select) : null; } });
setModel("opportunity", {
  count: async ({ where }: any) => opportunities.filter((row) => matches(row, where)).length,
  findFirst: async ({ where, select }: any) => { const row = opportunities.find((candidate) => matches(candidate, where)); return row ? projectOpportunity(row, select) : null; },
  findMany: async ({ where, select }: any) => opportunities.filter((row) => matches(row, where)).map((row) => pick(row, select))
});
setModel("activity", {
  findMany: async ({ where }: any) => activities.filter((row) => matches(row, where)).map((row) => ({ ...row, opportunity: null })),
  count: async ({ where }: any) => activities.filter((row) => matches(row, where)).length,
  aggregate: async ({ where }: any) => {
    const rows = activities.filter((row) => matches(row, where));
    return { _max: { date: rows[0]?.date ?? null, createdAt: rows[0]?.createdAt ?? null } };
  }
});
setModel("timelineEvent", { findFirst: async ({ where, select }: any) => { const row = newestFirst(timeline.filter((event) => matches(event, where)))[0]; return row ? pick(row, select) : null; } });
setModel("erpOrderSync", { findMany: async () => [], findFirst: async () => null });
setModel("knowledgeDocument", { findMany: async () => [], findFirst: async () => null });
const appConfig = new Map<string, string>();
setModel("appConfig", {
  findUnique: async ({ where }: any) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    appConfig.set(where.key, appConfig.has(where.key) ? update.value ?? appConfig.get(where.key) : create.value);
    return { key: where.key, value: appConfig.get(where.key) };
  }
});

const received: AiChatRequest[] = [];
const fakeProvider: AiProvider = {
  name: "fake-provider",
  model: "fake/model-free",
  mode: "fake",
  getStatus: () => ({ provider: "fake-provider", model: "fake/model-free", configured: true, mode: "fake" }),
  chat: async (request) => {
    received.push(request);
    const reply = JSON.stringify({ status: "parado", summary: "Resumo da IA ficticia", recommendation: "Reativar o cliente", nextAction: "Ligar hoje", riskLevel: "medio" });
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
const call = async (method: string, path: string, body?: unknown) => {
  const token = signAccessToken({ id: "seller-a", email: "seller-a@test.invalid", role: "vendedor" });
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

try {
  // Critério estrutural: só comentário ligado a oportunidade é observação do vendedor.
  assert.equal(isSellerObservationEvent({ type: "comentario", opportunityId: "opp-x" }), true);
  assert.equal(isSellerObservationEvent({ type: "comentario", opportunityId: null }), false, "WhatsApp oficial");
  assert.equal(isSellerObservationEvent({ type: "status", opportunityId: null }), false, "sincronização e saneamento");
  assert.equal(isSellerObservationEvent({ type: "status", opportunityId: "opp-x" }), false, "pedido ERP e criação de oportunidade");
  assert.equal(isSellerObservationEvent({ type: "mudanca_etapa", opportunityId: "opp-x" }), false);

  // Sugestão inteligente: a observação recente é a do vendedor, mesmo com registros de sistema mais novos.
  const suggestion = await call("POST", "/ai/client-suggestion", { clientId: "c-inativo" });
  assert.equal(suggestion.status, 200);
  assert.match(suggestion.json.summary, new RegExp(`Observação recente: ${SELLER_NOTE}\\.`));
  assert.doesNotMatch(suggestion.json.summary, new RegExp(`${SYSTEM_NOTE}|${WHATSAPP_NOTE}`));
  assert.equal(suggestion.json.recommendation, SUGGESTION_BY_APPROACH.reativacao.recommendation);

  // Com a IA ligada, o contexto enviado leva a observação do vendedor e nenhum registro de sistema.
  env.aiChatEnabled = true;
  received.length = 0;
  const aiSuggestion = await call("POST", "/ai/client-suggestion", { clientId: "c-inativo" });
  env.aiChatEnabled = false;
  assert.equal(aiSuggestion.json.source, "ai");
  const prompt = received.map((request) => request.messages.map((message) => message.content).join("\n")).join("\n");
  assert.match(prompt, new RegExp(`"observacaoRecente":"${SELLER_NOTE}"`));
  assert.doesNotMatch(prompt, new RegExp(`${SYSTEM_NOTE}|${WHATSAPP_NOTE}`));

  // Insight da oportunidade: o evento de sistema mais novo ("encerrar") não vira desinteresse; vale o comentário.
  const insight = await call("POST", "/ai/opportunity-insight", { opportunityId: "opp-insight" });
  assert.equal(insight.status, 200);
  assert.notEqual(insight.json.observationInsight.detectedIntent, "sem_interesse");
  assert(insight.json.observationInsight.keywords.includes("proposta"), "lê o comentário do vendedor");

  // Resumo automático: momento e abordagem pela situação oficial da carteira.
  const reactivation = SUGGESTION_BY_APPROACH.reativacao.recommendation;
  const summaryInactive = await call("GET", "/ai/client-summary/c-inativo");
  assert.equal(summaryInactive.status, 200);
  assert.equal(summaryInactive.json.currentMoment, "Inativo recente");
  assert.equal(summaryInactive.json.recommendedApproach, reactivation);
  assert.match(summaryInactive.json.summary, /Situação da carteira: Inativo recente\./);
  assert.doesNotMatch(JSON.stringify(summaryInactive.json), /reativar relacionamento com nova oportunidade consultiva/);

  const summaryEmpty = await call("GET", "/ai/client-summary/c-inativo-vazio");
  assert.equal(summaryEmpty.json.currentMoment, "Inativo recente");
  assert.equal(summaryEmpty.json.recommendedApproach, reactivation);
  assert.doesNotMatch(JSON.stringify(summaryEmpty.json), /descoberta|sem histórico recente/i);
  assert(summaryEmpty.json.lastRelevantSignals.some((signal: string) => /Situação da carteira: Inativo recente\. Última compra em/.test(signal)));

  const summaryProspect = await call("GET", "/ai/client-summary/c-prospect");
  assert.equal(summaryProspect.json.currentMoment, "Prospect");
  assert.equal(summaryProspect.json.recommendedApproach, SUGGESTION_BY_APPROACH.primeiraVenda.recommendation);
  assert.match(summaryProspect.json.recommendedApproach, /primeira venda/);

  const summaryCollection = await call("GET", "/ai/client-summary/c-cobranca");
  assert.equal(summaryCollection.json.currentMoment, "Cliente em cobrança");
  assert.equal(summaryCollection.json.recommendedApproach, CLIENT_IN_COLLECTION_RECOMMENDATION);
  assert.doesNotMatch(JSON.stringify(summaryCollection.json), /Reativar|primeira venda/);

  console.info = originalInfo;
  console.log("CLIENT_SYSTEM_NOTES=PASS criterion=PASS suggestion=PASS ai_context=PASS opportunity_insight=PASS summary_reactivation=PASS summary_first_sale=PASS summary_collection=PASS");
} finally {
  console.info = originalInfo;
  server.close();
}
