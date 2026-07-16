import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { aiService } from "./ai/aiService.js";
import { calculateCommercialPriority } from "./commercialPriorityService.js";
import type { Prisma } from "@prisma/client";

export type TimelineIntelligenceInput = {
  clientId?: string;
  opportunityId?: string;
  viewerUserId: string;
  viewerRole: string;
  scope?: Prisma.ClientWhereInput | Prisma.OpportunityWhereInput;
  refresh?: boolean;
};

export type TimelineIntelligenceResult = {
  summary: string;
  status: "stable" | "attention" | "critical" | "progressing";
  highlights: Array<{ type: "purchase" | "opportunity" | "activity" | "follow_up" | "stage_change" | "erp_order" | "whatsapp" | "risk"; title: string; description: string; occurredAt: string; importance: "low" | "medium" | "high" }>;
  changes: Array<{ description: string; evidence: string[] }>;
  risks: string[];
  positiveSignals: string[];
  recommendedNextAction: string | null;
  priority?: { score: number; level: string; reasons: string[] };
  generatedAt: string;
  source: "ai" | "deterministic";
};

type Context = Awaited<ReturnType<TimelineIntelligenceService["collectAndNormalize"]>>;

const MAX_EVENTS = 30;
const MAX_ACTIVITIES = 20;
const TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_STAGES = new Set(["ganho", "perdido"]);
const CONTACT_TYPES = /ligacao|whatsapp|visita|reuniao|follow|proposta|coment/i;

const aiSchema = z.object({
  summary: z.string().trim().min(1).max(700).optional(),
  status: z.enum(["stable", "attention", "critical", "progressing"]).optional(),
  highlights: z.array(z.object({ type: z.enum(["purchase", "opportunity", "activity", "follow_up", "stage_change", "erp_order", "whatsapp", "risk"]), title: z.string(), description: z.string(), occurredAt: z.string(), importance: z.enum(["low", "medium", "high"]) })).max(3).optional(),
  changes: z.array(z.object({ description: z.string(), evidence: z.array(z.string()).max(3) })).max(3).optional(),
  risks: z.array(z.string()).max(4).optional(),
  positiveSignals: z.array(z.string()).max(4).optional(),
  recommendedNextAction: z.string().nullable().optional()
});

const cache = new Map<string, { expiresAt: number; value: TimelineIntelligenceResult }>();

const daysSince = (date: Date | null, now: Date) => date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS)) : null;
const iso = (date: Date | null | undefined) => (date ?? new Date(0)).toISOString();
const latestDate = (dates: Array<Date | null | undefined>) => dates.filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
const sanitizeText = (value: string | null | undefined, max = 180) => (value || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contato]").replace(/\b\d{10,}\b/g, "[numero]").replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[documento]").slice(0, max);

export class TimelineIntelligenceService {
  async generateTimelineIntelligence(input: TimelineIntelligenceInput): Promise<TimelineIntelligenceResult | null> {
    const startedAt = Date.now();
    const context = await this.collectAndNormalize(input);
    if (!context) return null;
    const signals = this.analyzeDeterministically(context);
    const cacheKey = this.buildCacheKey(context, input, signals.lastRelevantEventAt);
    if (!input.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logApiEvent("INFO", "[timeline-intelligence] cache-hit", this.safeMeta(context, startedAt, false, false, true, signals.status));
        return cached.value;
      }
    }

