import { OpportunityStage } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { aiService, type AiService } from "./ai/aiService.js";
import { DEMETRA_MASTER_PROMPT } from "./ai/demetraMasterPrompt.js";
import { resolveKnowledgeContextForAi } from "./knowledgeBaseService.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NO_LIMIT = 5;
const HIGH_VALUE_THRESHOLD = 50_000;
const FORGOTTEN_CLIENT_DAYS = 30;
const NO_PURCHASE_DAYS = 180;
const OPEN_STAGES: OpportunityStage[] = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta];

type PriorityItem = { title: string; detail: string; count?: number };
export type CommercialInsightsPayload = {
  summary: string;
  highPriority: PriorityItem[];
  mediumPriority: PriorityItem[];
  lowPriority: PriorityItem[];
  recommendations: string[];
  nextActions: string[];
  risks: string[];
  highlights: string[];
  generatedAt: string;
  expiresAt: string;
  source: "ai" | "deterministic";
  cacheHit: boolean;
  metrics: { clients: number; opportunities: number; indicators: number };
};

type CacheEntry = Omit<CommercialInsightsPayload, "cacheHit"> & { expiresAtMs: number };
let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const tomorrowStart = () => { const d = todayStart(); d.setDate(d.getDate() + 1); return d; };
const nextDays = (days: number) => { const d = todayStart(); d.setDate(d.getDate() + days); return d; };
const compactName = (value: string | null | undefined) => (value || "Não informado").slice(0, 90);

const parseAiPayload = (content: string): Omit<CommercialInsightsPayload, "generatedAt" | "expiresAt" | "source" | "cacheHit" | "metrics"> | null => {
  try {
    const parsed = JSON.parse(content.trim());
    if (!parsed || typeof parsed !== "object") return null;
    return {
      summary: String(parsed.summary || "Não há informações suficientes para gerar resumo."),
      highPriority: Array.isArray(parsed.highPriority) ? parsed.highPriority.slice(0, 8) : [],
      mediumPriority: Array.isArray(parsed.mediumPriority) ? parsed.mediumPriority.slice(0, 8) : [],
      lowPriority: Array.isArray(parsed.lowPriority) ? parsed.lowPriority.slice(0, 8) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String).slice(0, 8) : [],
      nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map(String).slice(0, 8) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 8) : [],
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String).slice(0, 8) : []
    };
  } catch {
    return null;
  }
};

const deterministicSummary = (indicators: PriorityItem[], stats: any) => ({
  summary: `Resumo Comercial do Dia: ${stats.clients.total} clientes ativos na base, ${stats.opportunities.open} oportunidades abertas, ${stats.opportunities.overdue} atrasadas e ${stats.opportunities.followUpOverdue} follow-ups vencidos.`,
  highPriority: indicators.slice(0, 6),
  mediumPriority: indicators.slice(6, 12),
  lowPriority: indicators.slice(12, 18),
  recommendations: ["Priorizar clientes sem contato recente e oportunidades de maior valor.", "Reequilibrar carteiras com excesso de follow-ups vencidos.", "Cobrar atualização das atividades sem responsável ou vencidas."],
  nextActions: ["Revisar a lista de follow-ups vencidos hoje.", "Definir responsáveis para atividades sem dono.", "Agendar contato com clientes críticos."],
  risks: indicators.filter((item) => /vencid|crític|parad|sem contato/i.test(`${item.title} ${item.detail}`)).map((item) => item.title).slice(0, 6),
  highlights: [
    `${stats.opportunities.highValue} oportunidade(s) acima de R$ ${HIGH_VALUE_THRESHOLD.toLocaleString("pt-BR")}.`,
    `${stats.clients.noRecentContact} cliente(s) sem contato há mais de ${FORGOTTEN_CLIENT_DAYS} dias.`
  ]
});

