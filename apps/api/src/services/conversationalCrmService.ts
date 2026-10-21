import { z } from "zod";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { aiService } from "./ai/aiService.js";
import { timeAiStage } from "./ai/aiTimeBudget.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { calculateCommercialPriority } from "./commercialPriorityService.js";
import { getCommercialInsights } from "./commercialInsightsService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";
import { agendaIntelligenceService } from "./agendaIntelligenceService.js";
import { calculateTodayPriorities } from "./ai/index.js";
import { TODAY_PRIORITIES_OPPORTUNITY_SELECT } from "./ai/calculateTodayPriorities.js";
import { listPortfolioSegment, loadLastSentCrmOrderByClient, resolveLastPurchase, type PortfolioSegment } from "./clientPortfolioStatus.js";
import { PORTFOLIO_STATUS_LABELS } from "@salesforce-pro/shared";
import { brazilTodayKey } from "../utils/dateRange.js";

export const CRM_QUERY_CAPABILITIES = [
  "clients_without_purchase", "clients_first_sale", "clients_by_purchase_value", "clients_cooling", "clients_without_recent_activity", "clients_by_city", "clients_by_seller",
  "opportunities_by_priority", "opportunities_by_stage", "opportunities_by_value", "overdue_followups", "opportunities_without_recent_contact", "opportunities_awaiting_decision", "opportunities_won_lost_by_period",
  "seller_overdue_followups", "seller_open_opportunities", "seller_pipeline_value", "seller_completed_activities", "seller_clients_without_purchase",
  "weekly_planning_summary", "agenda_day_summary", "agenda_conflicts", "suggested_actions", "campaign_audience", "similar_clients", "clients_by_region", "clients_with_related_opportunity", "today_priorities"
] as const;
export type CrmCapability = typeof CRM_QUERY_CAPABILITIES[number];
type Intent = "clients" | "opportunities" | "activities" | "sellers" | "territories" | "planning" | "agenda" | "campaign" | "general";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DAY_MS = 86400000;
const BY_PRIORITY = "do mais urgente para o menos urgente";
const STAGE_LABELS: Record<string, string> = { prospeccao: "Prospecção", negociacao: "Negociação", proposta: "Proposta", ganho: "Ganho", perdido: "Perdido" };
const NOUN_BY_INTENT: Record<Intent, string> = { clients: "cliente(s)", opportunities: "oportunidade(s)", activities: "atividade(s)", sellers: "vendedor(es)", territories: "resultado(s)", planning: "ação(ões) sugerida(s)", agenda: "compromisso(s)", campaign: "cliente(s)", general: "resultado(s)" };
const cache = new Map<string, { expiresAt: number; value: ConversationalCrmResponse }>();
// Perguntas de carteira seguem a regra oficial (classifyPortfolioStatus): período e valor não se aplicam.
const PORTFOLIO_SEGMENT_BY_CAPABILITY: Partial<Record<CrmCapability, PortfolioSegment>> = { clients_without_purchase: "semComprar", seller_clients_without_purchase: "semComprar", clients_cooling: "esfriando", clients_first_sale: "primeiraVenda" };
const IGNORED_PORTFOLIO_FILTER_WARNINGS: Record<string, string> = {
  days: "Período informado não aplicado: a carteira segue a regra oficial (ativo até 12 meses, inativo recente de 12 a 24, ex-cliente acima de 24; esfriando é ativo há mais de 9 meses).",
  minimumValue: "Filtro de valor não aplicado: o CRM só tem o valor da última fatura do ERP, que não mede o porte do cliente nem acompanha os pedidos do CRM.",
  maximumValue: "Filtro de valor não aplicado: o CRM só tem o valor da última fatura do ERP, que não mede o porte do cliente nem acompanha os pedidos do CRM."
};

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
export type ConversationalCrmResponse = { answer: string; intent: Intent; filtersApplied: Array<{ field: string; operator: string; value: string | number | null; label: string }>; summary: { totalResults: number; totalValue?: number; period?: { from: string; to: string }; ordering?: string }; results: CrmResult[]; warnings: string[]; source: "ai" | "deterministic"; generatedAt: string };
type Viewer = { id: string; role: Role | string; email?: string };

