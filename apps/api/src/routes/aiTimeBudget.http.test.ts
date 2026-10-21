import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { AiUsageLimiter } from "../services/ai/aiUsageLimiter.js";
import { AI_BUDGET_RESPONSE_MARGIN_MS, AI_FLOW_BUDGET_MS, AI_TIMEOUT_BUDGET_REASON, type AiFlow } from "../services/ai/aiTimeBudget.js";
import { OpenAICompatibleProvider } from "../services/ai/openAiCompatibleProvider.js";
import { invalidateCommercialInsightsCache } from "../services/commercialInsightsService.js";
import { __timelineIntelligenceCache } from "../services/timelineIntelligenceService.js";
import { signAccessToken } from "../utils/jwt.js";

// Orçamento de tempo de IA por fluxo, com provedor falso lento (fetch simulado, nada sai da máquina) e dados
// fictícios: a rota responde 200 com o fallback antes do timeout da tela.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "seller-a", role: "vendedor" }
];
const clients: Row[] = [{
  id: "cliente-a", tenantId: "tenant-a", name: "Cliente Ficticio A", fantasyName: null, city: "Cidade Ficticia", state: "PR", region: "Sul",
  ownerSellerId: "seller-a", isArchived: false, archiveReason: null, potentialHa: 100, lastPurchaseDate: daysAgo(450), lastPurchaseValue: 1000,
  financialProfile: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: daysAgo(2000)
}];
const opportunities: Row[] = [{
  id: "opp-a", clientId: "cliente-a", title: "Oportunidade ficticia A", value: 1000, probability: 50, stage: "negociacao", ownerSellerId: "seller-a",
  notes: "Retorno combinado", crop: "soja", productOffered: "Semente ficticia", followUpDate: daysAgo(3), expectedCloseDate: daysAgo(-10),
  proposalDate: null, lastContactAt: daysAgo(5), closedAt: null, createdAt: daysAgo(20)
}];
const activities: Row[] = [{
  id: "act-a", clientId: "cliente-a", opportunityId: null, ownerSellerId: "seller-a", type: "ligacao", done: true, dueDate: daysAgo(10),
  date: daysAgo(10), createdAt: daysAgo(10), product: null, result: null, notes: "Conversa ficticia", description: "Ligação ficticia"
}];

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
  if ("gte" in condition && !(time >= condition.gte.getTime())) return false;
  return true;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
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
  items: [],
  activities: activities.filter((activity) => activity.clientId === row.clientId).map((activity) => pick(activity, select?.activities?.select))
});
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (!where?.role || row.role === where.role));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  },
  findUnique: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, name: user.id, role: user.role, isActive: true } : null;
  },
  findMany: async () => [{ id: "seller-a", name: "Vendedor Ficticio", region: "Sul", _count: { opportunities: 1, activities: 1, clients: 1 } }]
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => {
    const row = clients.find((candidate) => matches(candidate, where));
    return row ? pick(row, select) : null;
  },
  findMany: async ({ where, select }: any) => clients.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), activities: [], timelineEvents: [] }))
});
setModel("opportunity", {
  count: async ({ where }: any) => opportunities.filter((row) => matches(row, where)).length,
  aggregate: async ({ where }: any) => {
    const rows = opportunities.filter((row) => matches(row, where));
    return { _sum: { value: rows.reduce((sum, row) => sum + row.value, 0) }, _count: rows.length };
  },
  findFirst: async ({ where, select }: any) => {
    const row = opportunities.find((candidate) => matches(candidate, where));
    return row ? projectOpportunity(row, select) : null;
  },
  findMany: async ({ where, select }: any) => opportunities.filter((row) => matches(row, where)).map((row) => projectOpportunity(row, select))
});
setModel("activity", {
  count: async ({ where }: any) => activities.filter((row) => matches(row, where)).length,
  aggregate: async () => ({ _max: { date: activities[0].date, createdAt: activities[0].createdAt } }),
  findMany: async ({ where, select }: any) => activities.filter((row) => matches(row, where)).map((row) => ({ ...pick(row, select), opportunity: null }))
});
setModel("timelineEvent", { findFirst: async () => null, findMany: async () => [] });
setModel("opportunityChangeLog", { findMany: async () => [] });
setModel("erpOrderSync", { findMany: async () => [], findFirst: async () => null });
setModel("product", { findMany: async () => [] });
setModel("opportunityItem", { findMany: async () => [] });
setModel("knowledgeDocument", { findMany: async () => [], findFirst: async () => null });
setModel("appConfig", { findUnique: async () => null });