    const fallback = this.buildDeterministicResult(context, signals);
    let result = fallback;
    let aiUsed = false;
    let fallbackUsed = true;
    try {
      const ai = await this.enrichWithAi(context, signals, fallback);
      if (ai) {
        result = { ...fallback, ...ai, priority: fallback.priority, generatedAt: new Date().toISOString(), source: "ai" };
        aiUsed = true;
        fallbackUsed = false;
      }
    } catch {
      logApiEvent("WARN", "[timeline-intelligence] failed", this.safeMeta(context, startedAt, false, true, false, fallback.status));
    }
    cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, value: result });
    logApiEvent("INFO", fallbackUsed ? "[timeline-intelligence] fallback" : "[timeline-intelligence] generated", this.safeMeta(context, startedAt, aiUsed, fallbackUsed, false, result.status));
    return result;
  }

  async collectAndNormalize(input: TimelineIntelligenceInput) {
    const since = new Date(Date.now() - 365 * DAY_MS);
    const entityType = input.opportunityId ? "opportunity" as const : "client" as const;
    const baseWhere = input.scope ?? {};
    const opportunity = input.opportunityId ? await prisma.opportunity.findFirst({ where: { id: input.opportunityId, ...(baseWhere as Prisma.OpportunityWhereInput) }, select: { id: true, title: true, stage: true, value: true, followUpDate: true, lastContactAt: true, createdAt: true, closedAt: true, clientId: true, ownerSellerId: true, client: { select: { id: true, lastPurchaseDate: true, lastPurchaseValue: true, ownerSellerId: true, financialProfile: true, openTitlesTotal: true, overdueTitlesTotal: true } } } }) : null;
    const clientId = input.clientId ?? opportunity?.clientId;
    if (input.opportunityId && !opportunity) return null;
    const client = clientId ? await prisma.client.findFirst({ where: { id: clientId, isArchived: false, ...(input.opportunityId ? {} : baseWhere as Prisma.ClientWhereInput) }, select: { id: true, lastPurchaseDate: true, lastPurchaseValue: true, ownerSellerId: true, financialProfile: true, openTitlesTotal: true, overdueTitlesTotal: true } }) : null;
    if (!client) return null;
    const where = input.opportunityId ? { opportunityId: input.opportunityId } : { clientId: client.id };
    const [eventsDesc, activitiesDesc, changeLogs, latestErpOrder] = await Promise.all([
      prisma.timelineEvent.findMany({ where: { ...where, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: MAX_EVENTS, select: { type: true, description: true, createdAt: true, clientId: true, opportunityId: true, ownerSellerId: true } }),
      prisma.activity.findMany({ where: { ...where, createdAt: { gte: since } }, orderBy: [{ date: "desc" }, { dueDate: "desc" }, { createdAt: "desc" }], take: MAX_ACTIVITIES, select: { type: true, notes: true, description: true, result: true, dueDate: true, date: true, done: true, createdAt: true, opportunityId: true, clientId: true, ownerSellerId: true } }),
      input.opportunityId ? prisma.opportunityChangeLog.findMany({ where: { opportunityId: input.opportunityId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 10, select: { field: true, oldValue: true, newValue: true, createdAt: true } }) : Promise.resolve([]),
      input.opportunityId ? prisma.erpOrderSync.findFirst({ where: { opportunityId: input.opportunityId }, orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true } }) : Promise.resolve(null)
    ]);
    return { entityType, client, opportunity, events: eventsDesc.reverse().map((e) => ({ ...e, description: sanitizeText(e.description) })), activities: activitiesDesc.reverse().map((a) => ({ ...a, notes: sanitizeText(a.notes), description: sanitizeText(a.description), result: sanitizeText(a.result) })), changeLogs: changeLogs.reverse(), latestErpOrder };
  }

  analyzeDeterministically(context: NonNullable<Context>) {
    const now = new Date();
    const contactDates = [...context.events.filter((e) => CONTACT_TYPES.test(`${e.type} ${e.description}`)).map((e) => e.createdAt), ...context.activities.filter((a) => a.done || CONTACT_TYPES.test(a.type)).map((a) => a.date ?? a.createdAt), context.opportunity?.lastContactAt].filter(Boolean) as Date[];
    const lastContactAt = latestDate(contactDates);
    const overdueFollowUp = Boolean(context.opportunity?.followUpDate && context.opportunity.followUpDate < now && !CLOSED_STAGES.has(String(context.opportunity.stage)));
    const lastRelevantEventAt = latestDate([...context.events.map((e) => e.createdAt), ...context.activities.map((a) => a.date ?? a.dueDate ?? a.createdAt), ...context.changeLogs.map((c) => c.createdAt), context.latestErpOrder?.createdAt]);
    const progressed = context.changeLogs.some((c) => c.field === "stage" || c.field === "stageName") || context.events.some((e) => /etapa|estágio|stage|ganh|perdid/i.test(e.description));
    const priority = calculateCommercialPriority({ now, client: context.client as Prisma.JsonObject, opportunity: context.opportunity, activities: context.activities, timelineEvents: context.events });
    const noRecentContactDays = daysSince(lastContactAt, now);
    const risks = [overdueFollowUp ? "Follow-up vencido" : null, noRecentContactDays !== null && noRecentContactDays >= 14 ? `Sem contato há ${noRecentContactDays} dias` : null].filter(Boolean) as string[];
    const status: TimelineIntelligenceResult["status"] = priority.level === "urgente" || risks.length > 1 ? "critical" : risks.length ? "attention" : progressed ? "progressing" : "stable";
    return { now, lastContactAt, noRecentContactDays, overdueFollowUp, progressed, lastRelevantEventAt, priority, risks, status };
  }

  buildDeterministicResult(context: NonNullable<Context>, signals: ReturnType<TimelineIntelligenceService["analyzeDeterministically"]>): TimelineIntelligenceResult {
    const subject = context.opportunity ? `Oportunidade aberta há ${daysSince(context.opportunity.createdAt, signals.now)} dias` : "Cliente com histórico comercial registrado";
    const follow = signals.overdueFollowUp ? ", com follow-up vencido" : "";
    const contact = signals.noRecentContactDays === null ? ", sem contato registrado" : `, último contato há ${signals.noRecentContactDays} dias`;
    const summary = `${subject}${follow}${contact}. Prioridade ${signals.priority.level}. Próxima ação recomendada: ${signals.priority.nextAction}.`;
    const highlights = [...context.events.slice(-2).map((e) => ({ type: /whatsapp/i.test(e.description) ? "whatsapp" as const : "opportunity" as const, title: "Evento da timeline", description: e.description, occurredAt: e.createdAt.toISOString(), importance: "medium" as const })), ...context.activities.slice(-1).map((a) => ({ type: a.type.includes("follow") ? "follow_up" as const : "activity" as const, title: a.done ? "Atividade concluída" : "Atividade registrada", description: a.description || a.notes || a.type, occurredAt: (a.date ?? a.dueDate ?? a.createdAt).toISOString(), importance: a.done ? "medium" as const : "low" as const }))].slice(0, 3);
    return { summary, status: signals.status, highlights, changes: signals.progressed ? [{ description: "Houve mudança recente na evolução comercial.", evidence: context.changeLogs.map((c) => `${c.field}: ${c.oldValue ?? "-"} → ${c.newValue ?? "-"}`).slice(0, 2) }] : [], risks: signals.risks, positiveSignals: signals.progressed ? ["Progressão de etapa identificada"] : [], recommendedNextAction: signals.priority.nextAction, priority: { score: signals.priority.score, level: signals.priority.level, reasons: signals.priority.reasons }, generatedAt: new Date().toISOString(), source: "deterministic" };
  }

  async enrichWithAi(context: NonNullable<Context>, signals: ReturnType<TimelineIntelligenceService["analyzeDeterministically"]>, fallback: TimelineIntelligenceResult) {
    const dto = { entityType: context.entityType, timelineEvents: context.events.map((e) => ({ type: e.type, description: e.description, occurredAt: e.createdAt.toISOString() })), activities: context.activities.map((a) => ({ type: a.type, done: a.done, dueDate: a.dueDate.toISOString(), occurredAt: (a.date ?? a.createdAt).toISOString(), note: a.description || a.notes || a.result })), opportunity: context.opportunity ? { stage: context.opportunity.stage, value: context.opportunity.value, followUpDate: context.opportunity.followUpDate.toISOString(), createdAt: context.opportunity.createdAt.toISOString(), closedAt: context.opportunity.closedAt?.toISOString() ?? null } : null, lastPurchase: context.client.lastPurchaseDate ? { date: context.client.lastPurchaseDate.toISOString(), value: context.client.lastPurchaseValue } : null, signals: { overdueFollowUp: signals.overdueFollowUp, daysSinceLastContact: signals.noRecentContactDays, progressed: signals.progressed, officialPriority: fallback.priority, status: fallback.status } };
    const response = await aiService.chat({ temperature: 0.2, maxTokens: 700, messages: [{ role: "user", content: `Resuma a timeline comercial em JSON controlado. Use somente os dados recebidos, não invente eventos, valores, causas ou intenções, indique incerteza quando necessário, limite summary a ~500 caracteres e listas a 3 itens. Dados sanitizados: ${JSON.stringify(dto)}` }] });
    if (!response?.content) return null;
    const parsed = parseAiJsonObject(response.content);
    if (!parsed) return null;
    const valid = aiSchema.safeParse(parsed.parsed);
    return valid.success ? valid.data : null;
  }

  buildCacheKey(context: NonNullable<Context>, input: TimelineIntelligenceInput, lastRelevantEventAt: Date | null) {
    return ["timeline-intelligence", context.entityType, input.clientId ?? context.client.id, input.opportunityId ?? "client", iso(lastRelevantEventAt), input.viewerRole, input.viewerRole === "vendedor" ? input.viewerUserId : "manager-scope"].join(":");
  }

  safeMeta(context: NonNullable<Context>, startedAt: number, aiUsed: boolean, fallbackUsed: boolean, cacheHit: boolean, status: string) {
    return { entityType: context.entityType, eventCount: context.events.length, activityCount: context.activities.length, elapsedMs: Date.now() - startedAt, aiUsed, fallbackUsed, cacheHit, status, priorityLevel: this.analyzeDeterministically(context).priority.level };
  }
}

export const timelineIntelligenceService = new TimelineIntelligenceService();
export const __timelineIntelligenceCache = cache;
