import { z } from "zod";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { aiService } from "./ai/aiService.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { calculateCommercialPriority } from "./commercialPriorityService.js";
import { getCommercialInsights } from "./commercialInsightsService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";
import { agendaIntelligenceService } from "./agendaIntelligenceService.js";
import { resolveKnowledgeContextForAi } from "./knowledgeBaseService.js";

export const CRM_QUERY_CAPABILITIES = [
  "clients_without_purchase", "clients_by_purchase_value", "clients_cooling", "clients_without_recent_activity", "clients_by_city", "clients_by_seller",
  "opportunities_by_priority", "opportunities_by_stage", "opportunities_by_value", "overdue_followups", "opportunities_without_recent_contact", "opportunities_awaiting_decision", "opportunities_won_lost_by_period",
  "seller_overdue_followups", "seller_open_opportunities", "seller_pipeline_value", "seller_completed_activities", "seller_clients_without_purchase",
  "weekly_planning_summary", "agenda_day_summary", "agenda_conflicts", "suggested_actions", "campaign_audience", "similar_clients", "clients_by_region", "clients_with_related_opportunity"
] as const;
export type CrmCapability = typeof CRM_QUERY_CAPABILITIES[number];
type Intent = "clients" | "opportunities" | "activities" | "sellers" | "territories" | "planning" | "agenda" | "campaign" | "general";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DAY_MS = 86400000;
const cache = new Map<string, { expiresAt: number; value: ConversationalCrmResponse }>();

const sortSchema = z.object({ field: z.enum(["priorityScore", "value", "date", "name", "count"]).default("priorityScore"), direction: z.enum(["asc", "desc"]).default("desc") }).default({ field: "priorityScore", direction: "desc" });
const planSchema = z.object({
  capability: z.enum(CRM_QUERY_CAPABILITIES),
  filters: z.object({
    days: z.number().int().min(1).max(730).optional(), sellerId: z.string().min(1).max(128).nullable().optional(), city: z.string().min(1).max(80).nullable().optional(), region: z.string().min(1).max(80).nullable().optional(),
    minimumValue: z.number().min(0).max(100_000_000).nullable().optional(), maximumValue: z.number().min(0).max(100_000_000).nullable().optional(), stage: z.enum(["prospeccao", "negociacao", "proposta", "ganho", "perdido"]).nullable().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), productBought: z.string().min(1).max(80).nullable().optional(), targetProduct: z.string().min(1).max(80).nullable().optional()
  }).strict().default({}),
  sort: sortSchema,
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
}).strict();
export type CrmQueryPlan = z.infer<typeof planSchema>;

const requestSchema = z.object({ question: z.string().trim().min(3).max(700), conversationId: z.string().max(80).nullable().optional(), refresh: z.boolean().optional(), context: z.object({ clientId: z.string().nullable().optional(), opportunityId: z.string().nullable().optional(), sellerId: z.string().nullable().optional(), dateRange: z.object({ from: z.string(), to: z.string() }).nullable().optional() }).partial().optional() }).strict();
export type ConversationalCrmRequest = z.infer<typeof requestSchema>;
export type CrmResult = { entityType: "client" | "opportunity" | "seller" | "territory" | "activity"; entityId: string; title: string; subtitle?: string; score?: number; reason?: string; action?: { label: string; path: string } };
export type ConversationalCrmResponse = { answer: string; intent: Intent; filtersApplied: Array<{ field: string; operator: string; value: string | number | null }>; summary: { totalResults: number; totalValue?: number; period?: { from: string; to: string }; ordering?: string }; results: CrmResult[]; warnings: string[]; source: "ai" | "deterministic"; generatedAt: string };
type Viewer = { id: string; role: Role | string; email?: string };