const collectDeterministicContext = async () => {
  const [clients, opportunities, activities, sellers, products, items] = await Promise.all([
    prisma.client.findMany({ where: { isArchived: false }, select: { id: true, name: true, region: true, city: true, state: true, ownerSellerId: true, createdAt: true, lastPurchaseDate: true, openTitlesTotal: true, overdueTitlesTotal: true, timelineEvents: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } } }),
    prisma.opportunity.findMany({ select: { id: true, title: true, value: true, stage: true, followUpDate: true, expectedCloseDate: true, lastContactAt: true, ownerSellerId: true, client: { select: { name: true, region: true } }, items: { take: 3, select: { productNameSnapshot: true, netTotal: true } } } }),
    prisma.activity.findMany({ select: { id: true, dueDate: true, done: true, ownerSellerId: true, clientId: true, product: true } }),
    prisma.user.findMany({ where: { role: "vendedor", isActive: true }, select: { id: true, name: true, region: true } }),
    prisma.product.findMany({ select: { id: true, name: true, isActive: true } }),
    prisma.opportunityItem.findMany({ select: { productNameSnapshot: true, netTotal: true, createdAt: true, opportunity: { select: { stage: true } } } })
  ]);
  const openOpps = opportunities.filter((o) => OPEN_STAGES.includes(o.stage));
  const wonOpps = opportunities.filter((o) => o.stage === OpportunityStage.ganho);
  const lostOpps = opportunities.filter((o) => o.stage === OpportunityStage.perdido);
  const overdueOpps = openOpps.filter((o) => o.expectedCloseDate < todayStart());
  const followUpOverdue = openOpps.filter((o) => o.followUpDate < todayStart());
  const highValue = openOpps.filter((o) => o.value >= HIGH_VALUE_THRESHOLD);
  const noPurchase = clients.filter((c) => !c.lastPurchaseDate || c.lastPurchaseDate < daysAgo(NO_PURCHASE_DAYS));
  const noRecentContact = clients.filter((c) => !c.timelineEvents[0]?.createdAt || c.timelineEvents[0].createdAt < daysAgo(FORGOTTEN_CLIENT_DAYS));
  const criticalClients = clients.filter((c) => (c.overdueTitlesTotal ?? 0) > 0 || noRecentContact.some((x) => x.id === c.id));
  const stats = {
    clients: { total: clients.length, new: clients.filter((c) => c.createdAt >= daysAgo(30)).length, active: clients.filter((c) => c.lastPurchaseDate && c.lastPurchaseDate >= daysAgo(365)).length, inactive: clients.filter((c) => !c.lastPurchaseDate || c.lastPurchaseDate < daysAgo(365)).length, noPurchase: noPurchase.length, noActivity: clients.filter((c) => !c.timelineEvents[0]).length, noRecentContact: noRecentContact.length, critical: criticalClients.length },
    opportunities: { open: openOpps.length, won: wonOpps.length, lost: lostOpps.length, overdue: overdueOpps.length, followUpOverdue: followUpOverdue.length, totalValue: openOpps.reduce((s, o) => s + o.value, 0), averageTicket: openOpps.length ? openOpps.reduce((s, o) => s + o.value, 0) / openOpps.length : 0, highValue: highValue.length },
    activities: { overdue: activities.filter((a) => !a.done && a.dueDate < todayStart()).length, today: activities.filter((a) => !a.done && a.dueDate >= todayStart() && a.dueDate < tomorrowStart()).length, next: activities.filter((a) => !a.done && a.dueDate >= tomorrowStart() && a.dueDate < nextDays(7)).length, withoutOwner: activities.filter((a) => !a.ownerSellerId).length }
  };
  const sellerSummaries = sellers.map((seller) => ({
    seller: seller.name,
    clients: clients.filter((c) => c.ownerSellerId === seller.id).length,
    opportunities: openOpps.filter((o) => o.ownerSellerId === seller.id).length,
    openValue: openOpps.filter((o) => o.ownerSellerId === seller.id).reduce((s, o) => s + o.value, 0),
    pendingActivities: activities.filter((a) => a.ownerSellerId === seller.id && !a.done).length,
    overdueFollowUps: followUpOverdue.filter((o) => o.ownerSellerId === seller.id).length,
    criticalOpportunities: openOpps.filter((o) => o.ownerSellerId === seller.id && (o.expectedCloseDate < todayStart() || o.value >= HIGH_VALUE_THRESHOLD)).length
  }));
  const territories = Array.from(new Set(clients.map((c) => c.region))).map((region) => ({ region, clients: clients.filter((c) => c.region === region).length, opportunities: openOpps.filter((o) => o.client.region === region).length, value: openOpps.filter((o) => o.client.region === region).reduce((s, o) => s + o.value, 0), withoutActivity: clients.filter((c) => c.region === region && !c.timelineEvents[0]).length }));
  const soldProducts = items.filter((i) => i.opportunity.stage === OpportunityStage.ganho).reduce<Record<string, number>>((acc, item) => { acc[item.productNameSnapshot] = (acc[item.productNameSnapshot] || 0) + item.netTotal; return acc; }, {});
  const productSummary = { topSold: Object.entries(soldProducts).sort((a, b) => b[1] - a[1]).slice(0, NO_LIMIT).map(([name, value]) => ({ name, value })), withoutSales: products.filter((p) => p.isActive && !soldProducts[p.name]).slice(0, NO_LIMIT).map((p) => p.name) };
  const indicators: PriorityItem[] = [
    { title: "Clientes esquecidos", detail: `${noRecentContact.length} cliente(s) sem contato há mais de ${FORGOTTEN_CLIENT_DAYS} dias.`, count: noRecentContact.length },
    { title: "Follow-ups vencidos", detail: `${followUpOverdue.length} oportunidade(s) com follow-up vencido.`, count: followUpOverdue.length },
    { title: "Grandes oportunidades paradas", detail: `${highValue.length} oportunidade(s) abertas acima de R$ ${HIGH_VALUE_THRESHOLD.toLocaleString("pt-BR")}.`, count: highValue.length },
    { title: "Clientes críticos", detail: `${criticalClients.length} cliente(s) com risco comercial ou financeiro.`, count: criticalClients.length },
    ...sellerSummaries.filter((s) => s.overdueFollowUps > 0).slice(0, NO_LIMIT).map((s) => ({ title: `Follow-up vencido - ${s.seller}`, detail: `${s.overdueFollowUps} follow-up(s) vencido(s).`, count: s.overdueFollowUps })),
    ...territories.filter((t) => t.withoutActivity > 0).slice(0, NO_LIMIT).map((t) => ({ title: `Região sem atividade - ${t.region}`, detail: `${t.withoutActivity} cliente(s) sem atividade registrada.`, count: t.withoutActivity }))
  ].filter((i) => (i.count ?? 1) > 0);
  const lists = { clients: { noRecentContact: noRecentContact.slice(0, NO_LIMIT).map((c) => compactName(c.name)), critical: criticalClients.slice(0, NO_LIMIT).map((c) => compactName(c.name)) }, opportunities: { highValue: highValue.slice(0, NO_LIMIT).map((o) => ({ title: compactName(o.title), client: compactName(o.client.name), value: o.value })), overdue: overdueOpps.slice(0, NO_LIMIT).map((o) => compactName(o.title)) }, sellers: sellerSummaries, territories, products: productSummary };
  return { stats, indicators, lists, query: `territórios: ${territories.map((t) => t.region).join(", ")}; produtos: ${productSummary.topSold.map((p) => p.name).join(", ")}; vendedores: ${sellers.map((s) => s.name).join(", ")}; campanhas/safra: oportunidades abertas ${openOpps.length}.`, metrics: { clients: clients.length, opportunities: opportunities.length, indicators: indicators.length } };
};

