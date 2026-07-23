import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { aiService } from "./ai/aiService.js";
import { calculateCommercialPriority } from "./commercialPriorityService.js";
import type { Prisma, Role } from "@prisma/client";

export const COMMERCIAL_PLANNING_DEFAULTS = {
  maxVisitsPerDay: 3,
  maxActionsPerDay: 8,
  maxCandidates: 50,
  maxPlannedActions: 30,
  cacheTtlMs: 30 * 60 * 1000,
  durations: { visit: 60, call: 20, follow_up: 15, proposal: 45, review: 30, whatsapp: 20 }
} as const;

type ActionType = "visit" | "call" | "proposal" | "follow_up" | "whatsapp" | "review";
type Source = "priority" | "follow_up" | "inactive_client" | "opportunity" | "existing_commitment";
type PriorityLevel = "urgente" | "alta" | "normal" | "baixa";

type Candidate = {
  type: ActionType;
  clientId?: string | null;
  opportunityId?: string | null;
  title: string;
  city?: string | null;
  score: number;
  priorityLevel: PriorityLevel;
  reason: string;
  objective: string;
  suggestedPeriod: "morning" | "afternoon" | null;
  estimatedDurationMinutes: number;
  source: Source;
  fixedDate?: string | null;
  dedupeKey: string;
};

export type WeeklyCommercialPlan = {
  weekStart: string;
  weekEnd: string;
  sellerId: string;
  summary: string;
  workload: { plannedActions: number; visits: number; calls: number; proposals: number; followUps: number; capacityStatus: "balanced" | "light" | "overloaded" };
  days: Array<{ date: string; label: string; existingAppointments: Array<{ id: string; title: string; type: string; startsAt: string; endsAt: string; city: string | null; clientId: string | null; opportunityId: string | null }>; suggestedActions: Omit<Candidate, "fixedDate" | "dedupeKey">[] }>;
  unallocatedPriorities: Omit<Candidate, "fixedDate" | "dedupeKey">[];
  warnings: string[];
  generatedAt: string;
  source: "ai" | "deterministic";
};

type Input = { viewerUserId: string; viewerRole: Role | string; sellerId?: string; weekStart?: string; refresh?: boolean };
const DAY_MS = 86400000;
const CLOSED_STAGES = ["ganho", "perdido"] as const;
const labels = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const cache = new Map<string, { expiresAt: number; value: WeeklyCommercialPlan }>();
const aiSchema = z.object({ summary: z.string().trim().min(1).max(700).optional(), warnings: z.array(z.string().max(160)).max(4).optional() });

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const mondayOf = (date: Date) => { const d = startOfDay(date); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); return d; };
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
const sanitize = (value: string | null | undefined, max = 160) => (value || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contato]").replace(/\b\d{10,}\b/g, "[numero]").replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[documento]").slice(0, max);
const stripInternal = ({ fixedDate, dedupeKey, ...candidate }: Candidate) => candidate;

export class PlanningIntelligenceService {
  async generateWeeklyCommercialPlan(input: Input): Promise<WeeklyCommercialPlan> {
    const startedAt = Date.now();
    const sellerId = await this.resolveSeller(input);
    const weekStartDate = input.weekStart ? startOfDay(new Date(`${input.weekStart}T00:00:00.000Z`)) : mondayOf(new Date());
    const weekEndDate = addDays(weekStartDate, 4);
    const data = await this.collectData(sellerId, weekStartDate, addDays(weekEndDate, 1));
    const lastRelevant = this.latestUpdate(data);
    const cacheKey = ["commercial-planning", sellerId, dateOnly(weekStartDate), lastRelevant.toISOString(), "company-scope:futura"].join(":");
    if (!input.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logApiEvent("INFO", "[commercial-planning] cache-hit", { sellerId, cacheHit: true });
        return cached.value;
      }
    }