const normalize = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const startOfDay = (s?: string | null) => s ? new Date(`${s}T00:00:00.000Z`) : undefined;
const endOfDay = (s?: string | null) => s ? new Date(`${s}T23:59:59.999Z`) : undefined;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const safe = (s?: string | null, max = 160) => (s || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contato]").replace(/\b\d{10,}\b/g, "[numero]").replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[documento]").slice(0, max);

export class ConversationalCrmService {
  async query(raw: unknown, viewer: Viewer): Promise<ConversationalCrmResponse> {
    const startedAt = Date.now();
    const input = requestSchema.parse(raw);
    logApiEvent("INFO", "[crm-assistant] query-started", { viewerRole: viewer.role });
    if (this.isMalicious(input.question)) return this.reject(viewer, "Não posso exibir credenciais, documentos completos, executar SQL ou ignorar permissões.");
    const parsed = await this.buildPlan(input, viewer);
    const plan = await this.validateScope(parsed, viewer, input.context?.sellerId ?? null);
    const key = await this.cacheKey(viewer, plan);
    if (!input.refresh) { const hit = cache.get(key); if (hit && hit.expiresAt > Date.now()) { logApiEvent("INFO", "[crm-assistant] query-completed", { capability: plan.capability, cacheHit: true, resultCount: hit.value.results.length, elapsedMs: Date.now() - startedAt, aiUsed: false, fallbackUsed: false, viewerRole: viewer.role, filterCount: Object.keys(plan.filters).length }); return hit.value; } }
    logApiEvent("INFO", "[crm-assistant] query-planned", { capability: plan.capability, viewerRole: viewer.role, filterCount: Object.keys(plan.filters).length });
    const result = await this.execute(plan, viewer, input.refresh === true);
    const response = await this.composeAnswer(plan, result, input.question);
    cache.set(key, { expiresAt: Date.now() + 5 * 60_000, value: response });
    logApiEvent("INFO", "[crm-assistant] query-completed", { capability: plan.capability, resultCount: response.results.length, elapsedMs: Date.now() - startedAt, aiUsed: response.source === "ai", fallbackUsed: response.source === "deterministic", cacheHit: false, viewerRole: viewer.role, filterCount: response.filtersApplied.length });
    return response;
  }
  private isMalicious(q: string) { return /(senha|password|token|authorization|cnpj completo|cpf completo|telefone|e-mail|email|execute sql|select .* from|insert |update |delete |drop table|ignore permiss)/i.test(q); }
  private reject(viewer: Viewer, answer: string): ConversationalCrmResponse { logApiEvent("WARN", "[crm-assistant] rejected", { viewerRole: viewer.role }); return { answer, intent: "general", filtersApplied: [], summary: { totalResults: 0 }, results: [], warnings: ["Pergunta recusada por política de segurança e privacidade."], source: "deterministic", generatedAt: new Date().toISOString() }; }
  private async buildPlan(input: ConversationalCrmRequest, viewer: Viewer) {
    const deterministic = this.classifyDeterministically(input);
    try {
      const ai = await aiService.chat({ system: "Classifique perguntas CRM apenas no catálogo permitido. Responda somente JSON com capability, filters, sort e limit. Não gere SQL.", messages: [{ role: "user", content: input.question.slice(0, 700) }], temperature: 0, maxTokens: 600 });
      const parsed = ai?.content ? parseAiJsonObject(ai.content)?.parsed : null;
      const candidate = parsed && typeof parsed === "object" ? { ...deterministic, ...(parsed as object), filters: { ...deterministic.filters, ...(parsed as any).filters } } : deterministic;
      return planSchema.parse(candidate);
    } catch { logApiEvent("WARN", "[crm-assistant] fallback", { viewerRole: viewer.role, fallbackUsed: true }); return planSchema.parse(deterministic); }
  }
  private classifyDeterministically(input: ConversationalCrmRequest): CrmQueryPlan {
    const q = normalize(input.question); const num = Number(q.match(/(\d+)/)?.[1]); const money = Number(q.match(/(?:r\$\s*)?(\d+[\d.]*)\s*(?:mil|k)?/)?.[1]?.replace(/\./g, ""));
    let capability: CrmCapability = "clients_without_purchase";
    if (/campanha|vender|audiencia|publico/.test(q)) capability = "campaign_audience"; else if (/planejamento|semana/.test(q)) capability = "weekly_planning_summary"; else if (/agenda|visitas|amanha|hoje/.test(q) && !/oportunidade/.test(q)) capability = "agenda_day_summary"; else if (/pipeline.*vendedor|valor.*vendedor/.test(q)) capability = "seller_pipeline_value"; else if (/vendedor.*follow|follow.*vendedor/.test(q)) capability = "seller_overdue_followups"; else if (/follow.*venc/.test(q)) capability = "overdue_followups"; else if (/prioridade|chance|atencao/.test(q) && /oportun/.test(q)) capability = "opportunities_by_priority"; else if (/aguardando decis|decisao/.test(q)) capability = "opportunities_awaiting_decision"; else if (/oportun/.test(q) && /(valor|acima|maior)/.test(q)) capability = "opportunities_by_value"; else if (/esfriando/.test(q)) capability = "clients_cooling"; else if (/atividade recente|sem atividade/.test(q)) capability = "clients_without_recent_activity"; else if (/cidade|territorio|regiao/.test(q)) capability = "clients_by_city"; else if (/compraram|compra.*mais|acima/.test(q)) capability = "clients_by_purchase_value";
    const filters: any = { ...(input.context?.dateRange ? { from: input.context.dateRange.from, to: input.context.dateRange.to } : {}) };
    if (num && /dias?/.test(q)) filters.days = num; if (money && /(mil|k)/.test(q)) filters.minimumValue = money * 1000; else if (money && /(r\$|valor|acima|mais)/.test(q)) filters.minimumValue = money; if (input.context?.sellerId) filters.sellerId = input.context.sellerId;
    const products = q.match(/compr[aou].*?([a-z0-9çãõéíóú -]+).*interesse em ([a-z0-9çãõéíóú -]+)/); if (products) { filters.productBought = products[1].trim().split(" ").slice(-1)[0]; filters.targetProduct = products[2].trim().split(" ")[0]; }
    return { capability, filters, sort: { field: "priorityScore", direction: "desc" }, limit: DEFAULT_LIMIT };
  }
  private async validateScope(plan: CrmQueryPlan, viewer: Viewer, contextSellerId: string | null) {
    const merged = planSchema.parse({ ...plan, filters: { ...plan.filters, sellerId: contextSellerId ?? plan.filters.sellerId ?? undefined }, limit: Math.min(plan.limit ?? DEFAULT_LIMIT, MAX_LIMIT) });
    if (viewer.role === "vendedor") {
      if (merged.filters.sellerId && merged.filters.sellerId !== viewer.id) throw Object.assign(new Error("Vendedor não pode consultar outro vendedor."), { statusCode: 403 });
      merged.filters.sellerId = viewer.id;
      if (merged.capability.startsWith("seller_") && !["seller_clients_without_purchase"].includes(merged.capability)) throw Object.assign(new Error("Vendedor não pode consultar desempenho de outros vendedores."), { statusCode: 403 });
    } else if (merged.filters.sellerId) {
      const exists = await prisma.user.findFirst({ where: { id: merged.filters.sellerId, role: "vendedor", isActive: true }, select: { id: true } }); if (!exists) throw Object.assign(new Error("Vendedor fora do escopo permitido."), { statusCode: 403 });
    }
    return merged;
  }
  private ownerWhere(viewer: Viewer, sellerId?: string | null) { return viewer.role === "vendedor" ? { ownerSellerId: viewer.id } : sellerId ? { ownerSellerId: sellerId } : {}; }
  private sellerFilter(viewer: Viewer, sellerId?: string | null) { return viewer.role === "vendedor" ? { sellerId: viewer.id } : sellerId ? { sellerId } : {}; }
  private async cacheKey(viewer: Viewer, plan: CrmQueryPlan) { return ["crm-assistant", "tenant:futura", viewer.id, viewer.role, plan.capability, JSON.stringify(plan.filters), JSON.stringify(plan.sort), plan.limit].join(":"); }
  private filters(plan: CrmQueryPlan) { return Object.entries(plan.filters).filter(([, v]) => v !== null && v !== undefined).map(([field, value]) => ({ field, operator: ["days", "minimumValue"].includes(field) ? ">" : "=", value: value as any })); }
  private intent(c: CrmCapability): Intent { if (c.startsWith("client")) return "clients"; if (c.startsWith("opportun")) return "opportunities"; if (c.startsWith("seller")) return "sellers"; if (c.includes("planning") || c === "suggested_actions") return "planning"; if (c.includes("agenda")) return "agenda"; if (c.includes("campaign") || c.includes("similar")) return "campaign"; return "general"; }
  private async execute(plan: CrmQueryPlan, viewer: Viewer, refresh: boolean) {
    const f = plan.filters; const owner = this.ownerWhere(viewer, f.sellerId); const limit = plan.limit; const cutoff = daysAgo(f.days ?? 120); let results: CrmResult[] = []; let totalValue = 0; const warnings = ["Cache em memória inclui tenantId futuro documentado; não é compartilhado entre usuários."];
    if (plan.capability === "weekly_planning_summary") { const p = await planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: viewer.id, viewerRole: viewer.role, sellerId: f.sellerId ?? undefined, weekStart: f.from ?? undefined, refresh }); results = p.days.flatMap(d => d.suggestedActions.slice(0, 3).map(a => ({ entityType: a.opportunityId ? ("opportunity" as const) : ("client" as const), entityId: a.opportunityId || a.clientId || d.date, title: a.title, subtitle: d.label, score: a.score, reason: a.reason }))).slice(0, limit); return { results, totalValue, warnings: [...warnings, p.summary], source: p.source }; }
    if (plan.capability === "agenda_day_summary" || plan.capability === "agenda_conflicts") { const date = f.from ?? dateOnly(new Date()); const a = await agendaIntelligenceService.generateAgendaOptimization({ viewerUserId: viewer.id, viewerRole: viewer.role, sellerId: f.sellerId ?? undefined, date, refresh }); results = a.currentSchedule.map(e => ({ entityType: "activity" as const, entityId: e.agendaEventId, title: e.title, subtitle: `${e.fixedStartTime || "horário flexível"} • ${e.city || "sem cidade"}`, score: e.priorityScore, reason: "Compromisso da agenda dentro do escopo permitido." })).slice(0, limit); return { results, totalValue, warnings: [...warnings, ...a.conflicts.map(c => c.description)], source: a.source }; }
    if (plan.capability === "seller_pipeline_value" || plan.capability === "seller_open_opportunities" || plan.capability === "seller_overdue_followups" || plan.capability === "seller_completed_activities") return this.sellerAggregates(plan, viewer);
    if (plan.capability === "campaign_audience") { const knowledge = await resolveKnowledgeContextForAi([f.productBought, f.targetProduct].filter(Boolean).join(" ")); const clients = await prisma.client.findMany({ where: { ...owner, isArchived: false, OR: [{ opportunities: { some: { OR: [{ productOffered: { contains: f.productBought || "", mode: "insensitive" } }, { crop: { contains: f.productBought || "", mode: "insensitive" } }] } } }, { activities: { some: { product: { contains: f.productBought || "", mode: "insensitive" } } } }] }, take: limit, select: { id: true, name: true, fantasyName: true, city: true, state: true, lastPurchaseValue: true } }); results = clients.map(c => ({ entityType: "client", entityId: c.id, title: safe(c.fantasyName || c.name, 80), subtitle: `${c.city}/${c.state}`, reason: `Audiência determinada por histórico relacionado a ${safe(f.productBought, 40)}.`, action: { label: "Abrir cliente", path: `/clientes/${c.id}` } })); return { results, totalValue: clients.reduce((s,c)=>s+(c.lastPurchaseValue||0),0), warnings: [...warnings, knowledge.context ? "Base de Conhecimento usada apenas para abordagem, não para selecionar clientes." : "Sem contexto técnico adicional na Base de Conhecimento."], source: "deterministic" as const }; }
    if (plan.capability.startsWith("opportunities") || plan.capability === "overdue_followups") { const where: Prisma.OpportunityWhereInput = { ...owner, stage: { notIn: ["ganho", "perdido"] } as any }; if (plan.capability === "overdue_followups") where.followUpDate = { lt: new Date() }; if (plan.capability === "opportunities_awaiting_decision") where.stage = "proposta"; if (f.stage) where.stage = f.stage; if (f.minimumValue) where.value = { gte: f.minimumValue }; const opps = await prisma.opportunity.findMany({ where, take: limit, select: { id:true,title:true,value:true,stage:true,followUpDate:true,lastContactAt:true,createdAt:true, client:{select:{name:true,city:true,state:true}}, activities:{take:5,select:{dueDate:true,date:true,done:true,createdAt:true}} as any }, orderBy: plan.sort.field === "value" ? { value: plan.sort.direction } : { followUpDate: "asc" } }); totalValue = opps.reduce((s,o)=>s+o.value,0); results = opps.map(o => { const p = calculateCommercialPriority({ opportunity: o, activities: o.activities as any }); return { entityType:"opportunity" as const, entityId:o.id, title:safe(o.title,80), subtitle:`${o.client.name} • ${o.stage} • R$ ${o.value.toLocaleString("pt-BR")}`, score:p.score, reason:p.reasons.join("; ") || "Oportunidade dentro dos critérios.", action:{label:"Abrir oportunidade", path:`/oportunidades/${o.id}`}}; }).sort((a,b)=>(b.score||0)-(a.score||0)); return { results, totalValue, warnings, source:"deterministic" as const }; }
    const clientWhere: Prisma.ClientWhereInput = { ...owner, isArchived: false }; if (["clients_without_purchase","clients_cooling"].includes(plan.capability)) clientWhere.OR = [{ lastPurchaseDate: { lt: cutoff } }, { lastPurchaseDate: null }]; if (plan.capability === "clients_by_purchase_value" && f.minimumValue) clientWhere.lastPurchaseValue = { gte: f.minimumValue }; if ((plan.capability === "clients_by_city" || plan.capability === "clients_by_region") && (f.city || f.region)) clientWhere.OR = [{ city: { contains: f.city || f.region || "", mode: "insensitive" } }, { region: { contains: f.region || f.city || "", mode: "insensitive" } }]; if (plan.capability === "clients_without_recent_activity") clientWhere.activities = { none: { createdAt: { gte: cutoff } } };
    const clients = await prisma.client.findMany({ where: clientWhere, take: limit, select: { id:true,name:true,fantasyName:true,city:true,state:true,lastPurchaseDate:true,lastPurchaseValue:true,ownerSellerId:true,financialProfile:true,openTitlesTotal:true,overdueTitlesTotal:true, activities:{take:5,orderBy:{createdAt:"desc"},select:{date:true,dueDate:true,done:true,createdAt:true}} }, orderBy: { lastPurchaseDate: "asc" } });
    totalValue = clients.reduce((s,c)=>s+(c.lastPurchaseValue||0),0); results = clients.map(c => { const p = calculateCommercialPriority({ client: c as any, activities: c.activities as any }); const days = c.lastPurchaseDate ? Math.floor((Date.now()-c.lastPurchaseDate.getTime())/DAY_MS) : null; return { entityType:"client" as const, entityId:c.id, title:safe(c.fantasyName || c.name,80), subtitle:`${c.city}/${c.state}${days !== null ? ` • ${days} dias sem compra` : " • sem compra registrada"}`, score:p.score, reason:p.reasons.join("; ") || "Cliente dentro dos critérios.", action:{label:"Abrir cliente", path:`/clientes/${c.id}`}}; }).sort((a,b)=>(b.score||0)-(a.score||0));
    if (viewer.role !== "vendedor" && ["clients_by_seller","clients_without_purchase"].includes(plan.capability)) { void getCommercialInsights({ refresh: false }).catch(()=>null); warnings.push("Agregados executivos podem ser enriquecidos pelo CommercialInsightsService quando disponível."); }
    return { results, totalValue, warnings, source:"deterministic" as const };
  }
  private async sellerAggregates(plan: CrmQueryPlan, viewer: Viewer) { const whereUser = viewer.role === "vendedor" ? { id: viewer.id } : plan.filters.sellerId ? { id: plan.filters.sellerId } : { role: "vendedor" as const, isActive: true }; const sellers = await prisma.user.findMany({ where: whereUser, take: plan.limit, select: { id:true,name:true, _count:{select:{opportunities:true,activities:true,clients:true}} } }); const rows = await Promise.all(sellers.map(async s => { const [pipeline, overdue] = await Promise.all([prisma.opportunity.aggregate({ where: { ownerSellerId:s.id, stage:{notIn:["ganho","perdido"]}}, _sum:{value:true}, _count:true }), prisma.opportunity.count({ where:{ ownerSellerId:s.id, followUpDate:{lt:new Date()}, stage:{notIn:["ganho","perdido"]}}})]); return { s, pipeline, overdue }; })); const results = rows.map(r => ({ entityType:"seller" as const, entityId:r.s.id, title:safe(r.s.name,80), subtitle:`Pipeline R$ ${(r.pipeline._sum.value||0).toLocaleString("pt-BR")} • ${r.overdue} follow-ups vencidos`, score:r.overdue, reason:`${r.pipeline._count} oportunidades abertas; ${r.s._count.activities} atividades registradas.` })); return { results, totalValue: rows.reduce((sum,r)=>sum+(r.pipeline._sum.value||0),0), warnings:["Gerentes usam o escopo existente por sellerId; hierarquia granular futura não foi inventada."], source:"deterministic" as const }; }
  private async composeAnswer(plan: CrmQueryPlan, data: { results: CrmResult[]; totalValue: number; warnings: string[]; source: "ai" | "deterministic" }, question: string): Promise<ConversationalCrmResponse> { const base = `Encontrei ${data.results.length} resultado(s) para ${plan.capability}. Critérios: ${this.filters(plan).map(f=>`${f.field} ${f.operator} ${f.value}`).join(", ") || "escopo permitido do usuário"}. Ordenação: ${plan.sort.field} ${plan.sort.direction}.`; let answer = base; let source = data.source; try { const ai = await aiService.chat({ system: "Reescreva uma resposta comercial curta em português usando apenas o resumo e critérios recebidos. Não invente causas nem dados.", messages: [{ role:"user", content: JSON.stringify({ question: question.slice(0,200), base, totalResults: data.results.length, totalValue: data.totalValue }) }], temperature: 0.2, maxTokens: 220 }); if (ai?.content) { answer = safe(ai.content, 700); source = "ai"; } } catch { /* fallback */ } return { answer, intent: this.intent(plan.capability), filtersApplied: this.filters(plan), summary: { totalResults: data.results.length, totalValue: data.totalValue, period: plan.filters.from && plan.filters.to ? { from: plan.filters.from, to: plan.filters.to } : undefined, ordering: `${plan.sort.field} ${plan.sort.direction}` }, results: data.results, warnings: data.warnings, source, generatedAt: new Date().toISOString() }; }
}
export const conversationalCrmService = new ConversationalCrmService();
export const __conversationalCrmInternals = { planSchema, requestSchema, CRM_QUERY_CAPABILITIES };