const normalize = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const startOfDay = (s?: string | null) => s ? new Date(`${s}T00:00:00.000Z`) : undefined;
const endOfDay = (s?: string | null) => s ? new Date(`${s}T23:59:59.999Z`) : undefined;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const formatBrazilDate = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
const formatDayKey = (s: string) => s.split("-").reverse().join("/");
const formatMoney = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const safe = (s?: string | null, max = 160) => (s || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contato]").replace(/\b\d{10,}\b/g, "[numero]").replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[documento]").slice(0, max);

export class ConversationalCrmService {
  async query(raw: unknown, viewer: Viewer): Promise<ConversationalCrmResponse> {
    const startedAt = Date.now();
    const input = requestSchema.parse(raw);
    logApiEvent("INFO", "[crm-assistant] query-started", { viewerRole: viewer.role });
    if (this.isMalicious(input.question)) return this.reject(viewer, "Não posso exibir credenciais, documentos completos, executar SQL ou ignorar permissões.");
    const parsed = await timeAiStage("plan", () => this.buildPlan(input, viewer));
    const plan = await timeAiStage("scope", () => this.validateScope(parsed, viewer, input.context?.sellerId ?? null));
    const ignoredFilterWarnings = this.dropPortfolioIgnoredFilters(plan);
    const key = await this.cacheKey(viewer, plan);
    if (!input.refresh) { const hit = cache.get(key); if (hit && hit.expiresAt > Date.now()) { logApiEvent("INFO", "[crm-assistant] query-completed", { capability: plan.capability, cacheHit: true, resultCount: hit.value.results.length, elapsedMs: Date.now() - startedAt, aiUsed: false, fallbackUsed: false, viewerRole: viewer.role, filterCount: Object.keys(plan.filters).length }); return this.withWarnings(hit.value, ignoredFilterWarnings); } }
    logApiEvent("INFO", "[crm-assistant] query-planned", { capability: plan.capability, viewerRole: viewer.role, filterCount: Object.keys(plan.filters).length });
    const result = await timeAiStage("execute", () => this.execute(plan, viewer, input.refresh === true));
    const response = await timeAiStage("compose", () => this.composeAnswer(plan, result, input.question, viewer));
    cache.set(key, { expiresAt: Date.now() + 5 * 60_000, value: response });
    logApiEvent("INFO", "[crm-assistant] query-completed", { capability: plan.capability, resultCount: response.results.length, elapsedMs: Date.now() - startedAt, aiUsed: response.source === "ai", fallbackUsed: response.source === "deterministic", cacheHit: false, viewerRole: viewer.role, filterCount: response.filtersApplied.length });
    return this.withWarnings(response, ignoredFilterWarnings);
  }
  // Avisos da pergunta ficam fora do cache: o mesmo plano pode vir de perguntas com ou sem período/valor.
  private withWarnings(response: ConversationalCrmResponse, extra: string[]): ConversationalCrmResponse { return extra.length ? { ...response, warnings: [...response.warnings, ...extra] } : response; }
  private dropPortfolioIgnoredFilters(plan: CrmQueryPlan) {
    if (!PORTFOLIO_SEGMENT_BY_CAPABILITY[plan.capability]) return [];
    const warnings = new Set<string>();
    for (const field of Object.keys(plan.filters) as Array<keyof CrmQueryPlan["filters"]>) {
      if (field === "sellerId" || plan.filters[field] === null || plan.filters[field] === undefined) continue;
      if (IGNORED_PORTFOLIO_FILTER_WARNINGS[field]) warnings.add(IGNORED_PORTFOLIO_FILTER_WARNINGS[field]);
      delete plan.filters[field];
    }
    return [...warnings];
  }
  private isMalicious(q: string) { return /(senha|password|token|authorization|cnpj completo|cpf completo|telefone|e-mail|email|execute sql|select .* from|insert |update |delete |drop table|ignore permiss)/i.test(q); }
  private reject(viewer: Viewer, answer: string): ConversationalCrmResponse { logApiEvent("WARN", "[crm-assistant] rejected", { viewerRole: viewer.role }); return { answer, intent: "general", filtersApplied: [], summary: { totalResults: 0 }, results: [], warnings: ["Pergunta recusada por política de segurança e privacidade."], source: "deterministic", generatedAt: new Date().toISOString() }; }
  // A classificação determinística vem primeiro; a IA só classifica a pergunta que ela não resolve. Assim a única
  // chamada de IA da maioria das perguntas é a da resposta, dentro do orçamento do fluxo.
  private async buildPlan(input: ConversationalCrmRequest, viewer: Viewer) {
    const { plan: deterministic, resolved } = this.classifyDeterministically(input);
    if (resolved) { logApiEvent("INFO", "[crm-assistant] plan-deterministic", { capability: deterministic.capability, viewerRole: viewer.role }); return planSchema.parse(deterministic); }
    try {
      const ai = await aiService.chat({ system: "Classifique perguntas CRM apenas no catálogo permitido. Responda somente JSON com capability, filters, sort e limit. Não gere SQL.", messages: [{ role: "user", content: input.question.slice(0, 700) }], temperature: 0, maxTokens: 800, responseFormat: "json_object" }, { userId: viewer.id });
      const parsed = ai?.content ? parseAiJsonObject(ai.content)?.parsed : null;
      const candidate = parsed && typeof parsed === "object" ? { ...deterministic, ...(parsed as object), filters: { ...deterministic.filters, ...(parsed as any).filters } } : deterministic;
      return planSchema.parse(candidate);
    } catch { logApiEvent("WARN", "[crm-assistant] fallback", { viewerRole: viewer.role, fallbackUsed: true }); return planSchema.parse(deterministic); }
  }
  private classifyDeterministically(input: ConversationalCrmRequest): { plan: CrmQueryPlan; resolved: boolean } {
    const q = normalize(input.question); const num = Number(q.match(/(\d+)/)?.[1]); const money = Number(q.match(/(?:r\$\s*)?(\d+[\d.]*)\s*(?:mil|k)?/)?.[1]?.replace(/\./g, ""));
    let capability: CrmCapability | null = null;
    if (/campanha|vender|audiencia|publico/.test(q)) capability = "campaign_audience"; else if (/planejamento|semana/.test(q)) capability = "weekly_planning_summary"; else if (/(quem|quais clientes|que clientes).*(atender|visitar|ligar|procurar).*hoje|prioridades (de|para) hoje|o que (devo |eu devo )?fazer hoje/.test(q)) capability = "today_priorities"; else if (/agenda|visitas|amanha|hoje/.test(q) && !/oportunidade/.test(q)) capability = "agenda_day_summary"; else if (/pipeline.*vendedor|valor.*vendedor/.test(q)) capability = "seller_pipeline_value"; else if (/vendedor.*follow|follow.*vendedor/.test(q)) capability = "seller_overdue_followups"; else if (/follow.*venc/.test(q)) capability = "overdue_followups"; else if (/prioridade|chance|atencao/.test(q) && /oportun/.test(q)) capability = "opportunities_by_priority"; else if (/aguardando decis|decisao/.test(q)) capability = "opportunities_awaiting_decision"; else if (/oportun/.test(q) && /(valor|acima|maior)/.test(q)) capability = "opportunities_by_value"; else if (/nunca compr|primeira venda|prospect/.test(q)) capability = "clients_first_sale"; else if (/esfriando/.test(q)) capability = "clients_cooling"; else if (/atividade recente|sem atividade/.test(q)) capability = "clients_without_recent_activity"; else if (/cidade|territorio|regiao/.test(q)) capability = "clients_by_city"; else if (/compraram|compra.*mais|acima/.test(q)) capability = "clients_by_purchase_value";
    const matched = capability !== null;
    capability ??= "clients_without_purchase";
    const filters: any = { ...(input.context?.dateRange ? { from: input.context.dateRange.from, to: input.context.dateRange.to } : {}) };
    if (num && /dias?/.test(q)) filters.days = num; if (money && /(mil|k)/.test(q)) filters.minimumValue = money * 1000; else if (money && /(r\$|valor|acima|mais)/.test(q)) filters.minimumValue = money; if (input.context?.sellerId) filters.sellerId = input.context.sellerId;
    const products = q.match(/compr[aou].*?([a-z0-9çãõéíóú -]+).*interesse em ([a-z0-9çãõéíóú -]+)/); if (products) { filters.productBought = products[1].trim().split(" ").slice(-1)[0]; filters.targetProduct = products[2].trim().split(" ")[0]; }
    // Resolvida = alguma regra casou e os filtros que a capacidade exige saíram da pergunta. Cidade/região e o
    // produto da campanha não são extraídos aqui: essas perguntas continuam indo para a IA.
    const missingFilter = (capability === "clients_by_city" && !filters.city && !filters.region) || (capability === "campaign_audience" && !filters.productBought);
    return { plan: { capability, filters, sort: { field: "priorityScore", direction: "desc" }, limit: DEFAULT_LIMIT }, resolved: matched && !missingFilter };
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
  // Filtros como o usuário fala: nome do vendedor em vez do id, valores em R$ e datas dd/mm/aaaa.
  private async filterLabels(plan: CrmQueryPlan) {
    const f = plan.filters;
    const seller = f.sellerId ? await prisma.user.findFirst({ where: { id: f.sellerId }, select: { name: true } }) : null;
    const label = (field: string, value: string | number): string => {
      switch (field) {
        case "sellerId": return `Vendedor: ${safe(seller?.name, 60) || "selecionado"}`;
        case "days": return plan.capability === "clients_without_recent_activity" ? `Sem atividade há mais de ${value} dias` : `Últimos ${value} dias`;
        case "city": return `Cidade: ${safe(String(value), 80)}`;
        case "region": return `Região: ${safe(String(value), 80)}`;
        case "minimumValue": return `Valor acima de ${formatMoney(Number(value))}`;
        case "maximumValue": return `Valor até ${formatMoney(Number(value))}`;
        case "stage": return `Etapa: ${STAGE_LABELS[String(value)] ?? value}`;
        case "from": return `A partir de ${formatDayKey(String(value))}`;
        case "to": return `Até ${formatDayKey(String(value))}`;
        case "productBought": return `Comprou: ${safe(String(value), 80)}`;
        case "targetProduct": return `Interesse em: ${safe(String(value), 80)}`;
        default: return String(value);
      }
    };
    return this.filters(plan).map((item) => ({ ...item, label: label(item.field, item.value as string | number) }));
  }
  private intent(c: CrmCapability): Intent { if (c.startsWith("client")) return "clients"; if (c.startsWith("opportun")) return "opportunities"; if (c.startsWith("seller")) return "sellers"; if (c.includes("planning") || c === "suggested_actions" || c === "today_priorities") return "planning"; if (c.includes("agenda")) return "agenda"; if (c.includes("campaign") || c.includes("similar")) return "campaign"; return "general"; }
  private async execute(plan: CrmQueryPlan, viewer: Viewer, refresh: boolean) {
    const f = plan.filters; const owner = this.ownerWhere(viewer, f.sellerId); const limit = plan.limit; const cutoff = daysAgo(f.days ?? 120); let results: CrmResult[] = []; let totalValue = 0; const warnings: string[] = [];
    if (plan.capability === "weekly_planning_summary") { const p = await planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: viewer.id, viewerRole: viewer.role, sellerId: f.sellerId ?? undefined, weekStart: f.from ?? undefined, refresh }); results = p.days.flatMap(d => d.suggestedActions.slice(0, 3).map(a => ({ entityType: a.opportunityId ? ("opportunity" as const) : ("client" as const), entityId: a.opportunityId || a.clientId || d.date, title: a.title, subtitle: d.label, score: a.score, reason: a.reason }))).slice(0, limit); return { results, totalValue, ordering: "por dia da semana", warnings, source: p.source }; }
    // Agenda do dia (de Brasília) só com os compromissos: sem encaixes sugeridos, que gerariam o planejamento semanal.
    if (plan.capability === "agenda_day_summary" || plan.capability === "agenda_conflicts") { const date = f.from ?? brazilTodayKey(); const a = await agendaIntelligenceService.listDaySchedule({ viewerUserId: viewer.id, viewerRole: viewer.role, sellerId: f.sellerId ?? undefined, date }); const schedule = a.currentSchedule.slice(0, limit); results = schedule.map(e => ({ entityType: "activity" as const, entityId: e.agendaEventId, title: e.title, subtitle: `${e.fixedStartTime || "horário flexível"} • ${e.city || "sem cidade"}`, score: e.priorityScore })); const conflictWarnings = [...new Set(a.conflicts.filter(c => c.type !== "missing_location").map(c => c.description))]; const headline = `Encontrei ${a.currentSchedule.length} compromisso(s) na agenda de ${formatDayKey(date)}, em ordem de horário.${a.currentSchedule.length > schedule.length ? ` Mostrando os ${schedule.length} primeiros.` : ""}`; return { results, totalValue, total: a.currentSchedule.length, headline, ordering: "em ordem de horário", warnings: [...warnings, ...conflictWarnings], source: "deterministic" as const }; }
    if (plan.capability === "today_priorities") return this.todayPriorities(owner, limit, warnings);
    if (plan.capability === "seller_pipeline_value" || plan.capability === "seller_open_opportunities" || plan.capability === "seller_overdue_followups" || plan.capability === "seller_completed_activities") return this.sellerAggregates(plan, viewer);
    if (plan.capability === "campaign_audience") { const clients = await prisma.client.findMany({ where: { ...owner, isArchived: false, OR: [{ opportunities: { some: { OR: [{ productOffered: { contains: f.productBought || "", mode: "insensitive" } }, { crop: { contains: f.productBought || "", mode: "insensitive" } }] } } }, { activities: { some: { product: { contains: f.productBought || "", mode: "insensitive" } } } }] }, take: limit, select: { id: true, name: true, fantasyName: true, city: true, state: true, lastPurchaseValue: true } }); results = clients.map(c => ({ entityType: "client", entityId: c.id, title: safe(c.fantasyName || c.name, 80), subtitle: `${c.city}/${c.state}`, reason: `Audiência determinada por histórico relacionado a ${safe(f.productBought, 40)}.`, action: { label: "Abrir cliente", path: `/clientes/${c.id}` } })); return { results, totalValue: clients.reduce((s,c)=>s+(c.lastPurchaseValue||0),0), warnings, source: "deterministic" as const }; }
    if (plan.capability.startsWith("opportunities") || plan.capability === "overdue_followups") { const where: Prisma.OpportunityWhereInput = { ...owner, stage: { notIn: ["ganho", "perdido"] } as any, client: { isArchived: false } }; if (plan.capability === "overdue_followups") where.followUpDate = { lt: new Date() }; if (plan.capability === "opportunities_awaiting_decision") where.stage = "proposta"; if (f.stage) where.stage = f.stage; if (f.minimumValue) where.value = { gte: f.minimumValue }; const opps = await prisma.opportunity.findMany({ where, take: limit, select: { id:true,title:true,value:true,stage:true,followUpDate:true,lastContactAt:true,createdAt:true, clientId:true, client:{select:{name:true,city:true,state:true,lastPurchaseDate:true,lastPurchaseValue:true,ownerSellerId:true,financialProfile:true,openTitlesTotal:true,overdueTitlesTotal:true}}, activities:{take:5,select:{dueDate:true,date:true,done:true,createdAt:true}} as any }, orderBy: plan.sort.field === "value" ? { value: plan.sort.direction } : { followUpDate: "asc" } }); const lastSentCrmOrderByClient = opps.length ? await loadLastSentCrmOrderByClient({ id: { in: [...new Set(opps.map((o) => o.clientId))] } }) : new Map<string, Date>(); totalValue = opps.reduce((s,o)=>s+o.value,0); results = opps.map(o => { const p = calculateCommercialPriority({ client: { ...o.client, lastSentCrmOrderDate: lastSentCrmOrderByClient.get(o.clientId) ?? null } as any, opportunity: o, activities: o.activities as any }); return { entityType:"opportunity" as const, entityId:o.id, title:safe(o.title,80), subtitle:`${o.client.name} • ${o.stage} • R$ ${o.value.toLocaleString("pt-BR")}`, score:p.score, reason:p.reasons.join("; ") || "Oportunidade dentro dos critérios.", action:{label:"Abrir oportunidade", path:`/oportunidades/${o.id}`}}; }).sort((a,b)=>(b.score||0)-(a.score||0)); return { results, totalValue, ordering: BY_PRIORITY, warnings, source:"deterministic" as const }; }
    const segment = PORTFOLIO_SEGMENT_BY_CAPABILITY[plan.capability]; if (segment) return this.portfolioSegment(segment, owner, limit, warnings);
    const clientWhere: Prisma.ClientWhereInput = { ...owner, isArchived: false }; if (plan.capability === "clients_by_purchase_value" && f.minimumValue) clientWhere.lastPurchaseValue = { gte: f.minimumValue }; if ((plan.capability === "clients_by_city" || plan.capability === "clients_by_region") && (f.city || f.region)) clientWhere.OR = [{ city: { contains: f.city || f.region || "", mode: "insensitive" } }, { region: { contains: f.region || f.city || "", mode: "insensitive" } }]; if (plan.capability === "clients_without_recent_activity") clientWhere.activities = { none: { createdAt: { gte: cutoff } } };
    const clients = await prisma.client.findMany({ where: clientWhere, take: limit, select: { id:true,name:true,fantasyName:true,city:true,state:true,lastPurchaseDate:true,lastPurchaseValue:true,ownerSellerId:true,financialProfile:true,openTitlesTotal:true,overdueTitlesTotal:true, activities:{take:5,orderBy:{createdAt:"desc"},select:{date:true,dueDate:true,done:true,createdAt:true}} }, orderBy: { lastPurchaseDate: "asc" } });
    const lastSentCrmOrderByClient = clients.length ? await loadLastSentCrmOrderByClient({ id: { in: clients.map((c) => c.id) } }) : new Map<string, Date>(); totalValue = clients.reduce((s,c)=>s+(c.lastPurchaseValue||0),0); results = clients.map(c => { const p = calculateCommercialPriority({ client: { ...c, lastSentCrmOrderDate: lastSentCrmOrderByClient.get(c.id) ?? null } as any, activities: c.activities as any }); const lastPurchase = resolveLastPurchase(c, lastSentCrmOrderByClient); const days = lastPurchase ? Math.floor((Date.now()-lastPurchase.date.getTime())/DAY_MS) : null; return { entityType:"client" as const, entityId:c.id, title:safe(c.fantasyName || c.name,80), subtitle:`${c.city}/${c.state}${days !== null ? ` • ${days} dias sem compra` : " • sem compra registrada"}`, score:p.score, reason:p.reasons.join("; ") || "Cliente dentro dos critérios.", action:{label:"Abrir cliente", path:`/clientes/${c.id}`}}; }).sort((a,b)=>(b.score||0)-(a.score||0));
    if (viewer.role !== "vendedor" && plan.capability === "clients_by_seller") void getCommercialInsights({ refresh: false }).catch(()=>null);
    return { results, totalValue, ordering: BY_PRIORITY, warnings, source:"deterministic" as const };
  }
  // "Quem devo atender hoje": as mesmas prioridades da Central do Dia (calculateTodayPriorities), no escopo do
  // usuário, com o dia de Brasília. Um card por cliente, o da oportunidade mais urgente.
  private async todayPriorities(owner: Prisma.OpportunityWhereInput, limit: number, warnings: string[]) {
    const todayStart = startOfDay(brazilTodayKey())!;
    const opportunities = await prisma.opportunity.findMany({ where: { ...owner, stage: { notIn: ["ganho", "perdido"] }, client: { isArchived: false } }, select: TODAY_PRIORITIES_OPPORTUNITY_SELECT });
    const lastSentCrmOrderByClient = opportunities.length ? await loadLastSentCrmOrderByClient({ id: { in: [...new Set(opportunities.map((o) => o.clientId))] } }) : new Map<string, Date>();
    const priorities = calculateTodayPriorities(opportunities.map((o) => ({ ...o, client: { ...o.client, lastSentCrmOrderDate: lastSentCrmOrderByClient.get(o.clientId) ?? null } })), todayStart);
    const seen = new Set<string>();
    const byClient = priorities.filter((p) => { const key = p.clientId ?? p.opportunityId; if (seen.has(key)) return false; seen.add(key); return true; });
    const results: CrmResult[] = byClient.slice(0, limit).map((p) => ({ entityType: "opportunity", entityId: p.opportunityId, title: safe(p.clientName, 80), subtitle: `${safe(p.title, 60) || "Oportunidade"} • ${formatMoney(p.value)}`, score: p.priorityScore, reason: [p.priorityReasons.join("; "), p.suggestedAction ? `Próximo passo: ${p.suggestedAction}` : ""].filter(Boolean).join(". "), action: { label: "Abrir oportunidade", path: `/oportunidades/${p.opportunityId}` } }));
    const headline = byClient.length ? `Encontrei ${byClient.length} cliente(s) para atender hoje, ${BY_PRIORITY}.${byClient.length > results.length ? ` Mostrando os ${results.length} primeiros.` : ""}` : "Nenhum cliente com oportunidade aberta para priorizar hoje.";
    return { results, totalValue: byClient.reduce((sum, p) => sum + p.value, 0), total: byClient.length, ordering: BY_PRIORITY, headline, warnings, source: "deterministic" as const };
  }
  private async portfolioSegment(segment: PortfolioSegment, owner: Prisma.ClientWhereInput, limit: number, warnings: string[]) {
    const entries = await listPortfolioSegment(segment, owner, new Date());
    const page = entries.slice(0, limit);
    const rows = page.length ? await prisma.client.findMany({ where: { id: { in: page.map((e) => e.id) }, isArchived: false }, select: { id: true, name: true, fantasyName: true, city: true, state: true } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results: CrmResult[] = page.flatMap((e) => { const c = byId.get(e.id); if (!c) return []; return [{ entityType: "client" as const, entityId: c.id, title: safe(c.fantasyName || c.name, 80), subtitle: `${c.city}/${c.state} • ${PORTFOLIO_STATUS_LABELS[e.status]}${segment === "esfriando" ? " esfriando" : ""}`, reason: e.lastPurchase ? `Última compra em ${formatBrazilDate(e.lastPurchase.date)} (${e.lastPurchase.source === "erp" ? "ERP" : "pedido do CRM"}).` : "Nunca comprou: oportunidade de primeira venda.", action: { label: "Abrir cliente", path: `/clientes/${c.id}` } }]; });
    const recent = entries.filter((e) => e.status === "inativoRecente").length;
    const headline = segment === "semComprar"
      ? `Encontrei ${entries.length} cliente(s) sem comprar: ${recent} inativo(s) recente(s) (12 a 24 meses) e ${entries.length - recent} ex-cliente(s) (mais de 24 meses). Prospects ficam de fora; pergunte por "primeira venda".`
      : segment === "esfriando"
        ? `Encontrei ${entries.length} cliente(s) ativo(s) esfriando: última compra há mais de 9 meses, ainda dentro dos 12.`
        : `Encontrei ${entries.length} prospect(s) que nunca compraram (primeira venda).`;
    const ordering = segment === "semComprar" ? "inativo recente primeiro, depois ex-cliente; compra mais recente primeiro" : segment === "esfriando" ? "compra mais antiga primeiro" : "nome";
    return { results, totalValue: 0, total: entries.length, ordering, headline: entries.length > results.length ? `${headline} Mostrando os ${results.length} primeiros.` : headline, warnings, source: "deterministic" as const };
  }
  private async sellerAggregates(plan: CrmQueryPlan, viewer: Viewer) { const whereUser = viewer.role === "vendedor" ? { id: viewer.id } : plan.filters.sellerId ? { id: plan.filters.sellerId } : { role: "vendedor" as const, isActive: true }; const sellers = await prisma.user.findMany({ where: whereUser, take: plan.limit, select: { id:true,name:true, _count:{select:{opportunities:true,activities:true,clients:true}} } }); const rows = await Promise.all(sellers.map(async s => { const [pipeline, overdue] = await Promise.all([prisma.opportunity.aggregate({ where: { ownerSellerId:s.id, stage:{notIn:["ganho","perdido"]}, client: { isArchived: false } }, _sum:{value:true}, _count:true }), prisma.opportunity.count({ where:{ ownerSellerId:s.id, followUpDate:{lt:new Date()}, stage:{notIn:["ganho","perdido"]}, client: { isArchived: false } }})]); return { s, pipeline, overdue }; })); const results = rows.map(r => ({ entityType:"seller" as const, entityId:r.s.id, title:safe(r.s.name,80), subtitle:`Pipeline R$ ${(r.pipeline._sum.value||0).toLocaleString("pt-BR")} • ${r.overdue} follow-ups vencidos`, score:r.overdue, reason:`${r.pipeline._count} oportunidades abertas; ${r.s._count.activities} atividades registradas.` })); return { results, totalValue: rows.reduce((sum,r)=>sum+(r.pipeline._sum.value||0),0), warnings:[], source:"deterministic" as const }; }
  private async composeAnswer(plan: CrmQueryPlan, data: { results: CrmResult[]; totalValue: number; total?: number; headline?: string; ordering?: string; warnings: string[]; source: "ai" | "deterministic" }, question: string, viewer: Viewer): Promise<ConversationalCrmResponse> { const totalResults = data.total ?? data.results.length; const intent = this.intent(plan.capability); const filtersApplied = await this.filterLabels(plan); const base = data.headline ?? `Encontrei ${data.results.length} ${NOUN_BY_INTENT[intent]}${data.ordering ? `, ${data.ordering}` : ""}.`; let answer = base; let source = data.source; try { const ai = await aiService.chat({ system: "Reescreva uma resposta comercial curta em português usando apenas o resumo e critérios recebidos. Não invente causas nem dados.", messages: [{ role:"user", content: JSON.stringify({ question: question.slice(0,200), base, totalResults }) }], temperature: 0.2, maxTokens: 1000 }, { userId: viewer.id }); if (ai?.content) { answer = safe(ai.content, 700); source = "ai"; } } catch { /* fallback */ } return { answer, intent, filtersApplied, summary: { totalResults, totalValue: data.totalValue, period: plan.filters.from && plan.filters.to ? { from: plan.filters.from, to: plan.filters.to } : undefined, ordering: data.ordering }, results: data.results, warnings: data.warnings, source, generatedAt: new Date().toISOString() }; }
}
export const conversationalCrmService = new ConversationalCrmService();
export const __conversationalCrmInternals = { planSchema, requestSchema, CRM_QUERY_CAPABILITIES };
