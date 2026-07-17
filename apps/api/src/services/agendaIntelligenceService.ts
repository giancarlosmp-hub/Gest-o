import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { aiService } from "./ai/aiService.js";
import { calculateCommercialPriority } from "./commercialPriorityService.js";
import { planningIntelligenceService } from "./planningIntelligenceService.js";
import {
  calculateHaversineLineDistanceKm,
  hasValidCoordinates,
} from "./geoHeuristics.js";
import type { Role } from "@prisma/client";

export const AGENDA_INTELLIGENCE_DEFAULTS = {
  cacheTtlMs: 15 * 60 * 1000,
  defaultDurationMinutes: 60,
  maxStopsPerPeriod: 4,
  maxSuggestedInsertions: 2,
} as const;
type PriorityLevel = "baixa" | "normal" | "alta" | "urgente";
type ConflictType =
  | "time_overlap"
  | "distance_risk"
  | "missing_location"
  | "over_capacity"
  | "fixed_commitment";
type Period = "morning" | "afternoon" | null;
export type AgendaOptimizationInput = {
  sellerId?: string;
  date: string;
  viewerUserId: string;
  viewerRole: Role | string;
  refresh?: boolean;
};
type ScheduleItem = {
  agendaEventId: string;
  agendaStopId: string | null;
  clientId: string | null;
  title: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  fixedStartTime: string | null;
  fixedEndTime: string | null;
  currentOrder: number;
  priorityScore: number;
  priorityLevel: PriorityLevel;
  status: string;
  period: Period;
  movable: boolean;
  startMinutes: number | null;
  endMinutes: number | null;
  territoryKey: string | null;
};
export type AgendaOptimization = {
  date: string;
  sellerId: string;
  summary: string;
  currentSchedule: Omit<
    ScheduleItem,
    | "status"
    | "period"
    | "movable"
    | "startMinutes"
    | "endMinutes"
    | "territoryKey"
  >[];
  suggestedOrder: Array<{
    agendaEventId: string;
    agendaStopId: string | null;
    suggestedOrder: number;
    reason: string;
    movable: boolean;
    warning: string | null;
  }>;
  suggestedInsertions: Array<{
    clientId: string;
    opportunityId: string | null;
    actionType: "visit";
    city: string | null;
    priorityScore: number;
    reason: string;
    suggestedPeriod: "morning" | "afternoon";
  }>;
  conflicts: Array<{
    type: ConflictType;
    description: string;
    severity: "low" | "medium" | "high";
  }>;
  metrics: {
    totalStops: number;
    fixedStops: number;
    movableStops: number;
    stopsWithoutLocation: number;
    estimatedDistanceKm: number | null;
    optimizationConfidence: "low" | "medium" | "high";
  };
  source: "deterministic" | "ai";
  generatedAt: string;
};
const cache = new Map<
  string,
  { expiresAt: number; value: AgendaOptimization }
