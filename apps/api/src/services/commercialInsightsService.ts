import { OpportunityStage } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { aiService, type AiService } from "./ai/aiService.js";
import { DEMETRA_MASTER_PROMPT } from "./ai/demetraMasterPrompt.js";
import { resolveKnowledgeContextForAi } from "./knowledgeBaseService.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { calculateCommercialPriority, type CommercialPriorityInput, type CommercialPriorityLevel } from "./commercialPriorityService.js";

// Cache atual: entrada única em memória para /ai/commercial-insights por 6h.
// Limitação conhecida: como ainda não há chave por empresa/tenant/escopo, uma arquitetura SaaS multiempresa
// deve trocar esta chave global por uma chave composta antes de habilitar múltiplas empresas no mesmo processo.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NO_LIMIT = 5;
const AI_PRIORITY_LIMIT = 12;
const EXECUTIVE_VISIBLE_PRIORITY_LIMIT = 3;
const OPEN_STAGES: OpportunityStage[] = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta];

type PriorityItem = { title: string; detail: string; count?: number; score?: number; level?: CommercialPriorityLevel };
type ExecutivePriority = {
  entityType: "client" | "opportunity" | "seller" | "territory";
  entityId: string;
  title: string;
  score: number;
  level: CommercialPriorityLevel;
  reason: string;
  recommendedAction: string;
};
export type CommercialInsightsPayload = {
  summary: string;
  priorities: ExecutivePriority[];
  highPriority: PriorityItem[];
  mediumPriority: PriorityItem[];
  lowPriority: PriorityItem[];
  recommendations: string[];
  managementRecommendations: string[];
  nextActions: string[];
  risks: string[];
  opportunities: string[];
  highlights: string[];
  generatedAt: string;
  expiresAt: string;
  source: "ai" | "deterministic";
  cacheHit: boolean;
  metrics: { clients: number; opportunities: number; indicators: number; priorities: number; scoreMin: number; scoreMax: number };
};

type CacheEntry = Omit<CommercialInsightsPayload, "cacheHit"> & { expiresAtMs: number };
let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const compactName = (value: string | null | undefined) => (value || "Não informado").slice(0, 90);
const formatCurrency = (value?: number | null) => value ? value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) : "valor não informado";
const firstReason = (reasons: string[]) => reasons[0] || "Prioridade comercial calculada pelo score oficial";
const isGenericText = (text: string) => /^(acompanhar indicadores|melhorar vendas|realizar contatos|indicador)$/i.test(text.trim());

const sanitizeExecutivePriority = (item: unknown): ExecutivePriority | null => {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const entityType = String(raw.entityType || "");
  if (!["client", "opportunity", "seller", "territory"].includes(entityType)) return null;
  const score = Number(raw.score);
  const level = String(raw.level || "normal") as CommercialPriorityLevel;
  return {
    entityType: entityType as ExecutivePriority["entityType"],
    entityId: String(raw.entityId || ""),
    title: String(raw.title || "Prioridade comercial").slice(0, 140),
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    level: ["baixa", "normal", "alta", "urgente"].includes(level) ? level : "normal",
    reason: String(raw.reason || "Prioridade calculada pelo score oficial").slice(0, 240),
    recommendedAction: String(raw.recommendedAction || "Usar próxima ação oficial da prioridade").slice(0, 260)
  };
};