// Provedor falso no formato do OpenRouter: cabeçalhos na hora e corpo depois de bodyDelayMs, como o provedor real
// faz com o modelo lento. O corpo respeita o AbortSignal da chamada.
const PROVIDER_URL = "https://provedor-ficticio.test/api/v1";
const originalFetch = globalThis.fetch;
const providerCalls: Row[] = [];
let bodyDelayMs = 0;
let replyOverride: Row | null = null;
const replyFor = (body: Row) => {
  if (replyOverride) return replyOverride;
  const text = (body.messages as Row[]).map((message) => message.content).join("\n");
  const content = text.includes("Classifique perguntas CRM")
    ? JSON.stringify({ capability: "overdue_followups" })
    : text.includes("Gere uma sugestão")
      ? JSON.stringify({ status: "parado", summary: "Resumo ficticio da IA", recommendation: "Reativar", nextAction: "Ligar hoje", riskLevel: "alto" })
      : JSON.stringify({ message: "Bom dia! Mensagem ficticia da IA." });
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { total_tokens: 30 } };
};
globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
  if (!String(input).startsWith(PROVIDER_URL)) return originalFetch(input, init);
  const body = JSON.parse(String(init?.body));
  providerCalls.push(body);
  const signal = init?.signal ?? undefined;
  const payload = new TextEncoder().encode(JSON.stringify(replyFor(body)));
  const stream = new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => { controller.enqueue(payload); controller.close(); }, bodyDelayMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

(aiService as any).provider = new OpenAICompatibleProvider({
  providerName: "openrouter", baseUrl: PROVIDER_URL, apiKey: "chave-ficticia", model: "fornecedor/modelo-ficticio:free",
  timeoutMs: 30_000, defaultTemperature: 0.2, defaultMaxTokens: 512
});
(aiService as any).usageLimiter = new AiUsageLimiter(async () => 1_000);
env.aiChatEnabled = true;
env.aiTimeoutMs = 30_000;

// Orçamento curto para o teste não esperar 12 s por rota; o provedor lento demora bem mais que ele.
// Timeout da tela para as rotas de IA, lido do código da web (o build da API não compila arquivos de fora).
const webAiTimeout = readFileSync(new URL("../../../web/src/lib/aiRequest.ts", import.meta.url), "utf8").match(/AI_REQUEST_TIMEOUT_MS = ([\d_]+)/)?.[1];
assert(webAiTimeout, "AI_REQUEST_TIMEOUT_MS na web");
const AI_REQUEST_TIMEOUT_MS = Number(webAiTimeout.replace(/_/g, ""));
const REAL_MAX_BUDGET_MS = Math.max(...Object.values(AI_FLOW_BUDGET_MS));
// Acima do mínimo por chamada (AI_MIN_CALL_MS), para a chamada lenta começar e ser cortada pelo orçamento.
const TEST_BUDGET_MS = 2_500;
const SLOW_BODY_MS = 8_000;
for (const flow of Object.keys(AI_FLOW_BUDGET_MS) as AiFlow[]) AI_FLOW_BUDGET_MS[flow] = TEST_BUDGET_MS;

// Logs capturados: só os de fluxo, para conferir fluxo, tempo, fonte e motivo, sem conteúdo.
const logged: Row[] = [];
const originalInfo = console.info;
console.info = (payload: unknown) => { if (payload && typeof payload === "object") logged.push(payload as Row); };
const flowLogs = (flow: AiFlow) => logged.filter((entry) => entry.message === "[AI] flow-completed" && entry.meta?.flow === flow).map((entry) => entry.meta);

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const startedAt = Date.now();
  const response = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any, elapsedMs: Date.now() - startedAt };
};