const buildFreshInsights = async (service: AiService = aiService): Promise<CacheEntry> => {
  const startedAt = Date.now();
  let usedKnowledge = false;
  let usedAi = false;
  let fallback = false;
  const context = await collectDeterministicContext();
  const knowledge = await resolveKnowledgeContextForAi(context.query);
  usedKnowledge = Boolean(knowledge.context);
  const fallbackPayload = deterministicSummary(context.indicators, context.stats);
  let payload = fallbackPayload;
  const result = await service.chat({
    system: DEMETRA_MASTER_PROMPT,
    messages: [{ role: "user", content: `Analise os indicadores abaixo e produza um resumo executivo comercial.\n\nNão invente números.\nNão invente clientes.\nUtilize apenas os dados enviados.\nCaso faltem dados, informe que não há informações suficientes.\n\nRetorne somente JSON válido com as chaves: summary, highPriority, mediumPriority, lowPriority, recommendations, nextActions, risks, highlights.\n\nContexto da base de conhecimento:\n${knowledge.context || "Sem contexto adicional."}\n\nDados determinísticos resumidos:\n${JSON.stringify({ estatisticas: context.stats, indicadores: context.indicators, listas: context.lists })}` }],
    temperature: 0.2,
    maxTokens: 1200
  });
  usedAi = Boolean(result);
  const parsed = result ? parseAiPayload(result.content) : null;
  if (parsed) payload = parsed; else fallback = true;
  const generatedAt = new Date();
  const expiresAtMs = generatedAt.getTime() + CACHE_TTL_MS;
  const entry: CacheEntry = { ...payload, generatedAt: generatedAt.toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs, source: fallback ? "deterministic" : "ai", metrics: context.metrics };
  logApiEvent("INFO", "[ai/commercial-insights] generated", { elapsedMs: Date.now() - startedAt, cacheHit: false, clients: context.metrics.clients, opportunities: context.metrics.opportunities, indicators: context.metrics.indicators, knowledgeBase: usedKnowledge, ai: usedAi, fallback });
  return entry;
};

export const invalidateCommercialInsightsCache = () => { cache = null; };

export const getCommercialInsights = async (options: { refresh?: boolean } = {}) => {
  const startedAt = Date.now();
  if (!options.refresh && cache && cache.expiresAtMs > Date.now()) {
    logApiEvent("INFO", "[ai/commercial-insights] cache-hit", { elapsedMs: Date.now() - startedAt, cacheHit: true, clients: cache.metrics.clients, opportunities: cache.metrics.opportunities, indicators: cache.metrics.indicators, knowledgeBase: false, ai: false, fallback: cache.source === "deterministic" });
    return { ...cache, cacheHit: true };
  }
  if (!inFlight) inFlight = buildFreshInsights().finally(() => { inFlight = null; });
  cache = await inFlight;
  return { ...cache, cacheHit: false };
};