const parseAiPayload = (content: string, officialPriorities: ExecutivePriority[]): Partial<Pick<CommercialInsightsPayload, "summary" | "priorities" | "risks" | "opportunities" | "managementRecommendations" | "nextActions" | "recommendations" | "highlights">> | null => {
  try {
    const parsed = parseAiJsonObject(content)?.parsed;
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Record<string, unknown>;
    const aiPriorities = Array.isArray(payload.priorities) ? payload.priorities.map(sanitizeExecutivePriority).filter((p): p is ExecutivePriority => Boolean(p)) : [];
    const officialById = new Map(officialPriorities.map((p) => [`${p.entityType}:${p.entityId}`, p]));
    const priorities = (aiPriorities.length ? aiPriorities : officialPriorities).map((p) => {
      const official = officialById.get(`${p.entityType}:${p.entityId}`);
      return official ? { ...p, score: official.score, level: official.level, reason: official.reason, recommendedAction: official.recommendedAction } : p;
    }).sort((a, b) => b.score - a.score).slice(0, AI_PRIORITY_LIMIT);
    const readList = (key: string) => Array.isArray(payload[key]) ? (payload[key] as unknown[]).map(String).filter((v) => v && !isGenericText(v)).slice(0, 8) : [];
    return {
      summary: String(payload.summary || "Resumo executivo gerado com prioridades oficiais.").slice(0, 600),
      priorities,
      risks: readList("risks"),
      opportunities: readList("opportunities"),
      managementRecommendations: readList("managementRecommendations"),
      recommendations: readList("managementRecommendations"),
      nextActions: readList("nextActions"),
      highlights: readList("highlights")
    };
  } catch { return null; }
};

const toPriorityItem = (p: ExecutivePriority): PriorityItem => ({ title: p.title, detail: `${p.reason}. Ação: ${p.recommendedAction}`, score: p.score, level: p.level });

const deterministicSummary = (priorities: ExecutivePriority[], stats: any) => {
  const top = priorities.slice(0, EXECUTIVE_VISIBLE_PRIORITY_LIMIT);
  return {
    summary: top.length ? `Resumo executivo: ${top.length} prioridade(s) críticas no topo da carteira. A maior prioridade tem score ${top[0].score} (${top[0].level}) sustentada por: ${top[0].reason}.` : `Resumo executivo: ${stats.clients.total} clientes analisados e ${stats.opportunities.open} oportunidades abertas, sem prioridade crítica no momento.`,
    priorities,
    highPriority: priorities.filter((p) => p.level === "urgente" || p.level === "alta").map(toPriorityItem).slice(0, 8),
    mediumPriority: priorities.filter((p) => p.level === "normal").map(toPriorityItem).slice(0, 8),
    lowPriority: priorities.filter((p) => p.level === "baixa").map(toPriorityItem).slice(0, 8),
    recommendations: top.map((p) => p.recommendedAction),
    managementRecommendations: top.map((p) => p.recommendedAction),
    nextActions: top.map((p) => `${p.title}: ${p.recommendedAction}`),
    risks: priorities.filter((p) => /vencido|sem compra|título/i.test(p.reason)).map((p) => `${p.title}: ${p.reason}`).slice(0, 6),
    opportunities: priorities.filter((p) => /oportunidade/i.test(p.title)).map((p) => `${p.title}: score ${p.score}`).slice(0, 6),
    highlights: [`${stats.clients.total} cliente(s) e ${stats.opportunities.open} oportunidade(s) aberta(s) analisados com o CommercialPriorityService.`]
  };
};