>();
const aiSchema = z.object({
  summary: z.string().trim().min(1).max(900).optional(),
  suggestedOrderReasons: z
    .array(
      z.object({
        agendaEventId: z.string(),
        agendaStopId: z.string().nullable().optional(),
        reason: z.string().max(180),
      }),
    )
    .max(80)
    .optional(),
  conflictNotes: z.array(z.string().max(180)).max(8).optional(),
});
const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
const parseDateOnlyRange = (value: string) => {
  if (!dateOnlyRegex.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0)),
    to: new Date(Date.UTC(year, month - 1, day + 1, 2, 59, 59, 999)),
  };
};
const time = (date: Date | null | undefined) =>
  date
    ? `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
    : null;
const minutes = (date: Date | null | undefined) =>
  date ? date.getUTCHours() * 60 + date.getUTCMinutes() : null;
const periodOf = (m: number | null): Period =>
  m == null ? null : m < 12 * 60 ? "morning" : "afternoon";
const safe = (value: string | null | undefined, max = 160) =>
  (value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contato]")
    .replace(/\b\d{10,}\b/g, "[numero]")
    .slice(0, max);

export class AgendaIntelligenceService {
  async generateAgendaOptimization(
    input: AgendaOptimizationInput,
  ): Promise<AgendaOptimization> {
    const startedAt = Date.now();
    const range = parseDateOnlyRange(input.date);
    if (!range)
      throw Object.assign(
        new Error("Parâmetro date deve estar em YYYY-MM-DD."),
        { statusCode: 400 },
      );
    const sellerId = await this.resolveSeller(input);
    const data = await this.collectData(sellerId, range.from, range.to);
    const lastRelevant = this.latestUpdate(data);
    const scopeKey = `${input.viewerRole}:${input.viewerUserId}:${sellerId}`;
    const cacheKey = [
      "agenda-intelligence",
      sellerId,
      input.date,
      lastRelevant.toISOString(),
      scopeKey,
    ].join(":");
    if (!input.refresh) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        logApiEvent("INFO", "[agenda-intelligence] cache-hit", {
          cacheHit: true,
          sellerId,
        });
        return hit.value;
      }
    }
    const base = await this.buildDeterministic(input.date, sellerId, data);
    let result = base;
    let aiUsed = false;
    let fallbackUsed = true;
    try {
      const ai = await this.enrichWithAi(base);
      if (ai) {
        result = this.applyAi(base, ai);
        aiUsed = true;
        fallbackUsed = false;
      }
    } catch {
      logApiEvent("WARN", "[agenda-intelligence] fallback", {
        sellerId,
        fallbackUsed: true,
      });
    }
    cache.set(cacheKey, {
      expiresAt: Date.now() + AGENDA_INTELLIGENCE_DEFAULTS.cacheTtlMs,
      value: result,
    });
    logApiEvent(
      "INFO",
      fallbackUsed
        ? "[agenda-intelligence] fallback"
        : "[agenda-intelligence] generated",
      this.safeMeta(result, startedAt, aiUsed, fallbackUsed, false),
    );
    return result;
  }
  private async resolveSeller(input: AgendaOptimizationInput) {
    if (input.viewerRole === "vendedor") return input.viewerUserId;
    const sellerId = input.sellerId || input.viewerUserId;
    const seller = await prisma.user.findFirst({
      where: { id: sellerId, role: "vendedor", isActive: true },
      select: { id: true },
    });
    if (!seller)
      throw Object.assign(new Error("Vendedor fora do escopo permitido."), {
        statusCode: 403,
      });
    return seller.id;
  }
  private async collectData(sellerId: string, from: Date, to: Date) {
    const [events, territories] = await Promise.all([
      prisma.agendaEvent.findMany({
        where: {
          sellerId,
          startDateTime: { lte: to },
          endDateTime: { gte: from },
        },
        select: {
          id: true,
          title: true,
          type: true,
          startDateTime: true,
          endDateTime: true,
          status: true,
          city: true,
          clientId: true,
          opportunityId: true,
          updatedAt: true,
          client: {
            select: {
              id: true,
              name: true,
              city: true,
              state: true,
              lastPurchaseDate: true,
              lastPurchaseValue: true,
              ownerSellerId: true,
              financialProfile: true,
              openTitlesTotal: true,
              overdueTitlesTotal: true,
            },
          },
          opportunity: {
            select: {
              id: true,
              value: true,
              stage: true,
              followUpDate: true,
              lastContactAt: true,
              createdAt: true,
            },
          },
          stops: {
            select: {
              id: true,
              order: true,
              clientId: true,
              city: true,
              address: true,
              plannedTime: true,
              checkInAt: true,
              checkInLat: true,
              checkInLng: true,
              checkOutAt: true,
              checkOutLat: true,
              checkOutLng: true,
              resultStatus: true,
              updatedAt: true,
              client: {
                select: {
                  id: true,
                  name: true,
                  city: true,
                  state: true,
                  lastPurchaseDate: true,
                  lastPurchaseValue: true,
                  ownerSellerId: true,
                  financialProfile: true,
                  openTitlesTotal: true,
                  overdueTitlesTotal: true,
                },
              },
            },
          },
        },
        orderBy: { startDateTime: "asc" },
      }),
      prisma.sellerTerritoryCity.findMany({
        where: { sellerId },
        select: { city: true, state: true, updatedAt: true },
      }),
    ]);
    return { events, territories };
  }
  private async buildDeterministic(
    date: string,
    sellerId: string,
    data: Awaited<ReturnType<AgendaIntelligenceService["collectData"]>>,
  ): Promise<AgendaOptimization> {
    const territoryByCity = new Map(
      data.territories.map((t) => [
        t.city.toLowerCase(),
        `${t.state}:${t.city}`,
      ]),
    );
    const items: ScheduleItem[] = [];
    let order = 1;
    for (const event of data.events) {
      const eventPriority = calculateCommercialPriority({
        client: event.client as any,
        opportunity: event.opportunity as any,
      });
      const stops = event.stops.length ? event.stops : [null];
      for (const stop of stops) {
        const client = stop?.client || event.client;
        const priority = client
          ? calculateCommercialPriority({
              client: client as any,
              opportunity: event.opportunity as any,
            })
          : eventPriority;
        const lat = stop?.checkInLat ?? stop?.checkOutLat ?? null;
        const lng = stop?.checkInLng ?? stop?.checkOutLng ?? null;
        const fixedDate = stop?.plannedTime || event.startDateTime;
        const fixed = Boolean(
          stop?.plannedTime || event.type !== "roteiro_visita",
        );
        const status = String(stop?.resultStatus || event.status);
        const start = minutes(fixedDate);
        const end = stop?.plannedTime
          ? start! + AGENDA_INTELLIGENCE_DEFAULTS.defaultDurationMinutes
          : minutes(event.endDateTime);
        const city = stop?.city || client?.city || event.city || null;
        const done = [
          "realizado",
          "completed",
          "cancelled",
          "cancelado",
          "em_andamento",
        ].includes(status);
        items.push({
          agendaEventId: event.id,
          agendaStopId: stop?.id || null,
          clientId: stop?.clientId || event.clientId,
          title: safe(
            stop ? `${event.title} · ${client?.name || "Parada"}` : event.title,
          ),
          city,
          latitude: lat,
          longitude: lng,
          fixedStartTime: fixed ? time(fixedDate) : null,
          fixedEndTime: fixed
            ? stop?.plannedTime
              ? time(
                  new Date(
                    fixedDate.getTime() +
                      AGENDA_INTELLIGENCE_DEFAULTS.defaultDurationMinutes *
                        60000,
                  ),
                )
              : time(event.endDateTime)
            : null,
          currentOrder: order++,
          priorityScore: priority.score,
          priorityLevel: priority.level,
          status,
          period: periodOf(start),
          movable: !fixed && !done,
          startMinutes: fixed ? start : null,
          endMinutes: fixed ? end : null,
          territoryKey: city
            ? territoryByCity.get(city.toLowerCase()) || null
            : null,
        });
      }
    }
    const conflicts = this.detectConflicts(items);
    const suggested = this.orderItems(items);
    const distance = this.estimateDistance(suggested);
    const insertions = await this.suggestInsertions(sellerId, date, items);
    const missing = items.filter((i) => !hasValidCoordinates(i)).length;
    const fixed = items.filter((i) => !i.movable).length;
    const confidence =
      missing === items.length
        ? "low"
        : distance == null || missing
          ? "medium"
          : "high";
    return {
      date,
      sellerId,
      summary: `Análise determinística de ${items.length} visita(s)/compromisso(s); ${fixed} fixo(s) preservado(s), ${items.length - fixed} reordenável(is).`,
      currentSchedule: items.map(
        ({
          status,
          period,
          movable,
          startMinutes,
          endMinutes,
          territoryKey,
          ...publicItem
        }) => publicItem,
      ),
      suggestedOrder: suggested.map((item, index) => ({
        agendaEventId: item.agendaEventId,
        agendaStopId: item.agendaStopId,
        suggestedOrder: index + 1,
        reason: item.movable
          ? this.reason(item)
          : "Compromisso fixo/concluído mantido na posição operacional.",
        movable: item.movable,
        warning: hasValidCoordinates(item)
          ? null
          : "Localização sem coordenadas confiáveis; agrupamento usa cidade/território.",
      })),
      suggestedInsertions: insertions,
      conflicts,
      metrics: {
        totalStops: items.length,
        fixedStops: fixed,
        movableStops: items.length - fixed,
        stopsWithoutLocation: missing,
        estimatedDistanceKm: distance,
        optimizationConfidence: confidence,
      },
      source: "deterministic",
      generatedAt: new Date().toISOString(),
    };
  }
  private orderItems(items: ScheduleItem[]) {
    return [...items].sort(
      (a, b) =>
        (a.startMinutes ?? 9999) - (b.startMinutes ?? 9999) ||
        (a.city || "").localeCompare(b.city || "") ||
        (a.territoryKey || "").localeCompare(b.territoryKey || "") ||
        b.priorityScore - a.priorityScore ||
        a.currentOrder - b.currentOrder,
    );
  }
  private reason(item: ScheduleItem) {
    if (item.city)
      return `Agrupado por cidade/território (${item.city}) e prioridade oficial ${item.priorityLevel}.`;
    return `Ordenado por prioridade oficial ${item.priorityLevel}; localização ausente limita a otimização.`;
  }
  private detectConflicts(
    items: ScheduleItem[],
  ): AgendaOptimization["conflicts"] {
    const conflicts: AgendaOptimization["conflicts"] = [];
    const fixed = items
      .filter((i) => i.startMinutes != null && i.endMinutes != null)
      .sort((a, b) => a.startMinutes! - b.startMinutes!);
    for (let i = 1; i < fixed.length; i++)
      if (fixed[i].startMinutes! < fixed[i - 1].endMinutes!)
        conflicts.push({
          type: "time_overlap",
          description: "Há compromissos com horários sobrepostos.",
          severity: "high",
        });
    for (const item of items)
      if (!hasValidCoordinates(item))
        conflicts.push({
          type: "missing_location",
          description:
            "Uma visita não possui coordenadas confiáveis; distância não será inventada.",
          severity: "medium",
        });
    for (const period of ["morning", "afternoon"] as const)
      if (
        items.filter((i) => i.period === period).length >
        AGENDA_INTELLIGENCE_DEFAULTS.maxStopsPerPeriod
      )
        conflicts.push({
          type: "over_capacity",
          description: `Excesso de visitas no período ${period === "morning" ? "da manhã" : "da tarde"}.`,
          severity: "medium",
        });
    return conflicts;
  }
  private estimateDistance(items: ScheduleItem[]) {
    if (items.length < 2 || items.some((i) => !hasValidCoordinates(i)))
      return null;
    let total = 0;
    for (let i = 1; i < items.length; i++)
      total += calculateHaversineLineDistanceKm(items[i - 1], items[i]) || 0;
    return Math.round(total * 10) / 10;
  }
  private async suggestInsertions(
    sellerId: string,
    date: string,
    items: ScheduleItem[],
  ): Promise<AgendaOptimization["suggestedInsertions"]> {
    const scheduled = new Set(items.map((i) => i.clientId).filter(Boolean));
    const plan = await planningIntelligenceService.generateWeeklyCommercialPlan(
      {
        sellerId,
        weekStart: date,
        viewerUserId: sellerId,
        viewerRole: "diretor",
        refresh: false,
      },
    );
    const routeCities = new Set(items.map((i) => i.city).filter(Boolean));
    return (plan.days.find((d) => d.date === date)?.suggestedActions || [])
      .filter(
        (a) =>
          a.type === "visit" &&
          (a.priorityLevel === "alta" || a.priorityLevel === "urgente") &&
          a.clientId &&
          !scheduled.has(a.clientId) &&
          (!routeCities.size || !a.city || routeCities.has(a.city)),
      )
      .slice(0, AGENDA_INTELLIGENCE_DEFAULTS.maxSuggestedInsertions)
      .map((a) => ({
        clientId: a.clientId!,
        opportunityId: a.opportunityId || null,
        actionType: "visit" as const,
        city: a.city || null,
        priorityScore: a.score,
        reason: a.reason,
        suggestedPeriod: a.suggestedPeriod || "afternoon",
      }));
  }
  private async enrichWithAi(base: AgendaOptimization) {
    const dto = {
      date: base.date,
      metrics: base.metrics,
      currentSchedule: base.currentSchedule.map((i) => ({
        id: i.agendaEventId,
        stopId: i.agendaStopId,
        city: i.city,
        fixedStartTime: i.fixedStartTime,
        priorityLevel: i.priorityLevel,
      })),
      suggestedOrder: base.suggestedOrder,
      conflicts: base.conflicts,
      insertionCount: base.suggestedInsertions.length,
    };
    const response = await aiService.chat({
      system:
        "Melhore o resumo da Agenda Inteligente. Não invente clientes, cidades, horários, quilômetros ou scores. Haversine é linha reta, não rota rodoviária. Responda JSON.",
      messages: [{ role: "user", content: JSON.stringify(dto) }],
      temperature: 0.2,
      maxTokens: 700,
    });
    const parsed = response?.content
      ? parseAiJsonObject(response.content)
      : null;
    if (!parsed) return null;
    const valid = aiSchema.safeParse(parsed.parsed);
    return valid.success ? valid.data : null;
  }
  private applyAi(
    base: AgendaOptimization,
    ai: z.infer<typeof aiSchema>,
  ): AgendaOptimization {
    const reasons = new Map(
      (ai.suggestedOrderReasons || []).map((r) => [
        `${r.agendaEventId}:${r.agendaStopId || ""}`,
        r.reason,
      ]),
    );
    return {
      ...base,
      summary: ai.summary || base.summary,
      suggestedOrder: base.suggestedOrder.map((item) => ({
        ...item,
        reason:
          reasons.get(`${item.agendaEventId}:${item.agendaStopId || ""}`) ||
          item.reason,
      })),
      source: "ai",
      generatedAt: new Date().toISOString(),
    };
  }
  private latestUpdate(
    data: Awaited<ReturnType<AgendaIntelligenceService["collectData"]>>,
  ) {
    const dates = [
      ...data.events.map((e) => e.updatedAt),
      ...data.events.flatMap((e) => e.stops.map((s) => s.updatedAt)),
      ...data.territories.map((t) => t.updatedAt),
    ];
    return dates.sort((a, b) => b.getTime() - a.getTime())[0] || new Date(0);
  }
  private safeMeta(
    result: AgendaOptimization,
    startedAt: number,
    aiUsed: boolean,
    fallbackUsed: boolean,
    cacheHit: boolean,
  ) {
    return {
      stopCount: result.metrics.totalStops,
      fixedStopCount: result.metrics.fixedStops,
      movableStopCount: result.metrics.movableStops,
      insertionCount: result.suggestedInsertions.length,
      conflictCount: result.conflicts.length,
      missingLocationCount: result.metrics.stopsWithoutLocation,
      elapsedMs: Date.now() - startedAt,
      aiUsed,
      fallbackUsed,
      cacheHit,
      confidence: result.metrics.optimizationConfidence,
    };
  }
}
export const agendaIntelligenceService = new AgendaIntelligenceService();