const results: string[] = [];
try {
  // 0. A tela espera mais que o orçamento real de qualquer fluxo, com a folga de resposta.
  assert(AI_REQUEST_TIMEOUT_MS > REAL_MAX_BUDGET_MS + AI_BUDGET_RESPONSE_MARGIN_MS, "timeout da tela acima do orçamento com folga");
  results.push("web_timeout_above_budget=PASS");

  // 1. Provedor mais lento que o orçamento: 200 com fallback, perto do orçamento e longe do timeout da tela.
  bodyDelayMs = SLOW_BODY_MS;
  const slowRoutes: Array<{ flow: AiFlow; method: string; path: string; userId: string; body?: unknown }> = [
    { flow: "client-suggestion", method: "POST", path: "/ai/client-suggestion", userId: "seller-a", body: { clientId: "cliente-a" } },
    { flow: "opportunity-message", method: "GET", path: "/ai/opportunity-message?opportunityId=opp-a", userId: "seller-a" },
    { flow: "assistant-whatsapp", method: "POST", path: "/ai/assistant-whatsapp-message", userId: "seller-a", body: { clientId: "cliente-a" } },
    { flow: "timeline-intelligence", method: "GET", path: "/ai/timeline-intelligence/client/cliente-a?refresh=true", userId: "seller-a" },
    { flow: "commercial-insights", method: "GET", path: "/ai/commercial-insights?refresh=true", userId: "director-a" },
    { flow: "crm-assistant", method: "POST", path: "/ai/crm-assistant/query", userId: "seller-a", body: { question: "follow-ups vencidos", refresh: true } }
  ];
  for (const route of slowRoutes) {
    const response = await call(route.method, route.path, route.userId, route.body);
    assert.equal(response.status, 200, `${route.flow}: 200`);
    assert.equal(response.json.source, "deterministic", `${route.flow}: fallback determinístico`);
    assert(response.elapsedMs < TEST_BUDGET_MS + 1_500, `${route.flow}: respondeu em ${response.elapsedMs} ms, perto do orçamento`);
    assert(response.elapsedMs < SLOW_BODY_MS, `${route.flow}: não esperou o provedor`);
    const flowLog = flowLogs(route.flow).at(-1);
    assert(flowLog, `${route.flow}: log do fluxo`);
    assert.equal(flowLog.source, "deterministic");
    assert.equal(flowLog.fallbackReason, AI_TIMEOUT_BUDGET_REASON, `${route.flow}: motivo ai_timeout_budget`);
    assert.equal(typeof flowLog.elapsedMs, "number");
  }
  // O Assistente gastou o orçamento na resposta (a pergunta foi resolvida sem IA): uma única chamada ao provedor.
  assert.equal(flowLogs("crm-assistant").at(-1).aiCalls, 1);
  // Pergunta que precisa da IA para classificar: a classificação gasta o orçamento e a resposta não é chamada.
  const bothCalls = await call("POST", "/ai/crm-assistant/query", "seller-a", { question: "o que merece atenção agora?", refresh: true });
  assert.equal(bothCalls.status, 200);
  assert.equal(bothCalls.json.source, "deterministic");
  assert(bothCalls.elapsedMs < TEST_BUDGET_MS + 1_500, `duas chamadas cabem no orçamento: ${bothCalls.elapsedMs} ms`);
  assert.equal(flowLogs("crm-assistant").at(-1).aiCalls, 1, "a segunda chamada não começa sem orçamento");
  assert(logged.some((entry) => entry.message === "[AI] budget-exhausted" && entry.meta?.flow === "crm-assistant"));
  assert(!JSON.stringify(logged).includes("Cliente Ficticio A"), "logs sem conteúdo");
  assert(!JSON.stringify(logged).includes("follow-ups vencidos"), "logs sem a pergunta");
  results.push("slow_provider_budget_fallback=PASS");

  // 2. Assistente: pergunta resolvida pela classificação determinística não chama a IA para classificar.
  bodyDelayMs = 0;
  providerCalls.length = 0;
  const resolved = await call("POST", "/ai/crm-assistant/query", "seller-a", { question: "follow-ups vencidos", refresh: true });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.source, "ai", "resposta reescrita pela IA");
  const classifyCalls = () => providerCalls.filter((body) => (body.messages as Row[]).some((message) => String(message.content).includes("Classifique perguntas CRM")));
  assert.equal(classifyCalls().length, 0, "nenhuma chamada de classificação");
  assert.equal(providerCalls.length, 1, "só a chamada da resposta");
  // Pergunta que a classificação determinística não resolve: aí sim a IA classifica.
  providerCalls.length = 0;
  const unresolved = await call("POST", "/ai/crm-assistant/query", "seller-a", { question: "o que merece atenção agora?", refresh: true });
  assert.equal(unresolved.status, 200);
  assert.equal(classifyCalls().length, 1, "pergunta não resolvida vai para a IA");
  results.push("crm_assistant_deterministic_first=PASS");

  // 3. Mensagem comercial devolve a fonte.
  const aiMessage = await call("GET", "/ai/opportunity-message?opportunityId=opp-a", "seller-a");
  assert.equal(aiMessage.status, 200);
  assert.equal(aiMessage.json.source, "ai");
  assert.equal(aiMessage.json.message, "Bom dia! Mensagem ficticia da IA.");
  env.aiChatEnabled = false;
  const systemMessage = await call("GET", "/ai/opportunity-message?opportunityId=opp-a", "seller-a");
  assert.equal(systemMessage.json.source, "deterministic");
  assert(systemMessage.json.message.length > 0);
  env.aiChatEnabled = true;
  results.push("opportunity_message_source=PASS");

  // 4. Erro no corpo com status 200 e resposta vazia sem finish_reason: fallback, nunca erro na tela.
  replyOverride = { error: { code: 502, message: "erro ficticio do provedor" } };
  __timelineIntelligenceCache.clear();
  const bodyError = await call("GET", "/ai/timeline-intelligence/client/cliente-a?refresh=true", "seller-a");
  assert.equal(bodyError.status, 200);
  assert.equal(bodyError.json.source, "deterministic");
  assert.equal(flowLogs("timeline-intelligence").at(-1).fallbackReason, "provider_body_error");
  replyOverride = { choices: [{ message: { role: "assistant", content: "" }, finish_reason: null }] };
  const emptyReply = await call("GET", "/ai/opportunity-message?opportunityId=opp-a", "seller-a");
  assert.equal(emptyReply.status, 200);
  assert.equal(emptyReply.json.source, "deterministic");
  assert.equal(flowLogs("opportunity-message").at(-1).fallbackReason, "ai_empty_response");
  replyOverride = null;
  results.push("provider_body_error_and_empty_fallback=PASS");

  // 5. Tempo da chamada inclui a leitura do corpo (antes só contava até os cabeçalhos).
  bodyDelayMs = 250;
  const timed = await (aiService as any).provider.chat({ messages: [{ role: "user", content: "pedido ficticio" }] });
  assert(timed.elapsedMs >= 240, `elapsedMs ${timed.elapsedMs} inclui o corpo`);
  assert(timed.headersMs < timed.elapsedMs, "headersMs separado");
  bodyDelayMs = 0;
  results.push("elapsed_includes_body=PASS");

  // 6. Cache da IA Comercial: a segunda abertura não chama o provedor de novo.
  invalidateCommercialInsightsCache();
  providerCalls.length = 0;
  await call("GET", "/ai/commercial-insights", "director-a");
  const cached = await call("GET", "/ai/commercial-insights", "director-a");
  assert.equal(cached.json.cacheHit, true);
  assert.equal(providerCalls.length, 1);
  results.push("commercial_insights_cache=PASS");

  console.log(`AI_TIME_BUDGET=PASS ${results.join(" ")}`);
} finally {
  console.info = originalInfo;
  globalThis.fetch = originalFetch;
  server.close();
}