const collectDeterministicContext = async () => {
  const now = new Date();
  const [clients, opportunities, activities, sellers, products, items] = await Promise.all([
    prisma.client.findMany({ where: { isArchived: false }, select: { id: true, name: true, region: true, city: true, state: true, ownerSellerId: true, createdAt: true, lastPurchaseDate: true, lastPurchaseValue: true, openTitlesTotal: true, overdueTitlesTotal: true, financialProfile: true, timelineEvents: { orderBy: { createdAt: "desc" }, take: 3, select: { createdAt: true, description: true } } } }),
    prisma.opportunity.findMany({ select: { id: true, title: true, value: true, stage: true, followUpDate: true, expectedCloseDate: true, lastContactAt: true, createdAt: true, ownerSellerId: true, notes: true, clientId: true, client: { select: { id: true, name: true, region: true, ownerSellerId: true, lastPurchaseDate: true, lastPurchaseValue: true, openTitlesTotal: true, overdueTitlesTotal: true, financialProfile: true } }, items: { take: 3, select: { productNameSnapshot: true, netTotal: true } } } }),
    prisma.activity.findMany({ where: { OR: [{ done: false }, { dueDate: { gte: todayStart() } }] }, select: { id: true, dueDate: true, date: true, createdAt: true, done: true, ownerSellerId: true, clientId: true, opportunityId: true, product: true } }),
    prisma.user.findMany({ where: { role: "vendedor", isActive: true }, select: { id: true, name: true, region: true } }),
    prisma.product.findMany({ select: { id: true, name: true, isActive: true } }),
    prisma.opportunityItem.findMany({ select: { productNameSnapshot: true, netTotal: true, createdAt: true, opportunity: { select: { stage: true } } } })
  ]);
  const activitiesByClient = new Map<string, typeof activities>();
  const activitiesByOpportunity = new Map<string, typeof activities>();
  for (const activity of activities) {
    if (activity.clientId) activitiesByClient.set(activity.clientId, [...(activitiesByClient.get(activity.clientId) ?? []), activity]);
    if (activity.opportunityId) activitiesByOpportunity.set(activity.opportunityId, [...(activitiesByOpportunity.get(activity.opportunityId) ?? []), activity]);
  }
  const openOpps = opportunities.filter((o) => OPEN_STAGES.includes(o.stage));
  const opportunityPriorities = openOpps.map((o) => {
    const input: CommercialPriorityInput = { now, client: o.client as CommercialPriorityInput["client"], opportunity: o, activities: [...(activitiesByClient.get(o.clientId) ?? []), ...(activitiesByOpportunity.get(o.id) ?? [])], timelineEvents: clients.find((c) => c.id === o.clientId)?.timelineEvents ?? [], workflow: { automaticallyCreatedOpportunity: Boolean(o.notes?.includes("automática")) } };
    const priority = calculateCommercialPriority(input);
    return { entityType: "opportunity" as const, entityId: o.id, title: `${compactName(o.client.name)} · ${compactName(o.title)}`, score: priority.score, level: priority.level, reason: firstReason(priority.reasons), recommendedAction: `Solicitar contato do vendedor responsável hoje: ${priority.nextAction}. Score ${priority.score}; valor ${formatCurrency(o.value)}${o.followUpDate ? `; follow-up ${o.followUpDate.toLocaleDateString("pt-BR")}` : ""}.` };
  });
  const clientsWithOpenOpp = new Set(openOpps.map((o) => o.clientId));
  const clientPriorities = clients.filter((c) => !clientsWithOpenOpp.has(c.id)).map((c) => {
    const priority = calculateCommercialPriority({ now, client: c as CommercialPriorityInput["client"], activities: activitiesByClient.get(c.id) ?? [], timelineEvents: c.timelineEvents });
    return { entityType: "client" as const, entityId: c.id, title: compactName(c.name), score: priority.score, level: priority.level, reason: firstReason(priority.reasons), recommendedAction: `Direcionar o vendedor responsável para ${priority.nextAction.toLowerCase()} em até 24h. Score ${priority.score}; dado de suporte: ${firstReason(priority.reasons)}.` };
  });
  const priorities = [...opportunityPriorities, ...clientPriorities].filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, AI_PRIORITY_LIMIT);
  const stats = { clients: { total: clients.length }, opportunities: { open: openOpps.length } };
  const sellerSummaries = sellers.map((seller) => ({ seller: seller.name, clients: clients.filter((c) => c.ownerSellerId === seller.id).length, opportunities: openOpps.filter((o) => o.ownerSellerId === seller.id).length }));
  const territories = Array.from(new Set(clients.map((c) => c.region).filter(Boolean))).map((region) => ({ region, clients: clients.filter((c) => c.region === region).length, opportunities: openOpps.filter((o) => o.client.region === region).length }));
  const soldProducts = items.filter((i) => i.opportunity.stage === OpportunityStage.ganho).reduce<Record<string, number>>((acc, item) => { acc[item.productNameSnapshot] = (acc[item.productNameSnapshot] || 0) + item.netTotal; return acc; }, {});
  const productSummary = { topSold: Object.entries(soldProducts).sort((a, b) => b[1] - a[1]).slice(0, NO_LIMIT).map(([name, value]) => ({ name, value })), withoutSales: products.filter((p) => p.isActive && !soldProducts[p.name]).slice(0, NO_LIMIT).map((p) => p.name) };
  const scores = priorities.map((p) => p.score);
  return { stats, priorities, lists: { priorities, sellers: sellerSummaries, territories, products: productSummary }, query: `prioridades comerciais oficiais: ${priorities.map((p) => `${p.level}:${p.score}`).join(", ")}; territórios: ${territories.map((t) => t.region).join(", ")}; produtos: ${productSummary.topSold.map((p) => p.name).join(", ")}.`, metrics: { clients: clients.length, opportunities: opportunities.length, indicators: priorities.length, priorities: priorities.length, scoreMin: scores.length ? Math.min(...scores) : 0, scoreMax: scores.length ? Math.max(...scores) : 0 } };
};