    const candidates = this.deduplicate(this.buildCandidates(data, weekStartDate));
    const base = this.distribute(sellerId, weekStartDate, weekEndDate, data.events, candidates);
    let result = base;
    let aiUsed = false;
    let fallbackUsed = true;
    try {
      const ai = await this.enrichWithAi(base);
      if (ai) { result = { ...base, ...ai, source: "ai", generatedAt: new Date().toISOString() }; aiUsed = true; fallbackUsed = false; }
    } catch {
      logApiEvent("WARN", "[commercial-planning] fallback", { sellerId, candidateCount: candidates.length, fallbackUsed: true });
    }
    cache.set(cacheKey, { expiresAt: Date.now() + COMMERCIAL_PLANNING_DEFAULTS.cacheTtlMs, value: result });
    logApiEvent("INFO", fallbackUsed ? "[commercial-planning] fallback" : "[commercial-planning] generated", this.safeMeta(sellerId, startedAt, candidates.length, result, aiUsed, fallbackUsed, false));
    return result;
  }

  private async resolveSeller(input: Input) {
    if (input.viewerRole === "vendedor") return input.viewerUserId;
    if (!input.sellerId) return input.viewerUserId;
    const seller = await prisma.user.findFirst({ where: { id: input.sellerId, role: "vendedor", isActive: true }, select: { id: true } });
    if (!seller) throw Object.assign(new Error("Vendedor fora do escopo permitido."), { statusCode: 403 });
    return seller.id;
  }

  private async collectData(sellerId: string, from: Date, to: Date) {
    const [events, opportunities, activities, inactiveClients] = await Promise.all([
      prisma.agendaEvent.findMany({ where: { sellerId, startDateTime: { lt: to }, endDateTime: { gte: from } }, select: { id: true, title: true, type: true, startDateTime: true, endDateTime: true, status: true, city: true, clientId: true, opportunityId: true, updatedAt: true, stops: { select: { clientId: true, city: true }, orderBy: { order: "asc" } } }, orderBy: { startDateTime: "asc" } }),
      prisma.opportunity.findMany({
        where: { ownerSellerId: sellerId, stage: { notIn: [...CLOSED_STAGES] } },
        select: {
          id: true,
          title: true,
          value: true,
          stage: true,
          followUpDate: true,
          proposalDate: true,
          lastContactAt: true,
          createdAt: true,
          clientId: true,
          notes: true,
          client: { select: { id: true, name: true, city: true, state: true, lastPurchaseDate: true, lastPurchaseValue: true, ownerSellerId: true, financialProfile: true, openTitlesTotal: true, overdueTitlesTotal: true } },
          activities: { select: { createdAt: true, date: true, dueDate: true, done: true, notes: true, description: true, result: true }, orderBy: { createdAt: "desc" }, take: 10 },
          timelineEvents: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 5 }
        },
        take: 80
      }),
      prisma.activity.findMany({
        where: { ownerSellerId: sellerId, done: false },
        select: { id: true, type: true, dueDate: true, date: true, city: true, clientId: true, opportunityId: true, description: true, notes: true, createdAt: true, client: { select: { name: true, city: true } } },
        orderBy: { dueDate: "asc" },
        take: 60
      }),
      prisma.client.findMany({
        where: { ownerSellerId: sellerId, isArchived: false, lastPurchaseDate: { lt: addDays(from, -90) } },
        select: { id: true, name: true, city: true, state: true, lastPurchaseDate: true, lastPurchaseValue: true, ownerSellerId: true, financialProfile: true, openTitlesTotal: true, overdueTitlesTotal: true, createdAt: true },
        orderBy: { lastPurchaseDate: "asc" },
        take: 40
      })
    ]);
    return { events, opportunities, activities, inactiveClients };
  }

  private buildCandidates(data: Awaited<ReturnType<PlanningIntelligenceService["collectData"]>>, weekStart: Date): Candidate[] {
    const now = new Date();
    const candidates: Candidate[] = [];
    for (const opportunity of data.opportunities) {
      const priority = calculateCommercialPriority({ client: opportunity.client as any, opportunity, activities: opportunity.activities, timelineEvents: opportunity.timelineEvents, now });
      const followDate = dateOnly(opportunity.followUpDate);
      const overdueFollow = opportunity.followUpDate < now;
      const type: ActionType = overdueFollow ? "follow_up" : opportunity.stage === "proposta" ? "proposal" : priority.level === "urgente" || priority.level === "alta" ? "call" : "review";
      candidates.push({ type, clientId: opportunity.clientId, opportunityId: opportunity.id, title: `${type === "proposal" ? "Enviar/retomar proposta" : overdueFollow ? "Realizar follow-up" : "Atender prioridade"}: ${sanitize(opportunity.client.name, 80)}`, city: opportunity.client.city, score: priority.score, priorityLevel: priority.level, reason: sanitize(priority.reasons.join("; ") || `Oportunidade em ${opportunity.stage}`), objective: sanitize(priority.nextAction || "Avançar oportunidade"), suggestedPeriod: null, estimatedDurationMinutes: COMMERCIAL_PLANNING_DEFAULTS.durations[type], source: overdueFollow ? "follow_up" : "priority", fixedDate: opportunity.followUpDate >= weekStart && opportunity.followUpDate <= addDays(weekStart, 4) ? followDate : overdueFollow ? dateOnly(weekStart) : null, dedupeKey: `${opportunity.clientId}:${type}` });
    }
    for (const activity of data.activities) {
      const type: ActionType = String(activity.type).includes("whatsapp") ? "whatsapp" : String(activity.type).includes("proposta") ? "proposal" : String(activity.type).includes("visita") ? "visit" : "follow_up";
      candidates.push({ type, clientId: activity.clientId, opportunityId: activity.opportunityId, title: `${type === "visit" ? "Visitar" : "Concluir atividade"}: ${sanitize(activity.client?.name || "cliente", 80)}`, city: activity.city || activity.client?.city || null, score: activity.dueDate < now ? 90 : 55, priorityLevel: activity.dueDate < now ? "urgente" : "alta", reason: activity.dueDate < now ? "Atividade pendente vencida" : "Atividade pendente", objective: sanitize(activity.description || activity.notes || "Concluir atividade aberta"), suggestedPeriod: null, estimatedDurationMinutes: COMMERCIAL_PLANNING_DEFAULTS.durations[type], source: "follow_up", fixedDate: activity.dueDate >= weekStart && activity.dueDate <= addDays(weekStart, 4) ? dateOnly(activity.dueDate) : activity.dueDate < now ? dateOnly(weekStart) : null, dedupeKey: `${activity.clientId || activity.id}:${type}` });
    }
    for (const client of data.inactiveClients) {
      const priority = calculateCommercialPriority({ client: client as any, now });
      candidates.push({ type: "call", clientId: client.id, title: `Reativar cliente: ${sanitize(client.name, 80)}`, city: client.city, score: priority.score, priorityLevel: priority.level, reason: sanitize(priority.reasons.join("; ") || "Cliente sem compra"), objective: "Identificar demanda e recuperar relacionamento", suggestedPeriod: null, estimatedDurationMinutes: COMMERCIAL_PLANNING_DEFAULTS.durations.call, source: "inactive_client", fixedDate: null, dedupeKey: `${client.id}:call` });
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, COMMERCIAL_PLANNING_DEFAULTS.maxCandidates);
  }

  private deduplicate(candidates: Candidate[]) {
    const map = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const current = map.get(candidate.dedupeKey);
      if (!current || candidate.score > current.score || (candidate.fixedDate && !current.fixedDate)) map.set(candidate.dedupeKey, candidate);
    }
    return [...map.values()];
  }

  private distribute(sellerId: string, weekStart: Date, weekEnd: Date, events: Awaited<ReturnType<PlanningIntelligenceService["collectData"]>>["events"], candidates: Candidate[]): WeeklyCommercialPlan {
    const days = Array.from({ length: 5 }, (_, index) => { const date = addDays(weekStart, index); return { date: dateOnly(date), label: labels[date.getUTCDay()], existingAppointments: events.filter((event) => dateOnly(event.startDateTime) === dateOnly(date)).map((event) => ({ id: event.id, title: event.title, type: event.type, startsAt: event.startDateTime.toISOString(), endsAt: event.endDateTime.toISOString(), city: event.city || event.stops.find((s) => s.city)?.city || null, clientId: event.clientId, opportunityId: event.opportunityId })), suggestedActions: [] as Omit<Candidate, "fixedDate" | "dedupeKey">[] }; });
    const state = new Map(days.map((day) => [day.date, { actions: day.existingAppointments.length, visits: day.existingAppointments.filter((a) => a.type === "roteiro_visita" || a.type === "reuniao_presencial").length, cities: new Set(day.existingAppointments.map((a) => a.city).filter(Boolean) as string[]) }]));
    const unallocated: Omit<Candidate, "fixedDate" | "dedupeKey">[] = [];
    for (const candidate of candidates.slice(0, COMMERCIAL_PLANNING_DEFAULTS.maxPlannedActions)) {
      const target = this.pickDay(days, state, candidate);
      if (!target) { unallocated.push(stripInternal(candidate)); continue; }
      const daily = state.get(target.date)!; daily.actions += 1; if (candidate.type === "visit") daily.visits += 1; if (candidate.city) daily.cities.add(candidate.city);
      target.suggestedActions.push({ ...stripInternal(candidate), suggestedPeriod: daily.actions % 2 ? "morning" : "afternoon" });
    }
    const allActions = days.flatMap((d) => d.suggestedActions);
    const visits = allActions.filter((a) => a.type === "visit").length;
    const calls = allActions.filter((a) => a.type === "call" || a.type === "whatsapp").length;
    const proposals = allActions.filter((a) => a.type === "proposal").length;
    const followUps = allActions.filter((a) => a.type === "follow_up").length;
    const capacityStatus = unallocated.length ? "overloaded" : allActions.length < 8 ? "light" : "balanced";
    return { weekStart: dateOnly(weekStart), weekEnd: dateOnly(weekEnd), sellerId, summary: `Plano determinístico com ${allActions.length} ações sugeridas e ${events.length} compromisso(s) já existentes.`, workload: { plannedActions: allActions.length, visits, calls, proposals, followUps, capacityStatus }, days, unallocatedPriorities: unallocated, warnings: ["Cache em memória tem limitação multi-instância/SaaS; Redis fica para evolução futura."], generatedAt: new Date().toISOString(), source: "deterministic" };
  }

  private pickDay(days: WeeklyCommercialPlan["days"], state: Map<string, { actions: number; visits: number; cities: Set<string> }>, candidate: Candidate) {
    const pool = candidate.fixedDate ? days.filter((day) => day.date === candidate.fixedDate) : [...days].sort((a, b) => (candidate.city && state.get(b.date)!.cities.has(candidate.city) ? 1 : 0) - (candidate.city && state.get(a.date)!.cities.has(candidate.city) ? 1 : 0) || state.get(a.date)!.actions - state.get(b.date)!.actions);
    return pool.find((day) => { const s = state.get(day.date)!; return s.actions < COMMERCIAL_PLANNING_DEFAULTS.maxActionsPerDay && (candidate.type !== "visit" || s.visits < COMMERCIAL_PLANNING_DEFAULTS.maxVisitsPerDay); }) || null;
  }

  private async enrichWithAi(base: WeeklyCommercialPlan) {
    const dto = { weekStart: base.weekStart, weekEnd: base.weekEnd, workload: base.workload, days: base.days.map((d) => ({ date: d.date, existingAppointments: d.existingAppointments.length, suggestedActions: d.suggestedActions.map((a) => ({ type: a.type, score: a.score, priorityLevel: a.priorityLevel, reason: a.reason, source: a.source })) })) };
    const response = await aiService.chat({ system: "Você melhora o resumo de um planejamento comercial semanal para um CRM brasileiro. Responda sempre em português do Brasil. Não invente clientes, cidades, compromissos, scores ou datas. Responda JSON com summary e warnings também em português.", messages: [{ role: "user", content: JSON.stringify(dto) }], temperature: 0.2, maxTokens: 600 });
    const parsed = response?.content ? parseAiJsonObject(response.content) : null;
    if (!parsed) return null;
    const valid = aiSchema.safeParse(parsed.parsed);
    return valid.success ? valid.data : null;
  }

  private latestUpdate(data: Awaited<ReturnType<PlanningIntelligenceService["collectData"]>>) {
    const dates = [...data.events.map((e) => e.updatedAt), ...data.opportunities.map((o) => o.createdAt), ...data.activities.map((a) => a.createdAt), ...data.inactiveClients.map((c) => c.createdAt)];
    return dates.sort((a, b) => b.getTime() - a.getTime())[0] || new Date(0);
  }

  private safeMeta(sellerId: string, startedAt: number, candidateCount: number, result: WeeklyCommercialPlan, aiUsed: boolean, fallbackUsed: boolean, cacheHit: boolean) {
    return { sellerId, candidateCount, plannedActionCount: result.workload.plannedActions, visits: result.workload.visits, calls: result.workload.calls, proposals: result.workload.proposals, elapsedMs: Date.now() - startedAt, aiUsed, fallbackUsed, cacheHit, capacityStatus: result.workload.capacityStatus };
  }
}

export const planningIntelligenceService = new PlanningIntelligenceService();