const buildFreshInsights = async (service: AiService = aiService): Promise<CacheEntry> => {
  const startedAt = Date.now();
  const context = await collectDeterministicContext();
  const knowledge = await resolveKnowledgeContextForAi(context.query);
  const fallbackPayload = deterministicSummary(context.priorities, context.stats);
  let payload = fallbackPayload;
  let usedAi = false;
  let fallbackUsed = false;
  const result = await service.chat({
    system: DEMETRA_MASTER_PROMPT,
    messages: [{ role: "user", content: `Analise os rankings oficiais abaixo e produza resposta executiva objetiva. Não invente cliente, valor, vendedor, produto, prazo ou atividade. A prioridade oficial é score/level/reason/recommendedAction; não crie novo score. Retorne somente JSON válido com as chaves: summary, priorities, risks, opportunities, managementRecommendations, nextActions.

Contexto seguro da base de conhecimento (apenas complementar):\n${knowledge.context || "Sem contexto adicional."}\n\nDados determinísticos resumidos:\n${JSON.stringify({ estatisticas: context.stats, rankings: context.lists.priorities.slice(0, AI_PRIORITY_LIMIT), tendencias: { sellers: context.lists.sellers, territories: context.lists.territories }, knowledgeMetadata: { used: Boolean(knowledge.context) } })}` }],
    temperature: 0.2,
    maxTokens: 1200
  });
  usedAi = Boolean(result);
  const parsed = result ? parseAiPayload(result.content, context.priorities) : null;
  if (parsed) payload = { ...fallbackPayload, ...parsed, highPriority: fallbackPayload.highPriority, mediumPriority: fallbackPayload.mediumPriority, lowPriority: fallbackPayload.lowPriority }; else fallbackUsed = true;
  const generatedAt = new Date();
  const expiresAtMs = generatedAt.getTime() + CACHE_TTL_MS;
  const entry: CacheEntry = { ...payload, generatedAt: generatedAt.toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs, source: fallbackUsed ? "deterministic" : "ai", metrics: context.metrics };
  logApiEvent("INFO", "[ai/commercial-insights] generated", { elapsedMs: Date.now() - startedAt, clients: context.metrics.clients, opportunities: context.metrics.opportunities, priorities: context.metrics.priorities, cacheHit: false, aiUsed: usedAi, fallbackUsed, knowledgeContextUsed: Boolean(knowledge.context), scoreMin: context.metrics.scoreMin, scoreMax: context.metrics.scoreMax });
  return entry;
};

export const invalidateCommercialInsightsCache = () => { cache = null; };

export const getCommercialInsights = async (options: { refresh?: boolean } = {}) => {
  const startedAt = Date.now();
  if (!options.refresh && cache && cache.expiresAtMs > Date.now()) {
    logApiEvent("INFO", "[ai/commercial-insights] cache-hit", { elapsedMs: Date.now() - startedAt, clients: cache.metrics.clients, opportunities: cache.metrics.opportunities, priorities: cache.metrics.priorities, cacheHit: true, aiUsed: false, fallbackUsed: cache.source === "deterministic", knowledgeContextUsed: false, scoreMin: cache.metrics.scoreMin, scoreMax: cache.metrics.scoreMax });
    return { ...cache, cacheHit: true };
  }
  if (options.refresh) inFlight = null;
  if (!inFlight) inFlight = buildFreshInsights().finally(() => { inFlight = null; });
  cache = await inFlight;
  return { ...cache, cacheHit: false };
};

export const __commercialInsightsInternals = { collectDeterministicContext, parseAiPayload, deterministicSummary };
