import express, { Router, type Request } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { validateBody } from "../middlewares/validate.js";
import {
  activityKpiUpsertSchema,
  activitySchema,
  clientContactSchema,
  clientSchema,
  companySchema,
  contactSchema,
  cultureCatalogSchema,
  eventSchema,
  goalSchema,
  objectiveUpsertSchema,
  opportunitySchema,
  userActivationSchema,
  userCreateSchema,
  userResetPasswordSchema,
  userRoleUpdateSchema,
  userUpdateSchema,
  weeklyVisitMinimumSchema
} from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";
import { normalizeCnpj, normalizeState, normalizeText } from "../utils/normalize.js";
import { calculatePipelineMetrics, getWeightedValue, isOpportunityOverdue } from "../utils/pipelineMetrics.js";
import { randomBytes } from "node:crypto";
import { buildTimelineEventWhere } from "./timelineEventWhere.js";
import { ActivityType, ClientType, OpportunityStage, Prisma } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../utils/password.js";
import { calculateOpportunityRisk } from "../services/opportunityInsight.js";
import { generateSalesMessage } from "../services/opportunitySalesMessage.js";
import { buildClientAiContext } from "../services/clientAiContext.js";
import { generateClientSuggestion } from "../services/clientSuggestion.js";
import {
  calculateTodayPriorities,
  generateClientSummary,
  generateOpportunityInsight,
  parseActivityObservation
} from "../services/ai/index.js";

const router = Router();
router.use(authMiddleware);
router.use(appUsageRateLimit);


type CultureGoalRange = { min: number; max: number };

type CultureGoals = Record<string, CultureGoalRange>;

const GOAL_KEY_NORMALIZER = /[^a-z0-9_\-]/g;

const normalizeGoalKey = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(GOAL_KEY_NORMALIZER, "");

const normalizeCulturePayload = (payload: z.infer<typeof cultureCatalogSchema>) => {
  const goals = Object.entries(payload.goalsJson || {}).reduce<CultureGoals>((acc, [goal, range]) => {
    const key = normalizeGoalKey(goal);
    if (!key) return acc;
    const min = Number(range.min);
    const max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw Object.assign(new Error(`Faixa inválida para o objetivo '${goal}'.`), { status: 400 });
    }
    acc[key] = { min, max };
    return acc;
  }, {});

  const tags = (payload.tags || [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);

  if (payload.defaultKgHaMin != null && payload.defaultKgHaMax != null && payload.defaultKgHaMax < payload.defaultKgHaMin) {
    throw Object.assign(new Error("Faixa padrão de kg/ha inválida."), { status: 400 });
  }

  return {
    slug: payload.slug.trim().toLowerCase(),
    label: payload.label.trim(),
    category: payload.category.trim(),
    isActive: payload.isActive ?? true,
    defaultKgHaMin: payload.defaultKgHaMin ?? null,
    defaultKgHaMax: payload.defaultKgHaMax ?? null,
    goalsJson: goals,
    notes: payload.notes?.trim() || null,
    pmsDefault: payload.pmsDefault ?? null,
    germinationDefault: payload.germinationDefault ?? null,
    purityDefault: payload.purityDefault ?? null,
    populationTargetDefault: payload.populationTargetDefault ?? null,
    rowSpacingCmDefault: payload.rowSpacingCmDefault ?? null,
    tags,
  };
};

const cultureQuerySchema = z.object({
  active: z.enum(["true", "false"]).optional(),
  search: z.string().optional(),
  tags: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

type TechnicalCultureCatalogItem = {
  id: string;
  name: string;
  category: string;
  kgHaMin: number | null;
  kgHaMax: number | null;
  pmsDefault: number | null;
  populationDefaultHa: number | null;
  spacingDefaultCm: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  notes?: string;
};

const TECHNICAL_CULTURES_STATIC_SEED: TechnicalCultureCatalogItem[] = [
  {
    id: "sorgo",
    name: "Sorgo",
    category: "Grãos",
    kgHaMin: 8,
    kgHaMax: 18,
    pmsDefault: 28,
    populationDefaultHa: 180000,
    spacingDefaultCm: 45,
    germinationDefault: 85,
    purityDefault: 98,
    notes: "Catálogo técnico seed padrão.",
  },
  {
    id: "milho",
    name: "Milho",
    category: "Grãos",
    kgHaMin: 14,
    kgHaMax: 24,
    pmsDefault: 32,
    populationDefaultHa: 65000,
    spacingDefaultCm: 50,
    germinationDefault: 90,
    purityDefault: 98,
    notes: "Catálogo técnico seed padrão.",
  },
  {
    id: "milheto",
    name: "Milheto",
    category: "Cobertura",
    kgHaMin: 10,
    kgHaMax: 20,
    pmsDefault: 8,
    populationDefaultHa: 250000,
    spacingDefaultCm: 34,
    germinationDefault: 80,
    purityDefault: 95,
    notes: "Catálogo técnico seed padrão.",
  },
];

const serializeTechnicalCultureCatalogItem = (
  item: {
    slug: string;
    label: string;
    category: string;
    defaultKgHaMin: number | null;
    defaultKgHaMax: number | null;
    pmsDefault: number | null;
    populationTargetDefault: number | null;
    rowSpacingCmDefault: number | null;
    germinationDefault: number | null;
    purityDefault: number | null;
    notes: string | null;
  }
): TechnicalCultureCatalogItem => ({
  id: item.slug,
  name: item.label,
  category: item.category,
  kgHaMin: item.defaultKgHaMin,
  kgHaMax: item.defaultKgHaMax,
  pmsDefault: item.pmsDefault,
  populationDefaultHa: item.populationTargetDefault,
  spacingDefaultCm: item.rowSpacingCmDefault,
  germinationDefault: item.germinationDefault,
  purityDefault: item.purityDefault,
  ...(item.notes ? { notes: item.notes } : {}),
});


const CLOSED_STAGE_VALUES = ["ganho", "perdido"] as const;
const CLOSED_STAGES = new Set<string>(CLOSED_STAGE_VALUES);
const STAGE_ALIASES: Record<string, "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido"> = {
  WON: "ganho",
  won: "ganho",
  LOST: "perdido",
  lost: "perdido",
  prospeccao: "prospeccao",
  negociacao: "negociacao",
  proposta: "proposta",
  ganho: "ganho",
  perdido: "perdido"
};
const STAGE_LABELS: Record<"prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido", string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const normalizeDateToUtc = (value: string, endOfDay = false) => {
  const plainDateMatch = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (plainDateMatch) {
    const [year, month, day] = value.split("-").map(Number);
    const utcHour = endOfDay ? 26 : 3;
    const utcMinute = endOfDay ? 59 : 0;
    const utcSecond = endOfDay ? 59 : 0;
    const utcMs = endOfDay ? 999 : 0;
    return endOfDay
      ? new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond, utcMs))
      : new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond, utcMs));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getUtcTodayStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
};

const getLastBusinessDaysWindow = (businessDays: number, referenceDate = new Date()) => {
  const end = new Date(referenceDate);
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  let counted = 0;

  while (counted < businessDays) {
    const weekDay = start.getDay();
    if (weekDay >= 1 && weekDay <= 5) {
      counted += 1;
      if (counted === businessDays) break;
    }
    start.setDate(start.getDate() - 1);
  }

  start.setHours(0, 0, 0, 0);
  return { start, end };
};

const getWeekRangeFromStart = (weekStart: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;

  const start = normalizeDateToUtc(weekStart);
  if (!start) return null;

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  const previousStart = new Date(start);
  previousStart.setUTCDate(start.getUTCDate() - 7);

  const previousEnd = new Date(start);
  previousEnd.setUTCDate(start.getUTCDate() - 1);
  previousEnd.setUTCHours(23, 59, 59, 999);

  return { start, end, previousStart, previousEnd };
};

const normalizeStageInput = (stage?: string) => {
  if (!stage) return undefined;
  const normalized = stage.trim();
  return STAGE_ALIASES[normalized] || STAGE_ALIASES[normalized.toLowerCase()];
};

const getStageFilter = (stage?: string) => normalizeStageInput(stage);
const closedOpportunityEditSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  value: z.coerce.number().finite().nonnegative().optional(),
  crop: z.string().trim().max(100).nullable().optional(),
  season: z.string().trim().max(100).nullable().optional(),
  stage: z.enum(CLOSED_STAGE_VALUES).optional()
}).refine((payload) => Object.keys(payload).length > 0, { message: "Nenhum campo para atualização foi informado." });

type OpportunityStatusFilter = "open" | "closed" | "all";
const getOpportunityStatusFilter = (status?: string): OpportunityStatusFilter | undefined => {
  if (!status) return "open";

  const normalized = status.toLowerCase();
  if (normalized === "abertas") return "open";
  if (normalized === "encerradas") return "closed";
  if (normalized === "todas") return "all";

  if (normalized === "open" || normalized === "closed" || normalized === "all") return normalized;
  return undefined;
};
type OpportunityFilterParams = {
  stage?: OpportunityStage;
  status: OpportunityStatusFilter;
  ownerSellerId?: string;
  clientId?: string;
  search?: string;
  crop?: string;
  season?: string;
  dateRangeWhere?: { gte?: Date; lte?: Date };
  overdueOnly: boolean;
};

const parseOpportunityFilterParams = (req: Request) => {
  const stageQuery = (req.query.stage as string | undefined) || (req.query.etapa as string | undefined);
  const stage = getStageFilter(stageQuery);
  if (stageQuery && !stage) return { error: "stage inválido" } as const;

  const status = getOpportunityStatusFilter(req.query.status as string | undefined);
  if (req.query.status && !status) return { error: "status inválido" } as const;
  const resolvedStatus: OpportunityStatusFilter = status ?? "open";

  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const dateRangeWhere: OpportunityFilterParams["dateRangeWhere"] = {};
  if (dateFrom) {
    const parsed = normalizeDateToUtc(dateFrom, false);
    if (!parsed) return { error: "dateFrom inválido" } as const;
    dateRangeWhere.gte = parsed;
  }
  if (dateTo) {
    const parsed = normalizeDateToUtc(dateTo, true);
    if (!parsed) return { error: "dateTo inválido" } as const;
    dateRangeWhere.lte = parsed;
  }

  return {
    params: {
      stage,
      status: resolvedStatus,
      ownerSellerId: (req.query.ownerId as string | undefined) || (req.query.ownerSellerId as string | undefined),
      clientId: req.query.clientId as string | undefined,
      search: req.query.search as string | undefined,
      crop: req.query.crop as string | undefined,
      season: req.query.season as string | undefined,
      dateRangeWhere: Object.keys(dateRangeWhere).length ? dateRangeWhere : undefined,
      overdueOnly: req.query.overdue === "true" || req.query.overdueOnly === "true" || req.query.somenteAtrasadas === "true"
    } satisfies OpportunityFilterParams
  } as const;
};

const buildOpportunityWhere = (req: Request, params: OpportunityFilterParams, todayStart: Date) => {
  const whereFilters: Prisma.OpportunityWhereInput[] = [sellerWhere(req)];

  if (params.status === "open") whereFilters.push({ stage: { notIn: [...CLOSED_STAGE_VALUES] } });
  if (params.status === "closed") whereFilters.push({ stage: { in: [...CLOSED_STAGE_VALUES] } });
  if (params.stage) whereFilters.push({ stage: params.stage });
  if (params.ownerSellerId) whereFilters.push({ ownerSellerId: params.ownerSellerId });
  if (params.clientId) whereFilters.push({ clientId: params.clientId });
  if (params.crop) whereFilters.push({ crop: params.crop });
  if (params.season) whereFilters.push({ season: params.season });
  if (params.dateRangeWhere) {
    if (params.status === "closed") {
      whereFilters.push({
        OR: [
          { closedAt: params.dateRangeWhere },
          { closedAt: null, expectedCloseDate: params.dateRangeWhere }
        ]
      });
    } else {
      whereFilters.push({ proposalDate: params.dateRangeWhere });
    }
  }
  if (params.overdueOnly) {
    whereFilters.push({
      followUpDate: { lt: todayStart },
      stage: { notIn: [...CLOSED_STAGE_VALUES] }
    });
  }
  if (params.search) {
    whereFilters.push({
      OR: [{ title: { contains: params.search, mode: "insensitive" } }, { client: { name: { contains: params.search, mode: "insensitive" } } }]
    });
  }

  return { AND: whereFilters } satisfies Prisma.OpportunityWhereInput;
};

const getDaysOverdue = (expectedCloseDate: Date, stage: string, todayStart: Date) => {
  if (CLOSED_STAGES.has(stage)) return null;
  if (expectedCloseDate >= todayStart) return null;
  return Math.floor((todayStart.getTime() - expectedCloseDate.getTime()) / 86400000);
};

const toIsoStringOrNull = (value: unknown) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const serializeOpportunity = (opportunity: any, todayStart: Date) => ({
  ...opportunity,
  proposalDate: toIsoStringOrNull(opportunity.proposalDate),
  followUpDate: toIsoStringOrNull(opportunity.followUpDate),
  expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
  closedAt: toIsoStringOrNull(opportunity.closedAt),
  lastContactAt: toIsoStringOrNull(opportunity.lastContactAt),
  plantingForecastDate: toIsoStringOrNull(opportunity.plantingForecastDate),
  createdAt: toIsoStringOrNull(opportunity.createdAt),
  client: opportunity.client?.name,
  clientCity: opportunity.client?.city || null,
  clientState: opportunity.client?.state || null,
  owner: opportunity.ownerSeller?.name,
  daysOverdue: opportunity.expectedCloseDate ? getDaysOverdue(opportunity.expectedCloseDate, opportunity.stage, todayStart) : null,
  weightedValue: getWeightedValue(opportunity.value, opportunity.probability),
  risk: calculateOpportunityRisk(opportunity)
});

const parseObjectivePeriod = (monthQuery?: string, yearQuery?: string) => {
  const now = new Date();
  const month = Number(monthQuery ?? now.getMonth() + 1);
  const year = Number(yearQuery ?? now.getFullYear());

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return null;
  }

  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  return {
    month,
    year,
    monthKey
  };
};

const getMonthKey = (date: Date) => date.toISOString().slice(0, 7);

const BRAZIL_TIMEZONE = "America/Sao_Paulo";

const getBrazilNow = () => {
  const now = new Date();
  const formatted = now.toLocaleString("sv-SE", { timeZone: BRAZIL_TIMEZONE });
  return new Date(`${formatted}Z`);
};

const getMonthRangeFromKey = (monthKey: string) => {
  const [year, month] = monthKey.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
  };
};

const buildWonOpportunityDateRangeFilter = (start: Date, end: Date): Prisma.OpportunityWhereInput => ({
  OR: [
    { closedAt: { gte: start, lte: end } },
    { closedAt: null, expectedCloseDate: { gte: start, lte: end } }
  ]
});

const getWeekRangeFromMonday = (weekStartRaw: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartRaw)) return null;
  const start = normalizeDateToUtc(weekStartRaw);
  if (!start) return null;

  const day = start.getUTCDay();
  if (day !== 1) return null;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(26, 59, 59, 999);

  return { start, end };
};

const getCurrentWeekRangeFromBrazilNow = () => {
  const now = getBrazilNow();
  const start = new Date(now);
  const day = start.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return { start, end };
};

const DEFAULT_WEEKLY_VISIT_GOAL = 25;
const WEEKLY_VISIT_GOAL_KEY = "weeklyVisitGoal";
const APP_CONFIG_CACHE_TTL_MS = 60_000;

const weeklyVisitGoalCache: {
  value: number;
  expiresAt: number;
  pending: Promise<number> | null;
} = {
  value: DEFAULT_WEEKLY_VISIT_GOAL,
  expiresAt: 0,
  pending: null
};

const parseWeeklyVisitGoal = (value: string | null | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEEKLY_VISIT_GOAL;
};

const getWeeklyVisitGoal = async () => {
  const now = Date.now();
  if (weeklyVisitGoalCache.expiresAt > now) {
    return weeklyVisitGoalCache.value;
  }

  if (weeklyVisitGoalCache.pending) {
    return weeklyVisitGoalCache.pending;
  }

  weeklyVisitGoalCache.pending = (async () => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: WEEKLY_VISIT_GOAL_KEY },
        update: {},
        create: { key: WEEKLY_VISIT_GOAL_KEY, value: String(DEFAULT_WEEKLY_VISIT_GOAL) },
        select: { value: true }
      });

      const parsedValue = parseWeeklyVisitGoal(config.value);
      weeklyVisitGoalCache.value = parsedValue;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return parsedValue;
    } catch (error) {
      console.error("[appConfig] Falha ao obter weeklyVisitGoal. Usando fallback padrão.", error);
      weeklyVisitGoalCache.value = DEFAULT_WEEKLY_VISIT_GOAL;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return DEFAULT_WEEKLY_VISIT_GOAL;
    } finally {
      weeklyVisitGoalCache.pending = null;
    }
  })();

  return weeklyVisitGoalCache.pending;
};

const getWeeklyVisitMedal = (visitsDone: number) => {
  if (visitsDone >= 25) return "gold" as const;
  if (visitsDone >= 18) return "silver" as const;
  if (visitsDone >= 12) return "bronze" as const;
  return "none" as const;
};

const ACTIVITY_TYPE_ALIASES: Record<string, ActivityType> = {
  follow_up: "followup",
  envio_proposta: "proposta_enviada"
};

const normalizeActivityType = (type: string): ActivityType => {
  const normalized = ACTIVITY_TYPE_ALIASES[type] ?? type;
  return normalized as ActivityType;
};

const resolveActivityTypeFilters = (...types: string[]) => {
  const normalized = Array.from(new Set(types.map(normalizeActivityType)));
  return normalized.length === 1 ? { type: normalized[0] } : { type: { in: normalized } };
};

const VISIT_TYPES = ["visita", "visita_tecnica"] as const;

const ACTIVITY_EXECUTED_LABEL: Partial<Record<ActivityType, string>> = {
  ligacao: "Ligação realizada",
  visita: "Visita realizada",
  reuniao: "Reunião realizada",
  proposta_enviada: "Envio de proposta realizado",
  followup: "Follow-up realizado",
  follow_up: "Follow-up realizado",
};

const buildActivityExecutedDescription = (activity: {
  type: ActivityType;
  date?: Date | null;
  result?: string | null;
  description?: string | null;
  opportunityId?: string | null;
  opportunityTitle?: string | null;
}) => {
  const baseLabel = ACTIVITY_EXECUTED_LABEL[normalizeActivityType(activity.type)] || "Atividade executada";
  const executedAt = (activity.date || new Date()).toLocaleString("pt-BR", { timeZone: "UTC" });
  const details = [`Executada em ${executedAt} (UTC)`];

  if (activity.result?.trim()) {
    details.push(`Resultado: ${activity.result.trim()}`);
  }

  if (activity.description?.trim()) {
    details.push(`Observações: ${activity.description.trim()}`);
  }

  if (activity.opportunityId) {
    details.push(activity.opportunityTitle ? `Oportunidade vinculada: ${activity.opportunityTitle}` : "Oportunidade vinculada");
  }

  return `${baseLabel}. ${details.join(" | ")}`;
};

const EXECUTION_ACTIVITY_TYPES: ActivityType[] = ["visita", "visita_tecnica", "reuniao", "followup", "follow_up"];

const resolveExecutionActivityDateFilter = (from: Date, to: Date): Prisma.ActivityWhereInput => ({
  date: { gte: from, lte: to }
});

const getActivityCountByTypeInMonth = async (ownerSellerId: string, type: ActivityType, monthKey: string) => {
  const { start, end } = getMonthRangeFromKey(monthKey);
  return prisma.activity.count({
    where: {
      ownerSellerId,
      done: true,
      ...resolveActivityTypeFilters(type),
      ...resolveExecutionActivityDateFilter(start, end)
    }
  });
};

const getLastNMonthKeys = (count: number, referenceDate = new Date()) => {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - index, 1));
    return date.toISOString().slice(0, 7);
  }).reverse();
};

const calculateMean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const calculateStandardDeviation = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = calculateMean(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const assertProbability = (probability: number | null | undefined) => {
  if (probability === null || probability === undefined) return true;
  return probability >= 0 && probability <= 100;
};

const normalizeOpportunityDates = (payload: Record<string, unknown>) => {
  const { proposalEntryDate: _proposalEntryDate, expectedReturnDate: _expectedReturnDate, ...cleanPayload } = payload;
  const proposalDate = cleanPayload.proposalDate || _proposalEntryDate;
  const expectedCloseDate = cleanPayload.expectedCloseDate || _expectedReturnDate;

  return {
    ...cleanPayload,
    ...(proposalDate ? { proposalDate: new Date(new Date(String(proposalDate)).toISOString()) } : {}),
    ...(payload.followUpDate ? { followUpDate: new Date(new Date(String(payload.followUpDate)).toISOString()) } : {}),
    ...(expectedCloseDate ? { expectedCloseDate: new Date(new Date(String(expectedCloseDate)).toISOString()) } : {}),
    ...(payload.plantingForecastDate !== undefined
      ? {
          plantingForecastDate: payload.plantingForecastDate
            ? new Date(new Date(String(payload.plantingForecastDate)).toISOString())
            : null
        }
      : {}),
    ...(payload.lastContactAt !== undefined
      ? { lastContactAt: payload.lastContactAt ? new Date(new Date(String(payload.lastContactAt)).toISOString()) : null }
      : {})
  };
};

const CLIENT_SORT_FIELDS = new Set<keyof Prisma.ClientOrderByWithRelationInput>([
  "name",
  "city",
  "state",
  "region",
  "segment",
  "clientType",
  "createdAt"
]);

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const agendaEventTypeSchema = z.enum(["reuniao_online", "reuniao_presencial", "roteiro_visita", "followup"]);
const agendaEventStatusSchema = z.enum(["planned", "completed", "cancelled"]);

const mapAgendaStatusToDb = (status: "planned" | "completed" | "cancelled") => {
  if (status === "completed") return "realizado" as const;
  if (status === "cancelled") return "vencido" as const;
  return "agendado" as const;
};

const mapAgendaStatusFromDb = (status: string): "planned" | "completed" | "cancelled" => {
  if (status === "realizado") return "completed";
  if (status === "vencido") return "cancelled";
  return "planned";
};

const AGENDA_TIMELINE_LABEL: Record<"reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup", string> = {
  reuniao_online: "Reunião online agendada",
  reuniao_presencial: "Reunião presencial agendada",
  roteiro_visita: "Roteiro de visita planejado",
  followup: "Follow-up agendado"
};

const buildAgendaCreatedDescription = (event: { type: "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup"; title: string }) => {
  const baseLabel = AGENDA_TIMELINE_LABEL[event.type] || "Compromisso agendado";
  return `${baseLabel}: ${event.title}`;
};

const buildAgendaStatusDescription = (
  status: "completed" | "cancelled",
  event: { type: "reuniao_online" | "reuniao_presencial" | "roteiro_visita" | "followup"; title: string }
) => {
  const base = status === "completed" ? "Compromisso concluído" : "Compromisso cancelado";
  return `${base}: ${event.title} (${AGENDA_TIMELINE_LABEL[event.type]})`;
};

const agendaEventCreateSchema = z.object({
  title: z.string().min(2),
  type: agendaEventTypeSchema,
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  ownerId: z.string().optional(),
  ownerSellerId: z.string().optional(),
  sellerId: z.string().optional(),
  clientId: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
  opportunityId: z.string().optional(),
  stops: z
    .array(
      z.object({
        clientId: z.string().optional(),
        city: z.string().optional(),
        address: z.string().optional(),
        plannedTime: z.string().optional(),
        notes: z.string().optional()
      })
    )
    .optional()
});

const agendaEventUpdateSchema = z.object({
  title: z.string().min(2).optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  notes: z.string().optional(),
  city: z.string().optional(),
  status: agendaEventStatusSchema.optional(),
  opportunityId: z.string().optional()
});

const agendaStopCreateSchema = z.object({
  clientId: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  plannedTime: z.string().optional(),
  notes: z.string().optional()
});

const agendaStopReorderSchema = z.object({
  stopIds: z.array(z.string()).min(1)
});

const agendaStopGeoSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().positive().optional(),
  timestamp: z.string().datetime().optional()
});

const agendaStopResultSchema = z.object({
  status: z.enum(["realizada", "nao_realizada"]),
  reason: z.enum(["cliente_ausente", "chuva", "estrada", "reagendar", "outro"]).optional(),
  summary: z.string().max(240).optional(),
  nextStep: z.enum(["criar_followup", "criar_oportunidade", "reagendar"]).optional(),
  nextStepDate: z.string().optional()
});

const parseClientSort = (sortValue?: string): Prisma.ClientOrderByWithRelationInput => {
  if (!sortValue) return { createdAt: "desc" };

  const [rawField, rawDirection] = sortValue.trim().split(/\s+/, 2);
  const field = rawField as keyof Prisma.ClientOrderByWithRelationInput;
  const direction = rawDirection?.toLowerCase() === "asc" ? "asc" : "desc";

  if (!CLIENT_SORT_FIELDS.has(field)) return { createdAt: "desc" };

  return { [field]: direction };
};

const clientExistsBulkItemSchema = z
  .object({
    cnpjDigits: z.string().trim().optional(),
    fallbackKey: z.string().trim().optional()
  })
  .refine((value) => Boolean(value.cnpjDigits || value.fallbackKey), {
    message: "Informe cnpjDigits ou fallbackKey."
  });

const clientExistsBulkRequestSchema = z.object({
  keys: z.array(clientExistsBulkItemSchema).max(5000),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(500).optional()
});

const buildFallbackKey = (name?: string | null, city?: string | null, state?: string | null) => {
  const nameNormalized = normalizeText(name);
  const cityNormalized = normalizeText(city);
  const stateNormalized = normalizeState(state);
  return `${nameNormalized}|${cityNormalized}|${stateNormalized}`;
};

const paginateArray = <T>(items: T[], page: number, pageSize: number) => {
  const total = items.length;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    data: items.slice(start, end),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
};

// ==============================
// ✅ IMPORTAÇÃO DE CLIENTES (dedup + preview + ações)
// ==============================

const DUPLICATE_CLIENT_MESSAGE = "Cliente já cadastrado no sistema.";

const isDatabaseUniqueViolation = (error: unknown) => {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
};

const isDatabaseForeignKeyViolation = (error: unknown) => {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
};

type DuplicateClientMatchType = "cnpj" | "identity";

type DuplicateClientSummary = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  cnpj: string | null;
};

class DuplicateClientError extends Error {
  statusCode: number;
  existingClient: DuplicateClientSummary;
  matchType: DuplicateClientMatchType;

  constructor(existingClient: DuplicateClientSummary, matchType: DuplicateClientMatchType, message?: string) {
    super(message ?? (matchType === "cnpj"
      ? `Já existe um cliente com este CNPJ: ${existingClient.name}${existingClient.city && existingClient.state ? ` (${existingClient.city}/${existingClient.state})` : ""}.`
      : DUPLICATE_CLIENT_MESSAGE));
    this.name = "DuplicateClientError";
    this.statusCode = 409;
    this.existingClient = existingClient;
    this.matchType = matchType;
  }
}

const normalizeClientForComparison = (client: {
  name?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
}) => ({
  nameNormalized: normalizeText(client.name),
  cityNormalized: normalizeText(client.city),
  state: normalizeState(client.state),
  cnpjNormalized: normalizeCnpj(client.cnpj)
});

const findDuplicateClient = async ({
  candidate,
  scope,
  ignoreClientId
}: {
  candidate: { name?: string | null; city?: string | null; state?: string | null; cnpj?: string | null };
  scope: Prisma.ClientWhereInput;
  ignoreClientId?: string;
}) => {
  const normalized = normalizeClientForComparison(candidate);
  const existingClients = await prisma.client.findMany({
    where: {
      ...scope,
      ...(ignoreClientId ? { id: { not: ignoreClientId } } : {})
    },
    select: {
      id: true,
      name: true,
      city: true,
      state: true,
      cnpj: true,
      nameNormalized: true,
      cityNormalized: true,
      cnpjNormalized: true
    }
  });

  if (normalized.cnpjNormalized) {
    const existingByCnpj = existingClients.find((existing) => {
      const existingCnpjNormalized = existing.cnpjNormalized || normalizeCnpj(existing.cnpj);
      return existingCnpjNormalized === normalized.cnpjNormalized;
    });

    if (existingByCnpj) {
      return {
        matchType: "cnpj" as const,
        existingClient: {
          id: existingByCnpj.id,
          name: existingByCnpj.name,
          city: existingByCnpj.city,
          state: existingByCnpj.state,
          cnpj: existingByCnpj.cnpj
        }
      };
    }

    return null;
  }

  const existingByIdentity = existingClients.find((existing) => {
    const existingNameNormalized = existing.nameNormalized || normalizeText(existing.name);
    const existingCityNormalized = existing.cityNormalized || normalizeText(existing.city);
    const existingStateNormalized = normalizeState(existing.state);

    return (
      existingNameNormalized === normalized.nameNormalized &&
      existingCityNormalized === normalized.cityNormalized &&
      existingStateNormalized === normalized.state
    );
  });

  if (!existingByIdentity) return null;

  return {
    matchType: "identity" as const,
    existingClient: {
      id: existingByIdentity.id,
      name: existingByIdentity.name,
      city: existingByIdentity.city,
      state: existingByIdentity.state,
      cnpj: existingByIdentity.cnpj
    }
  };
};

const ensureClientIsNotDuplicate = async (params: {
  candidate: { name?: string | null; city?: string | null; state?: string | null; cnpj?: string | null };
  scope: Prisma.ClientWhereInput;
  ignoreClientId?: string;
}) => {
  const duplicate = await findDuplicateClient(params);
  if (duplicate) throw new DuplicateClientError(duplicate.existingClient, duplicate.matchType);
};

const withClientNormalizedFields = <T extends { name?: string; city?: string; state?: string; cnpj?: string | null }>(payload: T) => {
  const normalized = normalizeClientForComparison(payload);
  return {
    ...payload,
    state: normalized.state,
    nameNormalized: normalized.nameNormalized,
    cityNormalized: normalized.cityNormalized,
    cnpjNormalized: normalized.cnpjNormalized || null
  };
};

const clientImportActionSchema = z.enum(["update", "skip", "import_anyway"]).optional();

const clientImportRowSchema = clientSchema
  .extend({
    sourceRowNumber: z.number().int().positive().optional(),
    existingClientId: z.string().optional(),
    action: clientImportActionSchema,
    code_erp: z.string().optional(),
    codigo_erp: z.string().optional(),
    nome_fantasia: z.string().optional(),
    fantasy_name: z.string().optional(),
    fantasia: z.string().optional(),
    cnpj_cpf: z.string().optional(),
    cnpjCpf: z.string().optional(),
    ownerSellerName: z.string().optional(),
    ownerSeller: z.string().optional(),
    vendedor_responsavel: z.string().optional(),
    vendedor_responsavel_id: z.string().optional(),
    lastPurchaseDate: z.string().optional(),
    last_purchase_date: z.string().optional(),
    lastPurchaseValue: z.union([z.number(), z.string()]).optional(),
    last_purchase_value: z.union([z.number(), z.string()]).optional(),
    erpUpdatedAt: z.string().optional(),
    erp_updated_at: z.string().optional()
  })
  .transform((row) => {
    const ownerFromName = typeof row.ownerSellerName === "string" ? row.ownerSellerName : undefined;
    const ownerFromAlias = typeof row.ownerSeller === "string" ? row.ownerSeller : undefined;
    const ownerFromLabel = typeof row.vendedor_responsavel === "string" ? row.vendedor_responsavel : undefined;
    const ownerFromLegacy = typeof row.vendedor_responsavel_id === "string" ? row.vendedor_responsavel_id : undefined;

    return {
      ...row,
      ownerSellerId: row.ownerSellerId ?? ownerFromName ?? ownerFromAlias ?? ownerFromLabel ?? ownerFromLegacy,
      code: row.code ?? row.code_erp ?? row.codigo_erp,
      fantasyName: row.fantasyName ?? row.nome_fantasia ?? row.fantasy_name ?? row.fantasia,
      cnpj: row.cnpj ?? row.cnpj_cpf ?? row.cnpjCpf,
      lastPurchaseDate: row.lastPurchaseDate ?? row.last_purchase_date,
      lastPurchaseValue: row.lastPurchaseValue ?? row.last_purchase_value,
      erpUpdatedAt: row.erpUpdatedAt ?? row.erp_updated_at
    };
  });

const clientImportRequestSchema = z.object({
  rows: z.array(z.unknown()).optional(),
  clients: z.array(z.unknown()).optional()
});

const resolveImportRows = (body: unknown) => {
  const parsed = clientImportRequestSchema.safeParse(body);
  if (!parsed.success) return { rows: [] as unknown[], isValid: false };
  const rows = parsed.data.rows ?? parsed.data.clients ?? [];
  return { rows, isValid: true };
};

const opportunityImportStageSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ["prospeccao", "negociacao", "proposta", "ganho", "prospecting", "negotiation", "proposal", "won"].includes(value), {
    message: "Etapa inválida para importação."
  });

const opportunityImportStatusSchema = z.enum(["open", "closed"]).optional();

const parseOpportunityImportDate = (value?: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const normalized = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brMatch) {
    const normalized = `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}T00:00:00.000Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const opportunityImportRowSchema = z
  .object({
    title: z.string().min(1),
    clientNameOrId: z.string().min(1),
    value: z.number().positive(),
    stage: opportunityImportStageSchema,
    status: opportunityImportStatusSchema,
    ownerEmail: z.string().email().optional(),
    ownerSellerName: z.string().optional(),
    cnpj: z.string().optional(),
    cnpj_cliente: z.string().optional(),
    documento_cliente: z.string().optional(),
    city: z.string().optional(),
    cidade: z.string().optional(),
    cidade_cliente: z.string().optional(),
    vendedor_responsavel: z.string().optional(),
    email_responsavel: z.string().email().optional(),
    responsavelEmail: z.string().email().optional(),
    followUpDate: z.string().optional(),
    followUp: z.string().optional(),
    proposalDate: z.string().optional(),
    data_entrada: z.string().optional(),
    expectedCloseDate: z.string().optional(),
    fechamento_previsto: z.string().optional(),
    lastContactAt: z.string().optional(),
    ultimo_contato: z.string().optional(),
    probability: z.number().int().min(0).max(100),
    notes: z.string().max(2000).optional(),
    areaHa: z.number().nonnegative().optional(),
    area_ha: z.number().nonnegative().optional(),
    expectedTicketPerHa: z.number().nonnegative().optional(),
    ticket_esperado_ha: z.number().nonnegative().optional(),
    crop: z.string().optional(),
    cultura: z.string().optional(),
    season: z.string().optional(),
    safra: z.string().optional(),
    productOffered: z.string().optional(),
    produto_ofertado: z.string().optional()
  })
  .transform((row) => ({
    ...row,
    ownerEmail: row.ownerEmail ?? row.email_responsavel ?? row.responsavelEmail,
    ownerSellerName: row.ownerSellerName ?? row.vendedor_responsavel,
    cnpj: row.cnpj ?? row.cnpj_cliente ?? row.documento_cliente,
    city: row.city ?? row.cidade ?? row.cidade_cliente,
    followUpDate: row.followUpDate ?? row.followUp,
    proposalDate: row.proposalDate ?? row.data_entrada,
    expectedCloseDate: row.expectedCloseDate ?? row.fechamento_previsto,
    lastContactAt: row.lastContactAt ?? row.ultimo_contato,
    areaHa: row.areaHa ?? row.area_ha,
    expectedTicketPerHa: row.expectedTicketPerHa ?? row.ticket_esperado_ha,
    crop: row.crop ?? row.cultura,
    season: row.season ?? row.safra,
    productOffered: row.productOffered ?? row.produto_ofertado
  }));


const opportunityInsightRequestSchema = z.object({
  opportunityId: z.string().min(1)
});

const opportunityImportPayloadSchema = z.object({
  rows: z.array(z.unknown()).default([]),
  options: z
    .object({
      createClientIfMissing: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      dedupe: z
        .object({
          enabled: z.boolean(),
          windowDays: z.number().int().min(7).max(180),
          compareStatuses: z.enum(["open_only", "open_and_closed"]),
          mode: z.enum(["skip", "upsert"])
        })
        .optional()
    })
    .optional()
});

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IMPORT_STAGE_MAP: Record<string, "prospeccao" | "negociacao" | "proposta" | "ganho"> = {
  prospeccao: "prospeccao",
  prospecting: "prospeccao",
  negociacao: "negociacao",
  negotiation: "negociacao",
  proposta: "proposta",
  proposal: "proposta",
  ganho: "ganho",
  won: "ganho"
};

const DEFAULT_OPPORTUNITY_IMPORT_DEDUPE = {
  enabled: true,
  windowDays: 30,
  compareStatuses: "open_only" as const,
  mode: "skip" as const
};

type OpportunityImportDedupeOptions = {
  enabled: boolean;
  windowDays: number;
  compareStatuses: "open_only" | "open_and_closed";
  mode: "skip" | "upsert";
};

const normalizeOpportunityTitle = (value?: string | null) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeSellerLookup = (value?: string | null) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const normalizeSellerEmail = (value?: string | null) => String(value ?? "").toLowerCase().trim();

const normalizeClientLookup = (value?: string | null) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

type ImportClientCandidate = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  cnpj: string | null;
  normalizedName: string;
  normalizedCity: string;
  normalizedState: string;
  normalizedCnpj: string;
};

const toImportClientCandidate = (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }): ImportClientCandidate => ({
  id: client.id,
  name: client.name,
  city: client.city ?? null,
  state: client.state ?? null,
  cnpj: client.cnpj ?? null,
  normalizedName: normalizeClientLookup(client.name),
  normalizedCity: normalizeClientLookup(client.city),
  normalizedState: normalizeClientLookup(client.state),
  normalizedCnpj: normalizeCnpj(client.cnpj)
});

const resolveClientSmart = (
  input: { clientNameOrId: string; cnpj?: string; city?: string; state?: string },
  clients: ImportClientCandidate[]
) => {
  const rawLookup = input.clientNameOrId.trim();
  const normalizedLookup = normalizeClientLookup(rawLookup);
  const normalizedInputCity = normalizeClientLookup(input.city);
  const normalizedInputState = normalizeClientLookup(input.state);
  const normalizedInputCnpj = normalizeCnpj(input.cnpj);

  if (UUID_V4_REGEX.test(rawLookup)) {
    const uuidMatches = clients.filter((client) => client.id === rawLookup);
    if (uuidMatches.length === 1) return { status: "resolved" as const, client: uuidMatches[0] };
    if (uuidMatches.length > 1) return { status: "ambiguous" as const, candidates: uuidMatches };
    return { status: "not_found" as const };
  }

  if (normalizedInputCnpj) {
    const cnpjMatches = clients.filter((client) => client.normalizedCnpj && client.normalizedCnpj === normalizedInputCnpj);
    if (cnpjMatches.length === 1) return { status: "resolved" as const, client: cnpjMatches[0] };
    if (cnpjMatches.length > 1) return { status: "ambiguous" as const, candidates: cnpjMatches };
    return { status: "not_found" as const };
  }

  const nameMatches = normalizedLookup ? clients.filter((client) => client.normalizedName === normalizedLookup) : [];
  if (normalizedInputCity) {
    const nameAndCityMatches = nameMatches.filter((client) => client.normalizedCity === normalizedInputCity);
    if (nameAndCityMatches.length === 1) return { status: "resolved" as const, client: nameAndCityMatches[0] };
    if (nameAndCityMatches.length > 1) return { status: "ambiguous" as const, candidates: nameAndCityMatches };
  }

  if (normalizedInputState) {
    const nameAndStateMatches = nameMatches.filter((client) => client.normalizedState === normalizedInputState);
    if (nameAndStateMatches.length === 1) return { status: "resolved" as const, client: nameAndStateMatches[0] };
    if (nameAndStateMatches.length > 1) return { status: "ambiguous" as const, candidates: nameAndStateMatches };
  }

  if (!nameMatches.length) return { status: "not_found" as const };
  if (nameMatches.length > 1) return { status: "ambiguous" as const, candidates: nameMatches };
  return { status: "resolved" as const, client: nameMatches[0] };
};

const resolveOpportunityOwner = ({
  ownerEmail,
  ownerSellerName,
  ownersByEmail,
  ownersByName,
  fallbackOwnerId
}: {
  ownerEmail?: string;
  ownerSellerName?: string;
  ownersByEmail: Map<string, { id: string; email: string; name: string }>;
  ownersByName: Map<string, { id: string; email: string; name: string }>;
  fallbackOwnerId: string;
}) => {
  const normalizedEmail = normalizeSellerEmail(ownerEmail);
  const normalizedName = normalizeSellerLookup(ownerSellerName);

  const ownerByEmail = normalizedEmail ? ownersByEmail.get(normalizedEmail) : undefined;
  const ownerByName = normalizedName ? ownersByName.get(normalizedName) : undefined;

  if (ownerByEmail && ownerByName && ownerByEmail.id !== ownerByName.id) {
    return {
      success: false as const,
      message: "conflito entre vendedor_responsavel e email_responsavel (conflito de identificação do vendedor)"
    };
  }

  if (normalizedEmail) {
    if (ownerByEmail) return { success: true as const, ownerSellerId: ownerByEmail.id };
    if (!normalizedName) return { success: false as const, message: "vendedor não encontrado por e-mail" };
  }

  if (normalizedName) {
    if (ownerByName) return { success: true as const, ownerSellerId: ownerByName.id };
    return { success: false as const, message: "vendedor não encontrado por nome" };
  }

  return { success: true as const, ownerSellerId: fallbackOwnerId };
};

const isLikelyOpportunityTitleDuplicate = (candidate: string, existing: string) => {
  if (!candidate || !existing) return false;
  if (candidate === existing) return true;

  const longer = candidate.length >= existing.length ? candidate : existing;
  const shorter = longer === candidate ? existing : candidate;

  if (shorter.length >= 12 && longer.includes(shorter)) return true;
  return false;
};

type ImportPreviewItem =
  | {
      rowNumber: number;
      row: any;
      status: "error";
      error: string;
    }
  | {
      rowNumber: number;
      row: any;
      status: "duplicate";
      existingClientId: string;
      payload: any;
      reason: string;
    }
  | {
      rowNumber: number;
      row: any;
      status: "new";
      payload: any;
    };

const buildDuplicateFingerprint = (payload: { cnpj?: string | null; name?: string | null; city?: string | null; state?: string | null }) => {
  const doc = normalizeCnpj(payload.cnpj);
  if (doc) return `doc:${doc}`;
  const name = normalizeText(payload.name);
  const city = normalizeText(payload.city);
  const uf = normalizeState(payload.state);
  return `n:${name}|c:${city}|s:${uf}`;
};

const normalizeClientCode = (value?: string | null) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const isEmptyValue = (value?: string | null) => !value || !String(value).trim();

const isMeaningfulImportString = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "-";
};

const parseImportOptionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseImportOptionalDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDate) {
    const parsed = new Date(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const brDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brDate) {
    const parsed = new Date(`${brDate[3]}-${brDate[2]}-${brDate[1]}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const resolveImportCreateData = (payload: z.infer<typeof clientImportRowSchema>, req: any) => {
  const ownerSellerId =
    req.user?.role === "vendedor"
      ? req.user.id
      : typeof payload.ownerSellerId === "string" && payload.ownerSellerId.trim()
        ? payload.ownerSellerId.trim()
        : resolveOwnerId(req);

  const fantasyName = payload.fantasyName?.trim();
  const code = payload.code?.trim();
  const lastPurchaseDate = parseImportOptionalDate(payload.lastPurchaseDate);
  const lastPurchaseValue = parseImportOptionalNumber(payload.lastPurchaseValue);
  const erpUpdatedAt = parseImportOptionalDate(payload.erpUpdatedAt);

  const data = {
    name: payload.name.trim(),
    ...(fantasyName ? { fantasyName } : {}),
    ...(code ? { code } : {}),
    city: payload.city.trim(),
    state: payload.state.trim(),
    region: payload.region.trim(),
    ownerSellerId,
    ...(typeof payload.segment === "string" && isMeaningfulImportString(payload.segment) ? { segment: payload.segment.trim() } : {}),
    ...(typeof payload.clientType === "string" && isMeaningfulImportString(payload.clientType)
      ? { clientType: payload.clientType.trim().toUpperCase() as ClientType }
      : {}),
    ...(typeof payload.cnpj === "string" && isMeaningfulImportString(payload.cnpj) ? { cnpj: payload.cnpj.trim() } : {}),
    ...(typeof payload.potentialHa === "number" && Number.isFinite(payload.potentialHa) && payload.potentialHa >= 0
      ? { potentialHa: payload.potentialHa }
      : {}),
    ...(typeof payload.farmSizeHa === "number" && Number.isFinite(payload.farmSizeHa) && payload.farmSizeHa >= 0
      ? { farmSizeHa: payload.farmSizeHa }
      : {}),
    ...(lastPurchaseDate ? { lastPurchaseDate } : {}),
    ...(typeof lastPurchaseValue === "number" ? { lastPurchaseValue } : {}),
    ...(erpUpdatedAt ? { erpUpdatedAt } : {})
  };

  return withClientNormalizedFields(data);
};

const getImportPersistenceErrorMessage = (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return "Cliente duplicado.";
    if (error.code === "P2003") return "Vendedor responsável não encontrado.";
    return `Falha de banco (${error.code}).`;
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return `Dados inválidos para persistência: ${error.message.split("\n")[0] ?? "erro de validação."}`;
  }

  if (error instanceof Error && error.message.trim()) return error.message;
  return "Erro interno ao criar cliente.";
};

const resolveImportUpdateData = (payload: z.infer<typeof clientImportRowSchema>, _req: any, existingClient: any) => {
  const data: Record<string, unknown> = {};
  const fantasyName = payload.fantasyName?.trim();
  const code = payload.code?.trim();

  if (isMeaningfulImportString(payload.city) && isEmptyValue(existingClient.city)) data.city = payload.city.trim();
  if (isMeaningfulImportString(payload.state) && isEmptyValue(existingClient.state)) data.state = payload.state.trim();
  if (isMeaningfulImportString(payload.region) && isEmptyValue(existingClient.region)) data.region = payload.region.trim();
  if (fantasyName && isEmptyValue(existingClient.fantasyName)) data.fantasyName = fantasyName;
  if (code && isEmptyValue(existingClient.code)) data.code = code;
  if (!existingClient.lastPurchaseDate) {
    const parsedLastPurchaseDate = parseImportOptionalDate(payload.lastPurchaseDate);
    if (parsedLastPurchaseDate) data.lastPurchaseDate = parsedLastPurchaseDate;
  }
  if (existingClient.lastPurchaseValue === null || existingClient.lastPurchaseValue === undefined) {
    const parsedLastPurchaseValue = parseImportOptionalNumber(payload.lastPurchaseValue);
    if (typeof parsedLastPurchaseValue === "number") data.lastPurchaseValue = parsedLastPurchaseValue;
  }
  if (!existingClient.erpUpdatedAt) {
    const parsedErpUpdatedAt = parseImportOptionalDate(payload.erpUpdatedAt);
    if (parsedErpUpdatedAt) data.erpUpdatedAt = parsedErpUpdatedAt;
  }

  const mergedClientForValidation = {
    name: existingClient.name,
    city: (data.city as string | undefined) ?? existingClient.city,
    state: (data.state as string | undefined) ?? existingClient.state,
    cnpj: existingClient.cnpj
  };

  const normalized = normalizeClientForComparison(mergedClientForValidation);
  const hasMeaningfulChanges = Object.keys(data).length > 0;

  return {
    data: hasMeaningfulChanges
      ? {
          ...data,
          state: normalized.state,
          nameNormalized: normalized.nameNormalized,
          cityNormalized: normalized.cityNormalized,
          cnpjNormalized: normalized.cnpjNormalized || null
        }
      : {},
    hasMeaningfulChanges,
    mergedClientForValidation
  };
};

const findImportExistingClient = (params: {
  payload: z.infer<typeof clientImportRowSchema>;
  byCnpj: Map<string, any>;
  byCode: Map<string, any>;
}) => {
  const { payload, byCnpj, byCode } = params;
  const normalizedCnpj = normalizeCnpj(payload.cnpj);
  if (normalizedCnpj) {
    const match = byCnpj.get(normalizedCnpj);
    if (match) return { match, reason: "cnpj" as const };
  }

  const normalizedCode = normalizeClientCode(payload.code);
  if (normalizedCode) {
    const match = byCode.get(normalizedCode);
    if (match) return { match, reason: "code" as const };
  }

  return { match: null, reason: null as null };
};

const buildImportPreview = async (req: any, rows: unknown[]): Promise<ImportPreviewItem[]> => {
  const scopedWhere = sellerWhere(req);

  // Carrega o mínimo necessário para deduplicação
  const existingClients = await prisma.client.findMany({
    where: scopedWhere,
    select: { id: true, cnpj: true, code: true, name: true, nameNormalized: true, city: true, state: true }
  });

  // Indexa base por cnpj, código ERP e nome (fallback cuidadoso)
  const existingByDoc = new Map<string, string>();
  const existingByCode = new Map<string, string>();
  const existingByName = new Map<string, string[]>();

  existingClients.forEach((c) => {
    const doc = normalizeCnpj(c.cnpj);
    if (doc) existingByDoc.set(doc, c.id);

    const code = normalizeClientCode(c.code);
    if (code) existingByCode.set(code, c.id);

    const normalizedName = c.nameNormalized || normalizeText(c.name);
    if (!normalizedName) return;
    const bucket = existingByName.get(normalizedName) || [];
    bucket.push(c.id);
    existingByName.set(normalizedName, bucket);
  });

  // Dedup dentro do arquivo
  const fileFingerprintCount = new Map<string, number>();

  const normalizeSellerName = (value?: string | null) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const availableSellers = await prisma.user.findMany({
    where: { role: "vendedor" },
    select: { id: true, name: true }
  });

  const sellersByName = new Map<string, { id: string; name: string }>();
  const sellersById = new Map<string, { id: string; name: string }>();
  availableSellers.forEach((seller) => {
    sellersById.set(seller.id, seller);
    const normalized = normalizeSellerName(seller.name);
    if (!normalized || sellersByName.has(normalized)) return;
    sellersByName.set(normalized, seller);
  });

  // Primeiro passo: valida e resolve ownerSellerId, e computa fingerprints do arquivo
  const prepared = rows.map((row, index) => {
    const parsedRow = clientImportRowSchema.safeParse(row);
    const rowNumber = Number((row as any).sourceRowNumber ?? index + 2);

    if (!parsedRow.success) {
      const message = parsedRow.error.issues[0]?.message ?? "Dados inválidos para importação.";
      return { kind: "error" as const, rowNumber, row, error: message };
    }

    const ownerRaw = String(parsedRow.data.ownerSellerId ?? "").trim();

    let ownerSellerId: string;
    if (req.user!.role === "vendedor") {
      ownerSellerId = req.user!.id;
    } else if (req.user!.role === "gerente" || req.user!.role === "diretor") {
      if (!ownerRaw) {
        ownerSellerId = resolveOwnerId(req);
      } else {
        const sellerByName = sellersByName.get(normalizeSellerName(ownerRaw));
        if (sellerByName) {
          ownerSellerId = resolveOwnerId(req, sellerByName.id);
        } else if (sellersById.has(ownerRaw)) {
          ownerSellerId = resolveOwnerId(req, ownerRaw);
        } else if (UUID_V4_REGEX.test(ownerRaw)) {
          return {
            kind: "error" as const,
            rowNumber,
            row,
            error: `Vendedor responsável não encontrado: ${ownerRaw}`
          };
        } else {
          return {
            kind: "error" as const,
            rowNumber,
            row,
            error: `Vendedor responsável não encontrado: ${ownerRaw}`
          };
        }
      }
    } else {
      ownerSellerId = resolveOwnerId(req);
    }

    const payload = { ...parsedRow.data, ownerSellerId };
    const fp = buildDuplicateFingerprint(payload);

    fileFingerprintCount.set(fp, (fileFingerprintCount.get(fp) || 0) + 1);

    return { kind: "ok" as const, rowNumber, row, payload, fingerprint: fp };
  });

  // Segundo passo: aplica regras de duplicidade
  const items: ImportPreviewItem[] = prepared.map((p) => {
    if (p.kind === "error") {
      return { rowNumber: p.rowNumber, row: p.row, status: "error" as const, error: p.error };
    }

    // Duplicado dentro do arquivo
    if ((fileFingerprintCount.get(p.fingerprint) || 0) > 1) {
      return {
        rowNumber: p.rowNumber,
        row: p.row,
        status: "duplicate" as const,
        existingClientId: "",
        payload: p.payload,
        reason: "Duplicado dentro do arquivo"
      };
    }

    const doc = normalizeCnpj(p.payload.cnpj);
    const code = normalizeClientCode(p.payload.code);
    const normalizedName = normalizeText(p.payload.name);

    const matchedByCnpj = doc ? existingByDoc.get(doc) : null;
    const matchedByCode = !matchedByCnpj && code ? existingByCode.get(code) : null;
    const nameCandidates = !matchedByCnpj && !matchedByCode && normalizedName ? existingByName.get(normalizedName) || [] : [];
    const matchedByName = nameCandidates.length === 1 ? nameCandidates[0] : null;

    const existingId = matchedByCnpj || matchedByCode || matchedByName;
    if (existingId) {
      const reason = matchedByCnpj
        ? "Cliente já existe (CNPJ)"
        : matchedByCode
          ? "Cliente já existe (código ERP)"
          : "Cliente já existe (nome)";

      return {
        rowNumber: p.rowNumber,
        row: p.row,
        status: "duplicate" as const,
        existingClientId: existingId,
        payload: p.payload,
        reason
      };
    }

    return { rowNumber: p.rowNumber, row: p.row, status: "new" as const, payload: p.payload };
  });

  // Para duplicado no arquivo, tentamos inferir existingClientId se também bater na base (opcional)
  // (não é obrigatório para o frontend funcionar; update exige existingClientId, então a UI deve evitar update nesses casos)
  return items;
};

// ==============================
// Timeline helper
// ==============================

const createEvent = async ({
  type = "comentario",
  description,
  opportunityId,
  clientId,
  ownerSellerId
}: {
  type?: "comentario" | "mudanca_etapa" | "status";
  description: string;
  opportunityId?: string;
  clientId?: string;
  ownerSellerId: string;
}) => {
  const normalizedDescription = description.trim();
  if (!normalizedDescription) return null;

  const relatedOpportunityId = opportunityId || undefined;
  let relatedClientId = clientId || undefined;

  if (!relatedClientId && relatedOpportunityId) {
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: relatedOpportunityId },
      select: { clientId: true }
    });
    relatedClientId = opportunity?.clientId;
  }

  return prisma.timelineEvent.create({
    data: {
      type,
      description: normalizedDescription,
      opportunityId: relatedOpportunityId,
      clientId: relatedClientId,
      ownerSellerId
    }
  });
};

const validateDateOrder = (proposalDate?: string, expectedCloseDate?: string) => {
  if (!proposalDate || !expectedCloseDate) return true;
  const proposal = normalizeDateToUtc(proposalDate);
  const expected = normalizeDateToUtc(expectedCloseDate);
  if (!proposal || !expected) return true;
  return expected >= proposal;
};

type OpportunityImportSkippedReason =
  | "duplicate"
  | "duplicate_file"
  | "client_missing"
  | "client_ambiguous"
  | "owner_missing"
  | "owner_conflict"
  | "invalid_row"
  | "invalid_stage"
  | "invalid_status"
  | "invalid_date"
  | "forbidden_owner"
  | "unexpected_error";

type OpportunityImportRowResult = {
  row: number;
  status: "created" | "updated" | "ignored" | "error";
  reason?: OpportunityImportSkippedReason;
  message?: string;
  matchedId?: string;
  matchedTitle?: string;
  matchedClientName?: string;
  matchedCreatedAt?: string;
};

const OPPORTUNITY_IMPORT_BATCH_SIZE = 50;

const buildOpportunityImportReportCsv = (rowResults: OpportunityImportRowResult[]) => {
  const escapeCsv = (value: unknown) => {
    const text = String(value ?? "");
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [
    ["row", "status", "reason", "message", "matchedId", "matchedTitle", "matchedClientName", "matchedCreatedAt"].join(",")
  ];

  for (const row of rowResults) {
    lines.push(
      [
        row.row,
        row.status,
        row.reason ?? "",
        row.message ?? "",
        row.matchedId ?? "",
        row.matchedTitle ?? "",
        row.matchedClientName ?? "",
        row.matchedCreatedAt ?? ""
      ]
        .map(escapeCsv)
        .join(",")
    );
  }

  return lines.join("\n");
};

const processOpportunityImport = async ({
  req,
  rows,
  createClientIfMissing,
  dryRun,
  dedupe
}: {
  req: any;
  rows: unknown[];
  createClientIfMissing: boolean;
  dryRun: boolean;
  dedupe: OpportunityImportDedupeOptions;
}) => {
  const errors: Array<{ row: number; message: string }> = [];
  const rowResults: OpportunityImportRowResult[] = [];
  const skippedDetails: Array<{ row: number; reason: OpportunityImportSkippedReason; matchedId?: string; matchedTitle?: string; matchedClientName?: string; matchedCreatedAt?: string }> = [];
  let created = 0;
  let updated = 0;
  let ignored = 0;
  let failed = 0;

  const parsedRows = rows.map((rawRow, index) => ({ rowNumber: index + 1, parsed: opportunityImportRowSchema.safeParse(rawRow) }));

  const ownerEmails = new Set<string>();
  const ownerNames = new Set<string>();
  const clientIds = new Set<string>();
  const clientNames = new Set<string>();
  const duplicateFileKeySeen = new Set<string>();

  for (const item of parsedRows) {
    if (!item.parsed.success) continue;
    const row = item.parsed.data;

    const email = normalizeSellerEmail(row.ownerEmail);
    const name = normalizeSellerLookup(row.ownerSellerName);
    if (email) ownerEmails.add(email);
    if (name) ownerNames.add(name);

    const clientLookup = row.clientNameOrId.trim();
    if (UUID_V4_REGEX.test(clientLookup)) clientIds.add(clientLookup);
    else clientNames.add(clientLookup);
  }

  const ownersByEmail = new Map<string, { id: string; email: string; name: string }>();
  const ownersByName = new Map<string, { id: string; email: string; name: string }>();

  if (ownerEmails.size || ownerNames.size) {
    const users = await prisma.user.findMany({
      where: { role: "vendedor" },
      select: { id: true, email: true, name: true }
    });

    for (const owner of users) {
      ownersByEmail.set(normalizeSellerEmail(owner.email), owner);
      ownersByName.set(normalizeSellerLookup(owner.name), owner);
    }
  }

  const clientsById = new Map<string, ImportClientCandidate>();
  const clientCandidates: ImportClientCandidate[] = [];
  const upsertClientCandidate = (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }) => {
    const candidate = toImportClientCandidate(client);
    if (clientsById.has(candidate.id)) {
      clientsById.set(candidate.id, candidate);
      const existingIndex = clientCandidates.findIndex((item) => item.id === candidate.id);
      if (existingIndex >= 0) clientCandidates[existingIndex] = candidate;
      return;
    }
    clientsById.set(candidate.id, candidate);
    clientCandidates.push(candidate);
  };

  if (clientIds.size || clientNames.size) {
    const clients = await prisma.client.findMany({
      where: {
        ...sellerWhere(req),
        ...(clientIds.size && !clientNames.size ? { id: { in: Array.from(clientIds) } } : {})
      },
      select: { id: true, name: true, city: true, state: true, cnpj: true }
    });

    for (const client of clients) {
      upsertClientCandidate(client);
    }
  }

  const dedupeCandidatesCache = new Map<string, Array<{ id: string; title: string; createdAt: Date; ownerSellerId: string; client: { name: string } }>>();
  const previewCreatedClientsCache = new Map<string, ImportClientCandidate>();
  const logClientResolution = (
    rowNumber: number,
    rowInput: { clientNameOrId: string; cnpj?: string; city?: string; state?: string },
    resolution: ReturnType<typeof resolveClientSmart>
  ) => {
    console.info("[opportunities/import][client-resolver]", {
      phase: dryRun ? "preview" : "import",
      rowNumber,
      clientNameOrId: rowInput.clientNameOrId,
      cnpj: rowInput.cnpj,
      city: rowInput.city,
      state: rowInput.state,
      matchesCount: resolution.status === "ambiguous" ? resolution.candidates.length : resolution.status === "resolved" ? 1 : 0,
      resolvedClientId: resolution.status === "resolved" ? resolution.client.id : undefined,
      resolvedClientName: resolution.status === "resolved" ? resolution.client.name : undefined
    });
  };
  const validatedRows = parsedRows.filter(
    (item): item is { rowNumber: number; parsed: { success: true; data: z.infer<typeof opportunityImportRowSchema> } } => item.parsed.success
  );

  for (const item of parsedRows) {
    if (item.parsed.success) continue;
    const message = item.parsed.error.issues[0]?.message ?? "Linha inválida para importação.";
    failed += 1;
    errors.push({ row: item.rowNumber, message });
    skippedDetails.push({ row: item.rowNumber, reason: "invalid_row" });
    rowResults.push({ row: item.rowNumber, status: "error", reason: "invalid_row", message });
  }

  for (let batchStart = 0; batchStart < validatedRows.length; batchStart += OPPORTUNITY_IMPORT_BATCH_SIZE) {
    const batch = validatedRows.slice(batchStart, batchStart + OPPORTUNITY_IMPORT_BATCH_SIZE);

    for (const item of batch) {
      const rowNumber = item.rowNumber;
      const row = item.parsed.data;

      try {
        const ownerEmail = normalizeSellerEmail(row.ownerEmail);
        const ownerSellerName = normalizeSellerLookup(row.ownerSellerName);

        if (req.user?.role === "vendedor" && ownerEmail && ownerEmail !== req.user.email.toLowerCase()) {
          const message = "Vendedor só pode importar para o próprio e-mail ou sem ownerEmail.";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "forbidden_owner" });
          rowResults.push({ row: rowNumber, status: "error", reason: "forbidden_owner", message });
          continue;
        }

        const resolvedOwner = resolveOpportunityOwner({
          ownerEmail,
          ownerSellerName,
          ownersByEmail,
          ownersByName,
          fallbackOwnerId: req.user!.id
        });

        if (!resolvedOwner.success) {
          const reason = resolvedOwner.message.includes("conflito") ? "owner_conflict" : "owner_missing";
          failed += 1;
          errors.push({ row: rowNumber, message: resolvedOwner.message });
          skippedDetails.push({ row: rowNumber, reason });
          rowResults.push({ row: rowNumber, status: "error", reason, message: resolvedOwner.message });
          continue;
        }

        const ownerSellerId = resolvedOwner.ownerSellerId;
        const clientLookup = row.clientNameOrId.trim();
        const isUuid = UUID_V4_REGEX.test(clientLookup);
        const stageValue = row.stage ?? "prospeccao";
        const stage = IMPORT_STAGE_MAP[stageValue];

        if (!stage) {
          const message = "etapa inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_stage" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_stage", message });
          continue;
        }

        if (row.status && !["open", "closed"].includes(row.status)) {
          const message = "status inválido";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_status" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_status", message });
          continue;
        }

        const parsedFollowUpDate = parseOpportunityImportDate(row.followUpDate);
        const parsedProposalDate = parseOpportunityImportDate(row.proposalDate);
        const parsedExpectedCloseDate = parseOpportunityImportDate(row.expectedCloseDate);
        const parsedLastContactAt = parseOpportunityImportDate(row.lastContactAt);

        if ((row.followUpDate && !parsedFollowUpDate) || (row.proposalDate && !parsedProposalDate) || (row.expectedCloseDate && !parsedExpectedCloseDate) || (row.lastContactAt && !parsedLastContactAt)) {
          const message = "data inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_date" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_date", message });
          continue;
        }

        const followUpDate = parsedFollowUpDate ?? new Date();
        const proposalDate = parsedProposalDate ?? followUpDate;
        const expectedCloseDate = parsedExpectedCloseDate ?? followUpDate;
        const lastContactAt = parsedLastContactAt ?? undefined;

        if (!validateDateOrder(proposalDate.toISOString(), expectedCloseDate.toISOString())) {
          const message = "data inválida";
          failed += 1;
          errors.push({ row: rowNumber, message });
          skippedDetails.push({ row: rowNumber, reason: "invalid_date" });
          rowResults.push({ row: rowNumber, status: "error", reason: "invalid_date", message });
          continue;
        }

        const shouldPersist = !dryRun;
        const rowExecutionResult = await prisma.$transaction(async (tx) => {
          const resolverInput = { clientNameOrId: clientLookup, cnpj: row.cnpj, city: row.city };
          const resolvedClient = resolveClientSmart(resolverInput, clientCandidates);
          logClientResolution(rowNumber, resolverInput, resolvedClient);

          let client = resolvedClient.status === "resolved" ? resolvedClient.client : undefined;

          if (!client && resolvedClient.status !== "ambiguous") {
            const normalizedLookup = normalizeClientLookup(clientLookup);
            const normalizedCity = normalizeClientLookup(row.city);
            const normalizedCnpj = normalizeCnpj(row.cnpj);
            const existingClient = await tx.client.findFirst({
              where: {
                ...sellerWhere(req),
                ...(isUuid
                  ? { id: clientLookup }
                  : normalizedCnpj
                    ? { cnpjNormalized: normalizedCnpj }
                    : {
                        nameNormalized: normalizedLookup,
                        ...(normalizedCity ? { cityNormalized: normalizedCity } : {})
                      })
              },
              select: { id: true, name: true, city: true, state: true, cnpj: true }
            });

            if (existingClient) {
              upsertClientCandidate(existingClient);
              client = clientsById.get(existingClient.id);
            }
          }

          if (resolvedClient.status === "ambiguous") {
            return { outcome: "error", reason: "client_ambiguous", message: "cliente ambíguo" } as const;
          }

          if (!client && createClientIfMissing) {
            if (shouldPersist) {
              const createdClient = await tx.client.create({
                data: {
                  name: clientLookup,
                  city: "N/A",
                  state: "NA",
                  region: "Importação",
                  ownerSellerId
                },
                select: { id: true, name: true, city: true, state: true, cnpj: true }
              });
              upsertClientCandidate(createdClient);
              client = clientsById.get(createdClient.id);
            } else {
              const previewClientKey = [normalizeClientLookup(clientLookup), normalizeCnpj(row.cnpj), normalizeClientLookup(row.city)].join("|");
              if (!previewCreatedClientsCache.has(previewClientKey)) {
                const previewClient = toImportClientCandidate({
                  id: `preview-client-${previewCreatedClientsCache.size + 1}`,
                  name: clientLookup,
                  city: row.city ?? "N/A",
                  cnpj: row.cnpj
                });
                previewCreatedClientsCache.set(previewClientKey, previewClient);
                upsertClientCandidate(previewClient);
              }
              client = previewCreatedClientsCache.get(previewClientKey);
            }
          }

          if (!client) {
            return { outcome: "error", reason: "client_missing", message: "cliente não encontrado" } as const;
          }

          const normalizedTitle = normalizeOpportunityTitle(row.title);
          const duplicateFileKey = [client.id, normalizedTitle, stage, ownerSellerId].join("|");
          if (duplicateFileKeySeen.has(duplicateFileKey)) {
            return { outcome: "ignored", reason: "duplicate_file", message: "linha duplicada no arquivo" } as const;
          }

          let duplicateOpportunity: {
            id: string;
            title: string;
            createdAt: Date;
            client: { name: string };
            ownerSellerId: string;
          } | null = null;

          if (dedupe.enabled) {
            const cacheKey = `${client.id}|${ownerSellerId}|${stage}`;
            if (!dedupeCandidatesCache.has(cacheKey)) {
              const createdAtStart = new Date();
              createdAtStart.setDate(createdAtStart.getDate() - dedupe.windowDays);

              const candidates = await tx.opportunity.findMany({
                where: {
                  ...sellerWhere(req),
                  clientId: client.id,
                  ownerSellerId,
                  stage,
                  createdAt: { gte: createdAtStart },
                  ...(dedupe.compareStatuses === "open_only" ? { stage: { notIn: ["ganho", "perdido"] as OpportunityStage[] } } : {})
                },
                orderBy: { createdAt: "desc" },
                select: {
                  id: true,
                  title: true,
                  createdAt: true,
                  ownerSellerId: true,
                  client: { select: { name: true } }
                }
              });
              dedupeCandidatesCache.set(cacheKey, candidates);
            }

            const duplicateCandidates = dedupeCandidatesCache.get(cacheKey) ?? [];
            duplicateOpportunity = duplicateCandidates.find((candidate) => normalizeOpportunityTitle(candidate.title) === normalizedTitle) ?? null;
          }

          if (dedupe.enabled && duplicateOpportunity && dedupe.mode === "skip") {
            return {
              outcome: "ignored",
              reason: "duplicate",
              message: "duplicada no sistema",
              matchedId: duplicateOpportunity.id,
              matchedTitle: duplicateOpportunity.title,
              matchedClientName: duplicateOpportunity.client.name,
              matchedCreatedAt: duplicateOpportunity.createdAt.toISOString()
            } as const;
          }

          if (dedupe.enabled && duplicateOpportunity && dedupe.mode === "upsert") {
            if (shouldPersist) {
              const existingOpportunity = await tx.opportunity.findFirst({
                where: {
                  id: duplicateOpportunity.id,
                  ...sellerWhere(req)
                },
                select: { id: true, notes: true, ownerSellerId: true }
              });

              if (!existingOpportunity) throw new Error("Oportunidade duplicada não encontrada para atualização.");

              const notesWithTimestamp = row.notes
                ? `${existingOpportunity.notes ? `${existingOpportunity.notes}

` : ""}[Import ${new Date().toISOString()}] ${row.notes}`
                : existingOpportunity.notes;

              await tx.opportunity.update({
                where: { id: existingOpportunity.id },
                data: {
                  ...(typeof row.value === "number" ? { value: row.value } : {}),
                  ...(stage ? { stage } : {}),
                  ...(typeof row.probability === "number" ? { probability: row.probability } : {}),
                  ...(followUpDate ? { followUpDate } : {}),
                  ...(proposalDate ? { proposalDate } : {}),
                  ...(expectedCloseDate ? { expectedCloseDate } : {}),
                  ...(lastContactAt ? { lastContactAt } : {}),
                  ...(typeof row.areaHa === "number" ? { areaHa: row.areaHa } : {}),
                  ...(typeof row.expectedTicketPerHa === "number" ? { expectedTicketPerHa: row.expectedTicketPerHa } : {}),
                  ...(row.crop ? { crop: row.crop } : {}),
                  ...(row.season ? { season: row.season } : {}),
                  ...(row.productOffered ? { productOffered: row.productOffered } : {}),
                  ...(notesWithTimestamp !== undefined ? { notes: notesWithTimestamp } : {}),
                  ...(req.user?.role !== "vendedor" || existingOpportunity.ownerSellerId === req.user.id ? { ownerSellerId } : {})
                }
              });
            }

            return { outcome: "updated" } as const;
          }

          if (shouldPersist) {
            await tx.opportunity.create({
              data: {
                title: row.title,
                value: row.value,
                stage,
                probability: row.probability,
                notes: row.notes,
                proposalDate,
                followUpDate,
                expectedCloseDate,
                ...(lastContactAt ? { lastContactAt } : {}),
                ...(typeof row.areaHa === "number" ? { areaHa: row.areaHa } : {}),
                ...(typeof row.expectedTicketPerHa === "number" ? { expectedTicketPerHa: row.expectedTicketPerHa } : {}),
                ...(row.crop ? { crop: row.crop } : {}),
                ...(row.season ? { season: row.season } : {}),
                ...(row.productOffered ? { productOffered: row.productOffered } : {}),
                clientId: client.id,
                ownerSellerId
              }
            });
          }

          return { outcome: "created" } as const;
        });

        if (rowExecutionResult.outcome === "error") {
          failed += 1;
          errors.push({ row: rowNumber, message: rowExecutionResult.message });
          skippedDetails.push({ row: rowNumber, reason: rowExecutionResult.reason });
          rowResults.push({ row: rowNumber, status: "error", reason: rowExecutionResult.reason, message: rowExecutionResult.message });
          continue;
        }

        if (rowExecutionResult.outcome === "ignored") {
          ignored += 1;
          skippedDetails.push({
            row: rowNumber,
            reason: rowExecutionResult.reason,
            matchedId: rowExecutionResult.matchedId,
            matchedTitle: rowExecutionResult.matchedTitle,
            matchedClientName: rowExecutionResult.matchedClientName,
            matchedCreatedAt: rowExecutionResult.matchedCreatedAt
          });
          rowResults.push({
            row: rowNumber,
            status: "ignored",
            reason: rowExecutionResult.reason,
            message: rowExecutionResult.message,
            matchedId: rowExecutionResult.matchedId,
            matchedTitle: rowExecutionResult.matchedTitle,
            matchedClientName: rowExecutionResult.matchedClientName,
            matchedCreatedAt: rowExecutionResult.matchedCreatedAt
          });
          continue;
        }

        if (rowExecutionResult.outcome === "updated") {
          updated += 1;
          rowResults.push({ row: rowNumber, status: "updated" });
          continue;
        }

        created += 1;
        rowResults.push({ row: rowNumber, status: "created" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado na linha";
        failed += 1;
        errors.push({ row: rowNumber, message });
        skippedDetails.push({ row: rowNumber, reason: "unexpected_error" });
        rowResults.push({ row: rowNumber, status: "error", reason: "unexpected_error", message });
        console.warn(`[opportunities/import] linha ${rowNumber}: ${message}`);
      }
    }
  }

  const summary = {
    totalRows: rows.length,
    totalProcessed: created + updated + ignored + failed,
    imported: created,
    created,
    updated,
    ignored,
    failed
  };
  const reportCsv = buildOpportunityImportReportCsv(rowResults);

  return {
    created,
    updated,
    ignored,
    skipped: ignored + failed,
    failed,
    errors,
    skippedDetails,
    rowResults,
    summary,
    report: {
      fileName: `opportunities-import-report-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
      mimeType: "text/csv",
      content: reportCsv
    }
  };
};

// ==============================
// ROUTES
// ==============================

router.get("/reports/agro-crm", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });

  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(
    req,
    {
      ...parsedFilters.params,
      status: "open"
    },
    todayStart
  );

  const opportunities = await prisma.opportunity.findMany({
    where,
    include: {
      client: {
        select: {
          id: true,
          name: true,
          potentialHa: true,
          farmSizeHa: true
        }
      },
      ownerSeller: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  const byCrop: Record<string, { value: number; weighted: number; count: number }> = {};
  const bySeason: Record<string, { value: number; weighted: number; count: number }> = {};
  const overdueBySeller: Record<
    string,
    { sellerId: string; sellerName: string; overdueCount: number; overdueValue: number }
  > = {};
  const byClient: Record<
    string,
    { clientId: string; clientName: string; weightedValue: number; value: number; opportunities: number }
  > = {};
  const byStage: Record<string, number> = {};
  const plantingWindow: Record<
    string,
    { month: string; opportunities: number; weightedValue: number; pipelineValue: number }
  > = {};
  const portfolioByPotential: Record<
    string,
    { clientId: string; clientName: string; potentialHa: number; farmSizeHa: number; opportunities: number; weightedValue: number }
  > = {};

  for (const opportunity of opportunities) {
    const weightedValue = getWeightedValue(opportunity.value, opportunity.probability);
    const cropKey = opportunity.crop || "não informado";
    const seasonKey = opportunity.season || "não informado";
    const stageKey = opportunity.stage;

    if (!byCrop[cropKey]) byCrop[cropKey] = { value: 0, weighted: 0, count: 0 };
    byCrop[cropKey].value += opportunity.value;
    byCrop[cropKey].weighted += weightedValue;
    byCrop[cropKey].count += 1;

    if (!bySeason[seasonKey]) bySeason[seasonKey] = { value: 0, weighted: 0, count: 0 };
    bySeason[seasonKey].value += opportunity.value;
    bySeason[seasonKey].weighted += weightedValue;
    bySeason[seasonKey].count += 1;

    byStage[stageKey] = (byStage[stageKey] || 0) + 1;

    const clientId = opportunity.client.id;
    if (!byClient[clientId]) {
      byClient[clientId] = {
        clientId,
        clientName: opportunity.client.name,
        weightedValue: 0,
        value: 0,
        opportunities: 0
      };
    }
    byClient[clientId].weightedValue += weightedValue;
    byClient[clientId].value += opportunity.value;
    byClient[clientId].opportunities += 1;

    if (!portfolioByPotential[clientId]) {
      portfolioByPotential[clientId] = {
        clientId,
        clientName: opportunity.client.name,
        potentialHa: Number(opportunity.client.potentialHa || 0),
        farmSizeHa: Number(opportunity.client.farmSizeHa || 0),
        opportunities: 0,
        weightedValue: 0
      };
    }
    portfolioByPotential[clientId].opportunities += 1;
    portfolioByPotential[clientId].weightedValue += weightedValue;

    if (opportunity.plantingForecastDate) {
      const month = opportunity.plantingForecastDate.toISOString().slice(0, 7);
      if (!plantingWindow[month]) {
        plantingWindow[month] = { month, opportunities: 0, weightedValue: 0, pipelineValue: 0 };
      }
      plantingWindow[month].opportunities += 1;
      plantingWindow[month].weightedValue += weightedValue;
      plantingWindow[month].pipelineValue += opportunity.value;
    }

    const isOverdue = isOpportunityOverdue(opportunity, todayStart);
    if (isOverdue) {
      const sellerId = opportunity.ownerSeller.id;
      if (!overdueBySeller[sellerId]) {
        overdueBySeller[sellerId] = {
          sellerId,
          sellerName: opportunity.ownerSeller.name,
          overdueCount: 0,
          overdueValue: 0
        };
      }
      overdueBySeller[sellerId].overdueCount += 1;
      overdueBySeller[sellerId].overdueValue += opportunity.value;
    }
  }

  const pipelineMetrics = calculatePipelineMetrics(opportunities, todayStart);

  const orderedStages = ["prospeccao", "negociacao", "proposta"];
  const stageConversion = orderedStages.slice(0, -1).map((stage, index) => {
    const nextStage = orderedStages[index + 1];
    const currentCount = byStage[stage] || 0;
    const nextCount = byStage[nextStage] || 0;
    return {
      fromStage: stage,
      toStage: nextStage,
      baseCount: currentCount,
      progressedCount: nextCount,
      conversionRate: currentCount > 0 ? (nextCount / currentCount) * 100 : 0
    };
  });

  res.json({
    summary: {
      pipelineTotal: pipelineMetrics.pipelineTotal,
      weightedTotal: pipelineMetrics.weightedTotal,
      overdueCount: pipelineMetrics.overdueCount,
      overdueValue: pipelineMetrics.overdueValue
    },
    kpis: {
      pipelineByCrop: Object.entries(byCrop)
        .map(([crop, values]) => ({ crop, ...values }))
        .sort((a, b) => b.weighted - a.weighted),
      pipelineBySeason: Object.entries(bySeason)
        .map(([season, values]) => ({ season, ...values }))
        .sort((a, b) => b.weighted - a.weighted),
      topClientsByWeightedValue: Object.values(byClient)
        .sort((a, b) => b.weightedValue - a.weightedValue)
        .slice(0, 10),
      overdueBySeller: Object.values(overdueBySeller).sort((a, b) => b.overdueCount - a.overdueCount),
      stageConversion
    },
    tables: {
      portfolioByPotentialHa: Object.values(portfolioByPotential)
        .map((row) => ({
          ...row,
          potentialCoveragePercent: row.farmSizeHa > 0 ? (row.potentialHa / row.farmSizeHa) * 100 : 0
        }))
        .sort((a, b) => b.potentialHa - a.potentialHa),
      opportunitiesByPlantingWindow: Object.values(plantingWindow).sort((a, b) => a.month.localeCompare(b.month))
    }
  });
});

router.get("/reports/planned-vs-realized", async (req, res) => {
  const fromRaw = req.query.from as string | undefined;
  const toRaw = req.query.to as string | undefined;
  const sellerIdRaw = req.query.sellerId as string | undefined;

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ message: "Parâmetros from e to são obrigatórios." });
  }

  const from = normalizeDateToUtc(fromRaw);
  const to = normalizeDateToUtc(toRaw, true);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw;

  const [sellers, plannedEvents, executedActivities, followUps] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.findMany({
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: from, lte: to },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      select: {
        sellerId: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("visita", "reuniao", "followup", "follow_up"),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: {
        ownerSellerId: true,
        opportunityId: true,
        type: true,
        dueDate: true,
        createdAt: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("followup", "follow_up"),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: { ownerSellerId: true }
    })
  ]);

  const plannedBySeller = plannedEvents.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = (acc[item.sellerId] || 0) + 1;
    return acc;
  }, {});

  const executedBySeller = executedActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpsBySeller = followUps.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const opportunitiesBySeller = executedActivities.reduce<Record<string, Set<string>>>((acc, item) => {
    if (!item.opportunityId) return acc;
    if (!acc[item.ownerSellerId]) acc[item.ownerSellerId] = new Set<string>();
    acc[item.ownerSellerId].add(item.opportunityId);
    return acc;
  }, {});

  const sellerStatsMap = sellers.reduce<
    Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        planned: number;
        executed: number;
        punctualCount: number;
      }
    >
  >((acc, seller) => {
    acc[seller.id] = {
      sellerId: seller.id,
      sellerName: seller.name,
      planned: plannedBySeller[seller.id] || 0,
      executed: executedBySeller[seller.id] || 0,
      punctualCount: executedBySeller[seller.id] || 0
    };
    return acc;
  }, {});

  const sellerRows = Object.values(sellerStatsMap).map((stats) => {
    const notExecuted = Math.max(stats.planned - stats.executed, 0);
    const followUpsCount = followUpsBySeller[stats.sellerId] || 0;
    const opportunitiesCount = opportunitiesBySeller[stats.sellerId]?.size || 0;
    const executionRate = stats.planned ? (stats.executed / stats.planned) * 100 : 0;
    const punctualRate = stats.executed ? (stats.punctualCount / stats.executed) * 100 : 0;

    return {
      sellerId: stats.sellerId,
      sellerName: stats.sellerName,
      planned: stats.planned,
      executed: stats.executed,
      notExecuted,
      executionRate,
      punctualRate,
      followUps: followUpsCount,
      opportunities: opportunitiesCount
    };
  });

  const totalPlanned = sellerRows.reduce((sum, item) => sum + item.planned, 0);
  const totalExecuted = sellerRows.reduce((sum, item) => sum + item.executed, 0);
  const totalNotExecuted = sellerRows.reduce((sum, item) => sum + item.notExecuted, 0);
  const totalPunctual = sellerRows.reduce((sum, item) => sum + (item.punctualRate / 100) * item.executed, 0);
  const followUpGenerated = sellerRows.reduce((sum, item) => sum + item.followUps, 0);
  const opportunitiesGenerated = sellerRows.reduce((sum, item) => sum + item.opportunities, 0);

  return res.json({
    totalPlanned,
    totalExecuted,
    totalNotExecuted,
    executionRate: totalPlanned ? (totalExecuted / totalPlanned) * 100 : 0,
    punctualRate: totalExecuted ? (totalPunctual / totalExecuted) * 100 : 0,
    followUpGenerated,
    opportunitiesGenerated,
    sellers: sellerRows.sort((a, b) => b.executionRate - a.executionRate)
  });
});

router.get("/reports/weekly-discipline", async (req, res) => {
  const range = getCurrentWeekRangeFromBrazilNow();
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : undefined;
  const [minimumRequired, sellers, visitsBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        type: "visita",
        done: true,
        date: { gte: range.start, lte: range.end }
      },
      _count: { _all: true }
    })
  ]);

  const executedMap = visitsBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._count._all;
    return acc;
  }, {});

  return res.json(
    sellers.map((seller) => {
      const executed = executedMap[seller.id] || 0;
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        planned: executed,
        executed,
        minimumRequired,
        belowMinimum: executed < minimumRequired
      };
    })
  );
});


router.get("/reports/weekly-visits", async (req, res) => {
  const weekStart = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromMonday(weekStart);

  if (!range) {
    return res.status(400).json({ message: "weekStart deve estar no formato YYYY-MM-DD e ser uma segunda-feira." });
  }

  const canViewAll = req.user!.role === "diretor" || req.user!.role === "gerente";
  const [goal, sellers, visitsBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        type: "visita",
        done: true,
        dueDate: { gte: range.start, lte: range.end }
      },
      _count: { _all: true }
    })
  ]);

  const visitsMap = visitsBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._count._all;
    return acc;
  }, {});

  const ranking = sellers
    .map((seller) => {
      const visitsDone = visitsMap[seller.id] || 0;
      return {
        userId: seller.id,
        name: seller.name,
        visitsDone,
        goal,
        medal: getWeeklyVisitMedal(visitsDone),
        missing: Math.max(goal - visitsDone, 0)
      };
    })
    .sort((a, b) => b.visitsDone - a.visitsDone || a.name.localeCompare(b.name, "pt-BR"));

  if (canViewAll) {
    return res.json(ranking);
  }

  const top3 = ranking.slice(0, 3);
  const own = ranking.find((item) => item.userId === req.user!.id);

  if (!own) {
    return res.json(top3);
  }

  const sellerView = new Map(top3.map((item) => [item.userId, item]));
  sellerView.set(own.userId, own);
  return res.json(Array.from(sellerView.values()));
});

router.get("/reports/weekly-missions", async (req, res) => {
  const weekStart = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromMonday(weekStart);

  if (!range) {
    return res.status(400).json({ message: "weekStart deve estar no formato YYYY-MM-DD e ser uma segunda-feira." });
  }

  const isManagerView = req.user!.role === "diretor" || req.user!.role === "gerente";
  const [visitGoal, sellers, visitsBySeller, followUpsBySeller, proposalsBySeller, overdueOpportunitiesBySeller] = await Promise.all([
    getWeeklyVisitGoal(),
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("visita"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("followup", "follow_up"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...resolveActivityTypeFilters("proposta_enviada", "envio_proposta"),
        done: true,
        ...resolveExecutionActivityDateFilter(range.start, range.end)
      },
      _count: { _all: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: { notIn: ["ganho", "perdido"] },
        expectedCloseDate: { lt: new Date() }
      },
      _count: { _all: true }
    })
  ]);

  const toCountMap = <T extends string>(rows: { _count: { _all: number } }[], key: T) =>
    rows.reduce<Record<string, number>>((acc, item) => {
      const ownerId = (item as Record<T, string>)[key];
      acc[ownerId] = item._count._all;
      return acc;
    }, {});

  const visitsMap = toCountMap(visitsBySeller, "ownerSellerId");
  const followUpsMap = toCountMap(followUpsBySeller, "ownerSellerId");
  const proposalsMap = toCountMap(proposalsBySeller, "ownerSellerId");
  const overdueMap = toCountMap(overdueOpportunitiesBySeller, "ownerSellerId");

  const ranking = sellers
    .map((seller) => {
      const visitsDone = visitsMap[seller.id] || 0;
      const followUpsDone = followUpsMap[seller.id] || 0;
      const proposalsDone = proposalsMap[seller.id] || 0;
      const overdueCount = overdueMap[seller.id] || 0;

      return {
        userId: seller.id,
        name: seller.name,
        missions: [
          {
            key: "visits_25",
            title: "25 visitas na semana",
            progress: visitsDone,
            target: visitGoal,
            done: visitsDone >= visitGoal,
            medal: getWeeklyVisitMedal(visitsDone)
          },
          {
            key: "followups_5",
            title: "5 follow-ups concluídos",
            progress: followUpsDone,
            target: 5,
            done: followUpsDone >= 5
          },
          {
            key: "proposals_2",
            title: "2 propostas enviadas",
            progress: proposalsDone,
            target: 2,
            done: proposalsDone >= 2
          },
          {
            key: "overdue_0",
            title: "0 oportunidades atrasadas",
            progress: overdueCount,
            target: 0,
            done: overdueCount === 0
          }
        ]
      };
    })
    .sort((a, b) => {
      const visitsA = a.missions[0]?.progress ?? 0;
      const visitsB = b.missions[0]?.progress ?? 0;
      return visitsB - visitsA || a.name.localeCompare(b.name, "pt-BR");
    });

  if (isManagerView) {
    return res.json(ranking);
  }

  const own = ranking.find((item) => item.userId === req.user!.id);
  const top3MainMissionOnly = ranking.slice(0, 3).map((item) => ({
    userId: item.userId,
    name: item.name,
    missions: [item.missions[0]]
  }));

  if (!own) {
    return res.json(top3MainMissionOnly);
  }

  const sellerView = new Map(top3MainMissionOnly.map((item) => [item.userId, item]));
  sellerView.set(own.userId, own);
  return res.json(Array.from(sellerView.values()));
});

router.get("/reports/discipline-ranking", async (req, res) => {
  const fromRaw = req.query.from as string | undefined;
  const toRaw = req.query.to as string | undefined;
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ message: "Parâmetros from e to são obrigatórios." });
  }

  const from = normalizeDateToUtc(fromRaw);
  const to = normalizeDateToUtc(toRaw, true);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw || undefined;
  const inactivityWindow = getLastBusinessDaysWindow(3);
  const weeklyVisitGoal = await getWeeklyVisitGoal();

  const [sellers, plannedBySellerRows, executedActivities, recentExecutionRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: from, lte: to },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    }),
    prisma.activity.findMany({
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters(...EXECUTION_ACTIVITY_TYPES),
        ...resolveExecutionActivityDateFilter(from, to)
      },
      select: {
        ownerSellerId: true,
        opportunityId: true,
        type: true,
        date: true
      }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
        done: true,
        ...resolveActivityTypeFilters("visita", "visita_tecnica", "reuniao"),
        ...resolveExecutionActivityDateFilter(inactivityWindow.start, inactivityWindow.end)
      },
      _count: { _all: true }
    })
  ]);

  const plannedBySeller = plannedBySellerRows.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  const activeSellersInWindow = new Set(recentExecutionRows.filter((item) => item._count._all > 0).map((item) => item.ownerSellerId));

  const followUpsIndex = executedActivities
    .filter((item) => normalizeActivityType(item.type) === "followup" && item.opportunityId)
    .reduce<Record<string, Date[]>>((acc, item) => {
      const key = `${item.ownerSellerId}:${item.opportunityId}`;
      if (!acc[key]) acc[key] = [];
      if (item.date) {
        acc[key].push(item.date);
      }
      return acc;
    }, {});

  const statsBySeller = sellers.reduce<
    Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        planned: number;
        executed: number;
        punctual: number;
        followUpAfterVisit: number;
      }
    >
  >((acc, seller) => {
    acc[seller.id] = {
      sellerId: seller.id,
      sellerName: seller.name,
      planned: plannedBySeller[seller.id] || 0,
      executed: 0,
      punctual: 0,
      followUpAfterVisit: 0
    };
    return acc;
  }, {});

  for (const activity of executedActivities) {
    const sellerStats = statsBySeller[activity.ownerSellerId];
    if (!sellerStats) continue;
    sellerStats.executed += 1;
    sellerStats.punctual += 1;

    const normalizedType = normalizeActivityType(activity.type);
    if ((normalizedType === "visita" || normalizedType === "visita_tecnica" || normalizedType === "reuniao") && activity.opportunityId) {
      if (!activity.date) continue;
      const key = `${activity.ownerSellerId}:${activity.opportunityId}`;
      const executionDate = activity.date;
      const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= executionDate.getTime());
      if (hasFollowUpAfterVisit) {
        sellerStats.followUpAfterVisit += 1;
      }
    }
  }

  const ranking = Object.values(statsBySeller)
    .map((stats) => {
      const executionRate = stats.planned ? (stats.executed / stats.planned) * 100 : stats.executed > 0 ? 100 : 0;
      const punctualRate = stats.executed ? (stats.punctual / stats.executed) * 100 : 0;
      const followUpRate = stats.executed ? (stats.followUpAfterVisit / stats.executed) * 100 : 0;
      const baseDisciplineScore = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const isUnderExecutionThreshold = executionRate < 60;
      const hasInactivityFlag = !activeSellersInWindow.has(stats.sellerId);
      const disciplineScoreBase = isUnderExecutionThreshold ? baseDisciplineScore * 0.9 : baseDisciplineScore;
      const volumeFactor = stats.planned < weeklyVisitGoal ? stats.planned / weeklyVisitGoal : 1;
      const disciplineScoreFinal = disciplineScoreBase * volumeFactor;

      return {
        sellerId: stats.sellerId,
        sellerName: stats.sellerName,
        planned: stats.planned,
        executed: stats.executed,
        executionRate,
        punctualRate,
        followUpRate,
        disciplineScoreBase,
        volumeFactor,
        disciplineScoreFinal,
        disciplineScore: disciplineScoreFinal,
        isUnderExecutionThreshold,
        hasInactivityFlag
      };
    })
    .sort((a, b) => b.disciplineScoreFinal - a.disciplineScoreFinal);

  return res.json(ranking);
});

router.get("/reports/score-monthly", async (req, res) => {
  const month = String(req.query.month || "").trim();
  const userIdFilter = typeof req.query.userId === "string" ? req.query.userId.trim() : "";

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const role = req.user?.role;
  if (role !== "diretor" && role !== "gerente" && role !== "vendedor") {
    return res.status(403).json({ message: "Perfil sem permissão para consultar score mensal." });
  }

  if (role === "vendedor" && userIdFilter) {
    return res.status(403).json({ message: "Filtro userId não permitido para perfil vendedor." });
  }

  const { start, end } = getMonthRangeFromKey(month);

  const [sellers, monthSales, monthGoals, monthPipeline] = await Promise.all([
    prisma.user.findMany({
      where: { role: "vendedor", isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...buildWonOpportunityDateRangeFilter(start, end)
      },
      _sum: { value: true }
    }),
    prisma.goal.findMany({
      where: { month },
      select: { sellerId: true, targetValue: true }
    }),
    prisma.opportunity.findMany({
      where: {
        createdAt: { gte: start, lte: end }
      },
      select: {
        ownerSellerId: true,
        value: true,
        probability: true
      }
    })
  ]);

  const salesBySeller = monthSales.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._sum.value ?? 0;
    return acc;
  }, {});

  const goalsBySeller = monthGoals.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item.targetValue ?? 0;
    return acc;
  }, {});

  const weightedPipelineBySeller = monthPipeline.reduce<Record<string, number>>((acc, item) => {
    const weightedValue = item.value * ((item.probability ?? 0) / 100);
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + weightedValue;
    return acc;
  }, {});

  const maxFaturado = Math.max(...sellers.map((seller) => salesBySeller[seller.id] || 0), 1);
  const maxPipeline = Math.max(...sellers.map((seller) => weightedPipelineBySeller[seller.id] || 0), 1);

  const rankedItems = sellers
    .map((seller) => {
      const faturadoMes = salesBySeller[seller.id] || 0;
      const objetivoMes = goalsBySeller[seller.id] || 0;
      const pipelinePonderado = weightedPipelineBySeller[seller.id] || 0;
      const atingimentoPercent = objetivoMes > 0 ? (faturadoMes / objetivoMes) * 100 : 0;

      const faturadoNormalizado = (faturadoMes / maxFaturado) * 1000;
      const pipelineNormalizado = (pipelinePonderado / maxPipeline) * 1000;
      const atingimentoRatio = Math.max(atingimentoPercent, 0) / 100;

      const score = faturadoNormalizado * 1.0 + atingimentoRatio * 1000 + pipelineNormalizado * 0.1;

      return {
        userId: seller.id,
        name: seller.name,
        role: seller.role,
        faturadoMes: Number(faturadoMes.toFixed(2)),
        objetivoMes: Number(objetivoMes.toFixed(2)),
        atingimentoPercent: Number(atingimentoPercent.toFixed(2)),
        pipelinePonderado: Number(pipelinePonderado.toFixed(2)),
        score: Number(score.toFixed(2))
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.pipelinePonderado !== a.pipelinePonderado) return b.pipelinePonderado - a.pipelinePonderado;
      if (b.faturadoMes !== a.faturadoMes) return b.faturadoMes - a.faturadoMes;
      return a.name.localeCompare(b.name, "pt-BR");
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1
    }));

  if (role === "vendedor") {
    const me = rankedItems.find((item) => item.userId === req.user!.id);
    const topThree = rankedItems.slice(0, 3);

    const items = me && !topThree.some((item) => item.userId === me.userId) ? [...topThree, me] : topThree;

    return res.json({ month, items });
  }

  if (userIdFilter) {
    return res.json({ month, items: rankedItems.filter((item) => item.userId === userIdFilter) });
  }

  return res.json({ month, items: rankedItems });
});

router.get("/reports/weekly-highlights", async (req, res) => {
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : sellerIdRaw || undefined;
  const range = getCurrentWeekRangeFromBrazilNow();
  const previousStart = new Date(range.start);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  const previousEnd = new Date(range.end);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 7);

  const weeklyVisitGoal = await getWeeklyVisitGoal();

  const [sellers, currentWonOpportunities, previousWonOpportunities, visitActivities, followUpActivities, opportunitiesCreated] = await Promise.all([
    prisma.user.findMany({
      where: { role: "vendedor", ...(scopedSellerId ? { id: scopedSellerId } : {}) },
      select: { id: true, name: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...sellerWhere(req),
        ...buildWonOpportunityDateRangeFilter(range.start, range.end)
      },
      _sum: { value: true }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...sellerWhere(req),
        ...buildWonOpportunityDateRangeFilter(previousStart, previousEnd)
      },
      _sum: { value: true }
    }),
    prisma.activity.findMany({
      where: {
        ...sellerWhere(req),
        done: true,
        type: "visita",
        date: { gte: range.start, lte: range.end }
      },
      select: {
        ownerSellerId: true,
        opportunityId: true
      }
    }),
    prisma.activity.findMany({
      where: {
        ...sellerWhere(req),
        done: true,
        ...resolveActivityTypeFilters("followup", "follow_up"),
        date: { gte: range.start, lte: range.end }
      },
      select: {
        ownerSellerId: true
      }
    }),
    prisma.opportunity.findMany({
      where: { createdAt: { gte: range.start, lte: range.end } },
      select: { ownerSellerId: true }
    })
  ]);

  const currentSalesMap = currentWonOpportunities.reduce<Record<string, number>>((acc, row) => {
    if (!row.ownerSellerId) return acc;
    acc[row.ownerSellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const previousSalesMap = previousWonOpportunities.reduce<Record<string, number>>((acc, row) => {
    if (!row.ownerSellerId) return acc;
    acc[row.ownerSellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const opportunitiesCreatedMap = opportunitiesCreated.reduce<Record<string, number>>((acc, row) => {
    acc[row.ownerSellerId] = (acc[row.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const executedBySeller = visitActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpsBySeller = followUpActivities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const topByMetric = <T extends { metricValue: number }>(rows: T[]) => {
    if (rows.length === 0) return null;
    return rows.reduce((best, row) => (row.metricValue > best.metricValue ? row : best));
  };

  const bestResult = topByMetric(
    sellers.map((seller) => ({
      sellerId: seller.id,
      sellerName: seller.name,
      metricLabel: "Valor vendido na semana",
      metricValue: currentSalesMap[seller.id] || 0,
      medal: "🏆"
    }))
  );

  const bestEvolution = topByMetric(
    sellers.map((seller) => {
      const current = currentSalesMap[seller.id] || 0;
      const previous = previousSalesMap[seller.id] || 0;
      const growthPercent = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Crescimento vs semana anterior (%)",
        metricValue: growthPercent,
        medal: "📈"
      };
    })
  );

  const bestExecutor = topByMetric(
    sellers.map((seller) => {
      const executed = executedBySeller[seller.id] || 0;
      const followUps = followUpsBySeller[seller.id] || 0;
      const followUpRate = executed > 0 ? (followUps / executed) * 100 : 0;
      const volumeFactor = executed < weeklyVisitGoal ? executed / weeklyVisitGoal : 1;
      const metricValue = (followUpRate * 0.4 + Math.min(executed, weeklyVisitGoal) / weeklyVisitGoal * 100 * 0.6) * volumeFactor;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Disciplina de execução da semana",
        metricValue,
        medal: "🥇"
      };
    })
  );

  const bestConversion = topByMetric(
    sellers.map((seller) => {
      const created = opportunitiesCreatedMap[seller.id] || 0;
      const executed = executedBySeller[seller.id] || 0;
      const conversionRate = executed > 0 ? (created / executed) * 100 : 0;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Oportunidades criadas / atividades executadas (%)",
        metricValue: conversionRate,
        medal: "🎯"
      };
    })
  );

  return res.json({
    bestResult: bestResult ? { ...bestResult, avatarUrl: null } : null,
    bestEvolution: bestEvolution ? { ...bestEvolution, avatarUrl: null } : null,
    bestExecutor: bestExecutor ? { ...bestExecutor, avatarUrl: null } : null,
    bestConversion: bestConversion ? { ...bestConversion, avatarUrl: null } : null
  });
});

router.get("/reports/commercial-score", async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const scopedSellerId = undefined;
  const { start, end } = getMonthRangeFromKey(month);
  const stageOrder: Record<string, number> = {
    prospeccao: 0,
    negociacao: 1,
    proposta: 2,
    ganho: 3,
    perdido: 3
  };

  const [sellers, plannedEvents, openOpportunities, createdOpportunitiesInMonth, stageChanges, monthSales, monthGoals] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "vendedor",
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: start, lte: end },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    }),
    prisma.opportunity.findMany({
      where: {
        stage: { notIn: ["ganho", "perdido"] },
        createdAt: { lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        id: true,
        ownerSellerId: true,
        followUpDate: true
      }
    }),
    prisma.opportunity.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        ownerSellerId: true
      }
    }),
    prisma.timelineEvent.findMany({
      where: {
        type: "mudanca_etapa",
        createdAt: { gte: start, lte: end },
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
      },
      select: {
        ownerSellerId: true,
        description: true
      }
    }),
    prisma.opportunity.groupBy({
      by: ["ownerSellerId"],
      where: {
        stage: "ganho",
        ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {}),
        ...buildWonOpportunityDateRangeFilter(start, end)
      },
      _sum: { value: true }
    }),
    prisma.goal.findMany({
      where: {
        month,
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      select: {
        sellerId: true,
        targetValue: true
      }
    })
  ]);

  const plannedBySeller = plannedEvents.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  const executionActivities = await prisma.activity.findMany({
    where: {
      ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : sellerWhere(req)),
      done: true,
      ...resolveActivityTypeFilters(...EXECUTION_ACTIVITY_TYPES),
      ...resolveExecutionActivityDateFilter(start, end)
    },
    select: {
      ownerSellerId: true,
      opportunityId: true,
      type: true,
      createdAt: true,
      dueDate: true,
      date: true
    }
  });

  const followUpsIndex = executionActivities
    .filter((item) => normalizeActivityType(item.type) === "followup" && item.opportunityId)
    .reduce<Record<string, Date[]>>((acc, item) => {
      if (!item.opportunityId) return acc;
      const key = `${item.ownerSellerId}:${item.opportunityId}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(item.date || item.createdAt || item.dueDate);
      return acc;
    }, {});

  const disciplineBySeller = sellers.reduce<Record<string, { planned: number; executed: number; punctual: number; followUpAfterVisit: number }>>(
    (acc, seller) => {
      acc[seller.id] = { planned: plannedBySeller[seller.id] || 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      return acc;
    },
    {}
  );

  for (const activity of executionActivities) {
    if (!disciplineBySeller[activity.ownerSellerId]) {
      disciplineBySeller[activity.ownerSellerId] = { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
    }

    const sellerStats = disciplineBySeller[activity.ownerSellerId];
    sellerStats.executed += 1;
    sellerStats.punctual += 1;

    const normalizedType = normalizeActivityType(activity.type);
    if ((normalizedType === "visita" || normalizedType === "reuniao") && activity.opportunityId) {
      const key = `${activity.ownerSellerId}:${activity.opportunityId}`;
      const executionDate = activity.date || activity.createdAt || activity.dueDate;
      const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= executionDate.getTime());
      if (hasFollowUpAfterVisit) {
        sellerStats.followUpAfterVisit += 1;
      }
    }
  }

  const referenceDate = end.getTime() > Date.now() ? new Date() : end;

  const openOppCountBySeller = openOpportunities.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpOnTimeBySeller = openOpportunities.reduce<Record<string, number>>((acc, item) => {
    if (item.followUpDate.getTime() >= referenceDate.getTime()) {
      acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    }
    return acc;
  }, {});

  const stageAdvanceBySeller = stageChanges.reduce<Record<string, { total: number; advanced: number }>>((acc, item) => {
    const match = item.description.match(/de\s+(.+?)\s+para\s+(.+)$/i);
    const fromLabel = match?.[1]?.trim() || "";
    const toLabel = match?.[2]?.trim() || "";
    const labelToStage: Record<string, keyof typeof stageOrder> = {
      Prospecção: "prospeccao",
      Negociação: "negociacao",
      Proposta: "proposta",
      Ganho: "ganho",
      Perdido: "perdido"
    };
    const fromStage = labelToStage[fromLabel];
    const toStage = labelToStage[toLabel];

    if (!fromStage || !toStage) return acc;
    if (!acc[item.ownerSellerId]) {
      acc[item.ownerSellerId] = { total: 0, advanced: 0 };
    }

    acc[item.ownerSellerId].total += 1;
    if (stageOrder[toStage] > stageOrder[fromStage]) {
      acc[item.ownerSellerId].advanced += 1;
    }

    return acc;
  }, {});

  const salesBySeller = monthSales.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = item._sum.value ?? 0;
    return acc;
  }, {});
  const goalsBySeller = monthGoals.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item.targetValue;
    return acc;
  }, {});

  const maxOpenOpp = Math.max(...Object.values(openOppCountBySeller), 1);
  const createdOpportunitiesBySeller = createdOpportunitiesInMonth.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const baseRows = sellers
    .map((seller) => {
      const discipline = disciplineBySeller[seller.id] || { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      const executionRate = discipline.planned ? (discipline.executed / discipline.planned) * 100 : 0;
      const punctualRate = discipline.executed ? (discipline.punctual / discipline.executed) * 100 : 0;
      const followUpRate = discipline.executed ? (discipline.followUpAfterVisit / discipline.executed) * 100 : 0;
      const disciplineScoreBase = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const volumeFactor = discipline.planned >= 25 ? 1 : 0.7 + (discipline.planned / 25) * 0.3;
      const disciplineScore = disciplineScoreBase * volumeFactor;

      const openOpp = openOppCountBySeller[seller.id] || 0;
      const followUpsOnTime = followUpOnTimeBySeller[seller.id] || 0;
      const stageAdvance = stageAdvanceBySeller[seller.id] || { total: 0, advanced: 0 };

      const openOppScore = (openOpp / maxOpenOpp) * 100;
      const followUpOnTimeRate = openOpp ? (followUpsOnTime / openOpp) * 100 : 0;
      const stageAdvanceRate = stageAdvance.total ? (stageAdvance.advanced / stageAdvance.total) * 100 : 0;
      const pipelineScore = openOppScore * 0.4 + followUpOnTimeRate * 0.35 + stageAdvanceRate * 0.25;

      const soldValue = salesBySeller[seller.id] || 0;
      const monthGoal = goalsBySeller[seller.id] || 0;
      const goalAchievementPercent = monthGoal > 0 ? (soldValue / monthGoal) * 100 : 0;
      const resultScore = Math.min(Math.max(goalAchievementPercent, 0), 110);

      const finalScore = resultScore * 0.5 + disciplineScore * 0.3 + pipelineScore * 0.2;
      const punctualityPerfect = discipline.executed > 0 && punctualRate === 100;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        disciplineScore: Number(disciplineScore.toFixed(2)),
        pipelineScore: Number(pipelineScore.toFixed(2)),
        resultScore: Number(resultScore.toFixed(2)),
        finalScore: Number(finalScore.toFixed(2)),
        breakdown: {
          resultadoScore: Number(resultScore.toFixed(2)),
          disciplinaScore: Number(disciplineScore.toFixed(2)),
          pipelineScore: Number(pipelineScore.toFixed(2)),
          finalScore: Number(finalScore.toFixed(2))
        },
        punctualityPerfect,
        createdOpportunities: createdOpportunitiesBySeller[seller.id] || 0
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const topDisciplineScore = Math.max(...baseRows.map((item) => item.disciplineScore), 0);
  const topCreatedOpportunities = Math.max(...baseRows.map((item) => item.createdOpportunities), 0);

  const scoreRows = baseRows.map((row) => {
    const level = row.finalScore >= 95 ? "Diamante" : row.finalScore >= 85 ? "Ouro" : row.finalScore >= 75 ? "Prata" : row.finalScore >= 60 ? "Bronze" : null;
    const medals: string[] = [];

    if (level) medals.push(level);
    if (row.punctualityPerfect) medals.push("Pontualidade Perfeita");
    if (row.disciplineScore === topDisciplineScore && topDisciplineScore > 0) medals.push("Executor da Semana");
    if (row.createdOpportunities === topCreatedOpportunities && topCreatedOpportunities > 0) medals.push("Gerador de Oportunidades");

    return {
      sellerId: row.sellerId,
      sellerName: row.sellerName,
      disciplineScore: row.disciplineScore,
      pipelineScore: row.pipelineScore,
      resultScore: row.resultScore,
      finalScore: row.finalScore,
      breakdown: row.breakdown,
      level,
      medals
    };
  });

  return res.json({ sellers: scoreRows });
});

router.get("/reports/consistency", async (req, res) => {
  const sellerIdRaw = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const monthKeys = getLastNMonthKeys(3);

  const scopedSellerFilter =
    req.user?.role === "vendedor"
      ? { id: req.user.id }
      : { role: "vendedor" as const, ...(sellerIdRaw ? { id: sellerIdRaw } : {}) };
  const sellers = await prisma.user.findMany({
    where: scopedSellerFilter,
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });

  const monthlyStats = await Promise.all(
    monthKeys.map(async (month) => {
      const { start, end } = getMonthRangeFromKey(month);
      const [sales, goals] = await Promise.all([
        prisma.opportunity.groupBy({
          by: ["ownerSellerId"],
          where: {
            stage: "ganho",
            ownerSellerId: { in: sellers.map((seller) => seller.id) },
            ...buildWonOpportunityDateRangeFilter(start, end)
          },
          _sum: { value: true }
        }),
        prisma.goal.findMany({
          where: {
            month,
            sellerId: { in: sellers.map((seller) => seller.id) }
          },
          select: {
            sellerId: true,
            targetValue: true
          }
        })
      ]);

      const salesBySeller = sales.reduce<Record<string, number>>((acc, item) => {
        acc[item.ownerSellerId] = item._sum.value ?? 0;
        return acc;
      }, {});

      const goalsBySeller = goals.reduce<Record<string, number>>((acc, item) => {
        acc[item.sellerId] = item.targetValue;
        return acc;
      }, {});

      return { month, salesBySeller, goalsBySeller };
    })
  );

  const ranking = sellers
    .map((seller) => {
      const monthlyPerformance = monthKeys.map((month, index) => {
        const soldValue = monthlyStats[index]?.salesBySeller[seller.id] || 0;
        const targetValue = monthlyStats[index]?.goalsBySeller[seller.id] || 0;
        const resultScore = targetValue > 0 ? (soldValue / targetValue) * 100 : 0;
        const finalScore = Math.min(Math.max(resultScore, 0), 110);

        return {
          month,
          soldValue,
          targetValue,
          resultScore,
          finalScore,
          metaHit: targetValue > 0 && soldValue >= targetValue
        };
      });

      const finalScores = monthlyPerformance.map((item) => item.finalScore);
      const resultScores = monthlyPerformance.map((item) => item.resultScore);
      const averageScore = calculateMean(finalScores);
      const metaHitRate = (monthlyPerformance.filter((item) => item.metaHit).length / monthKeys.length) * 100;
      const stdDevResult = calculateStandardDeviation(resultScores);
      const stability = Math.max(0, 100 - stdDevResult);
      const consistencyScore = averageScore * 0.6 + metaHitRate * 0.3 + stability * 0.1;

      const consistencyLevel = consistencyScore >= 80 ? "alta" : consistencyScore >= 60 ? "media" : "baixa";

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        averageScore: Number(averageScore.toFixed(2)),
        metaHitRate: Number(metaHitRate.toFixed(2)),
        stdDevResult: Number(stdDevResult.toFixed(2)),
        stability: Number(stability.toFixed(2)),
        consistencyScore: Number(consistencyScore.toFixed(2)),
        consistencyLevel,
        monthlyPerformance: monthlyPerformance.map((item) => ({
          month: item.month,
          soldValue: Number(item.soldValue.toFixed(2)),
          targetValue: Number(item.targetValue.toFixed(2)),
          resultScore: Number(item.resultScore.toFixed(2)),
          finalScore: Number(item.finalScore.toFixed(2)),
          metaHit: item.metaHit
        }))
      };
    })
    .sort((a, b) => b.consistencyScore - a.consistencyScore)
    .map((item, index) => ({
      ...item,
      position: index + 1
    }));

  return res.json({
    period: {
      months: monthKeys
    },
    ranking
  });
});

router.get("/clients", async (req, res) => {
  const search = String(req.query.q || "").trim();
  const state = String(req.query.uf || "").trim();
  const region = String(req.query.regiao || "").trim();
  const clientType = String(req.query.tipo || "").trim();
  const ownerSellerIdFilter = String(req.query.ownerSellerId || req.query.vendedorId || "").trim();
  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 20), 100);
  const orderBy = parseClientSort(String(req.query.sort || "").trim() || undefined);

  const parsedClientType = clientType.toUpperCase();
  const isValidClientType = parsedClientType === ClientType.PF || parsedClientType === ClientType.PJ;

  const where: Prisma.ClientWhereInput = {
    ...sellerWhere(req),
    ...(state ? { state: { equals: state, mode: "insensitive" } } : {}),
    ...(region ? { region: { equals: region, mode: "insensitive" } } : {}),
    ...(isValidClientType ? { clientType: parsedClientType } : {}),
    ...(req.user?.role !== "vendedor" && ownerSellerIdFilter ? { ownerSellerId: ownerSellerIdFilter } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { fantasyName: { contains: search, mode: "insensitive" } },
            { code: { contains: search, mode: "insensitive" } },
            { cnpj: { contains: search, mode: "insensitive" } },
            { city: { contains: search, mode: "insensitive" } },
            { state: { contains: search, mode: "insensitive" } },
            { region: { contains: search, mode: "insensitive" } },
            { segment: { contains: search, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const hasAdvancedQuery = ["q", "uf", "regiao", "tipo", "ownerSellerId", "vendedorId", "page", "pageSize", "sort"].some(
    (key) => req.query[key] !== undefined
  );

  if (!hasAdvancedQuery) {
    const data = await prisma.client.findMany({
      where,
      orderBy,
      include: {
        ownerSeller: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    return res.json(data);
  }

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        ownerSeller: {
          select: {
            id: true,
            name: true
          }
        }
      }
    }),
    prisma.client.count({ where })
  ]);

  res.json({
    items,
    total,
    page,
    pageSize
  });
});

router.get("/clients/:id", async (req, res) => {
  const data = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    }
  });

  if (!data) return res.status(404).json({ message: "Não encontrado" });

  const [openOpportunitiesCount, lastActivityAggregate, totalCompletedActivities] = await Promise.all([
    prisma.opportunity.count({
      where: {
        clientId: data.id,
        stage: {
          notIn: [OpportunityStage.ganho, OpportunityStage.perdido]
        }
      }
    }),
    prisma.activity.aggregate({
      where: {
        clientId: data.id
      },
      _max: {
        date: true,
        createdAt: true
      }
    }),
    prisma.activity.count({
      where: {
        clientId: data.id,
        done: true
      }
    })
  ]);

  const commercialSummary = {
    openOpportunitiesCount,
    lastActivityAt: lastActivityAggregate._max.date ?? lastActivityAggregate._max.createdAt ?? null,
    lastPurchaseDate: data.lastPurchaseDate ?? null,
    lastPurchaseValue: data.lastPurchaseValue ?? null,
    totalCompletedActivities
  };

  res.json({
    ...data,
    commercialSummary
  });
});

const clientAiContextParamsSchema = z.object({
  id: z.string().trim().min(1, "id é obrigatório")
});

router.get("/clients/:id/ai-context", async (req, res) => {
  const parsed = clientAiContextParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ message: "Parâmetros inválidos", errors: parsed.error.issues });
  }

  const payload = await buildClientAiContext({
    clientId: parsed.data.id,
    scope: sellerWhere(req)
  });

  if (!payload) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  return res.json(payload);
});

const clientSuggestionBodySchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório")
});

router.post("/ai/client-suggestion", async (req, res) => {
  const parsed = clientSuggestionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const context = await buildClientAiContext({
    clientId: parsed.data.clientId,
    scope: sellerWhere(req)
  });

  if (!context) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const suggestion = await generateClientSuggestion(context);
  return res.json(suggestion);
});

const clientDuplicateCheckSchema = z.object({
  name: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  cnpj: z.string().optional(),
  ignoreClientId: z.string().optional()
});

router.post("/clients/check-duplicate", async (req, res) => {
  const parsed = clientDuplicateCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido para validação de cliente." });
  }

  const duplicate = await findDuplicateClient({
    candidate: parsed.data,
    scope: sellerWhere(req),
    ignoreClientId: parsed.data.ignoreClientId
  });

  if (!duplicate) {
    return res.json({ exists: false, existingClient: null, matchType: null });
  }

  return res.json({
    exists: true,
    matchType: duplicate.matchType,
    message: new DuplicateClientError(duplicate.existingClient, duplicate.matchType).message,
    existingClient: duplicate.existingClient
  });
});

router.post("/clients/exists-bulk", async (req, res) => {
  const parsed = clientExistsBulkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido para verificação em lote." });
  }

  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? 500;

  const normalizedKeys = parsed.data.keys.map((key) => ({
    cnpjDigits: normalizeCnpj(key.cnpjDigits),
    fallbackKey: key.fallbackKey ? normalizeText(key.fallbackKey).replace(/\s*\|\s*/g, "|") : ""
  }));

  const paginated = paginateArray(normalizedKeys, page, pageSize);
  const pageKeys = paginated.data;

  if (pageKeys.length === 0) {
    return res.json({ ...paginated, data: [] });
  }

  const cnpjSet = new Set<string>();
  const fallbackSet = new Set<string>();

  pageKeys.forEach((key) => {
    if (key.cnpjDigits) cnpjSet.add(key.cnpjDigits);
    if (key.fallbackKey) fallbackSet.add(key.fallbackKey);
  });

  const fallbackTuples = Array.from(fallbackSet).map((key) => {
    const [nameNormalized = "", cityNormalized = "", state = ""] = key.split("|");
    return { nameNormalized, cityNormalized, state: normalizeState(state) };
  });

  const fallbackOrChunks: Prisma.ClientWhereInput[] = [];
  const fallbackChunkSize = 100;
  for (let index = 0; index < fallbackTuples.length; index += fallbackChunkSize) {
    const chunk = fallbackTuples.slice(index, index + fallbackChunkSize);
    fallbackOrChunks.push({
      OR: chunk.map((tuple) => ({
        nameNormalized: tuple.nameNormalized,
        cityNormalized: tuple.cityNormalized,
        state: tuple.state
      }))
    });
  }

  const whereOr: Prisma.ClientWhereInput[] = [];
  if (cnpjSet.size > 0) {
    whereOr.push({
      OR: [{ cnpjNormalized: { in: Array.from(cnpjSet) } }, { cnpj: { in: Array.from(cnpjSet) } }]
    });
  }
  whereOr.push(...fallbackOrChunks);

  const existingClients = whereOr.length
    ? await prisma.client.findMany({
        where: {
          ...sellerWhere(req),
          OR: whereOr
        },
        select: {
          id: true,
          cnpj: true,
          cnpjNormalized: true,
          name: true,
          city: true,
          state: true,
          nameNormalized: true,
          cityNormalized: true
        }
      })
    : [];

  const byCnpj = new Map<string, string>();
  const byFallback = new Map<string, string>();

  existingClients.forEach((client) => {
    const normalizedCnpj = client.cnpjNormalized || normalizeCnpj(client.cnpj);
    if (normalizedCnpj) byCnpj.set(normalizedCnpj, client.id);

    const fallbackKey = buildFallbackKey(
      client.nameNormalized || client.name,
      client.cityNormalized || client.city,
      client.state
    );
    byFallback.set(fallbackKey, client.id);
  });

  const data = pageKeys.map((key) => {
    const matchedByCnpj = key.cnpjDigits ? byCnpj.get(key.cnpjDigits) : undefined;
    const matchedByFallback = key.fallbackKey ? byFallback.get(key.fallbackKey) : undefined;
    const clientId = matchedByCnpj || matchedByFallback || null;

    return {
      cnpjDigits: key.cnpjDigits || null,
      fallbackKey: key.fallbackKey || null,
      exists: Boolean(clientId),
      clientId
    };
  });

  res.json({ ...paginated, data });
});

router.post("/clients", validateBody(clientSchema), async (req, res) => {
  try {
    const ownerSellerId =
      req.user!.role === "vendedor"
        ? req.user!.id
        : req.user!.role === "gerente" || req.user!.role === "diretor"
          ? resolveOwnerId(req, req.body.ownerSellerId)
          : resolveOwnerId(req);

    const payload = withClientNormalizedFields({ ...req.body, ownerSellerId });
    await ensureClientIsNotDuplicate({ candidate: payload, scope: sellerWhere(req) });

    const data = await prisma.client.create({ data: payload });
    res.status(201).json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

// ✅ Preview (para UI: novos/duplicados/erros)
router.post("/clients/import/preview", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);

  const novos = preview
    .filter((item) => item.status === "new")
    .map((item) => ({ rowNumber: item.rowNumber, row: item.row }));

  const duplicados = preview
    .filter((item) => item.status === "duplicate")
    .map((item) => ({
      rowNumber: item.rowNumber,
      row: item.row,
      existingClientId: item.existingClientId || null,
      reason: item.reason
    }));

  const erros = preview
    .filter((item) => item.status === "error")
    .map((item) => ({ rowNumber: item.rowNumber, row: item.row, message: item.error }));

  res.json({ novos, duplicados, erros });
});

// ✅ Alias: simulate (se você quiser um botão "Validar" sem importar)
router.post("/clients/import/simulate", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);

  const summary = {
    total: preview.length,
    newCount: preview.filter((i) => i.status === "new").length,
    duplicateCount: preview.filter((i) => i.status === "duplicate").length,
    errorCount: preview.filter((i) => i.status === "error").length
  };

  res.json({ simulated: true, summary });
});

// ✅ Import (upsert inteligente)
router.post("/clients/import", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);
  const scopedWhere = sellerWhere(req);

  const existingClients = await prisma.client.findMany({
    where: scopedWhere,
    select: {
      id: true,
      name: true,
      nameNormalized: true,
      fantasyName: true,
      code: true,
      city: true,
      state: true,
      cnpj: true
    }
  });

  const byCnpj = new Map<string, (typeof existingClients)[number]>();
  const byCode = new Map<string, (typeof existingClients)[number]>();

  const indexClient = (client: (typeof existingClients)[number]) => {
    const cnpj = normalizeCnpj(client.cnpj);
    if (cnpj) byCnpj.set(cnpj, client);

    const code = normalizeClientCode(client.code);
    if (code) byCode.set(code, client);

  };

  existingClients.forEach(indexClient);

  let created = 0;
  let updated = 0;
  let ignored = 0;
  let conflicts = 0;
  const errors: Array<{ rowNumber: number; clientName: string; message: string }> = [];
  const results: Array<{
    rowNumber: number;
    clientName: string;
    status: "IMPORTED" | "UPDATED" | "IGNORED" | "API_FAILURE";
    category: "imported" | "updated" | "ignored" | "duplicate" | "validation" | "api_error";
    reason: string;
  }> = [];

  const registerApiFailure = (rowNumber: number, clientName: string, message: string, category: "duplicate" | "validation" | "api_error" = "api_error") => {
    conflicts += 1;
    errors.push({ rowNumber, clientName, message });
    results.push({
      rowNumber,
      clientName,
      status: "API_FAILURE",
      category,
      reason: message
    });
  };

  for (const item of preview) {
    const rowAction = item.row?.action;
    const clientName = String(item.row?.name ?? "");

    if (item.status === "error") {
      registerApiFailure(item.rowNumber, clientName, item.error, "validation");
      continue;
    }

    if (rowAction === "skip") {
      ignored += 1;
      results.push({
        rowNumber: item.rowNumber,
        clientName,
        status: "IGNORED",
        category: "ignored",
        reason: "Linha ignorada por decisão do usuário."
      });
      continue;
    }

    try {
      const existingResolution = findImportExistingClient({
        payload: item.payload,
        byCnpj,
        byCode
      });

      if (existingResolution.match) {
        const { data: resolvedUpdateData, hasMeaningfulChanges, mergedClientForValidation } = resolveImportUpdateData(
          item.payload,
          req,
          existingResolution.match
        );

        if (!hasMeaningfulChanges) {
          ignored += 1;
          results.push({
            rowNumber: item.rowNumber,
            clientName,
            status: "IGNORED",
            category: "ignored",
            reason: "Cliente já existe e não há campos vazios para enriquecer."
          });
          continue;
        }

        await ensureClientIsNotDuplicate({
          candidate: mergedClientForValidation,
          scope: scopedWhere,
          ignoreClientId: existingResolution.match.id
        });

        const updatedClient = await prisma.client.update({
          where: { id: existingResolution.match.id },
          data: resolvedUpdateData
        });

        const updatedIndex = existingClients.findIndex((client) => client.id === updatedClient.id);
        if (updatedIndex >= 0) existingClients[updatedIndex] = { ...existingClients[updatedIndex], ...updatedClient };
        byCnpj.clear();
        byCode.clear();
        existingClients.forEach(indexClient);

        updated += 1;
        const reasonByMatch = existingResolution.reason === "cnpj" ? "CNPJ/CPF" : "código ERP";
        results.push({
          rowNumber: item.rowNumber,
          clientName,
          status: "UPDATED",
          category: "updated",
          reason: `Cliente existente identificado por ${reasonByMatch}; campos vazios atualizados.`
        });
        continue;
      }

      const payload = resolveImportCreateData(item.payload, req);
      await ensureClientIsNotDuplicate({ candidate: payload, scope: scopedWhere });
      const createdClient = await prisma.client.create({ data: payload });
      existingClients.push(createdClient as (typeof existingClients)[number]);
      indexClient(createdClient as (typeof existingClients)[number]);
      created += 1;
      results.push({
        rowNumber: item.rowNumber,
        clientName,
        status: "IMPORTED",
        category: "imported",
        reason: "Cliente importado com sucesso."
      });
    } catch (error) {
      if (isDatabaseUniqueViolation(error)) {
        registerApiFailure(item.rowNumber, clientName, "Cliente duplicado.", "duplicate");
        continue;
      }
      if (isDatabaseForeignKeyViolation(error)) {
        registerApiFailure(
          item.rowNumber,
          clientName,
          `Vendedor responsável não encontrado: ${String(item.row?.ownerSellerId || "").trim() || "(vazio)"}`,
          "validation"
        );
        continue;
      }
      registerApiFailure(item.rowNumber, clientName, getImportPersistenceErrorMessage(error));
    }
  }

  res.json({ created, updated, ignored, conflicts, errors, results });
});

router.put("/clients/:id", validateBody(clientSchema.partial()), async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Sem permissão" });
  }

  try {
    const mergedClientForValidation = {
      name: req.body.name ?? old.name,
      city: req.body.city ?? old.city,
      state: req.body.state ?? old.state,
      cnpj: req.body.cnpj ?? old.cnpj
    };

    const normalized = normalizeClientForComparison(mergedClientForValidation);

    await ensureClientIsNotDuplicate({
      candidate: mergedClientForValidation,
      scope: sellerWhere(req),
      ignoreClientId: old.id
    });

    const data = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        state: normalized.state,
        nameNormalized: normalized.nameNormalized,
        cityNormalized: normalized.cityNormalized,
        cnpjNormalized: normalized.cnpjNormalized || null
      }
    });
    res.json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.delete("/clients/:id", async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Sem permissão" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.activity.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });

    await tx.timelineEvent.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });

    await tx.contact.deleteMany({ where: { clientId: req.params.id } });
    await tx.agendaStop.deleteMany({ where: { clientId: req.params.id } });
    await tx.agendaEvent.deleteMany({
      where: {
        OR: [
          { clientId: req.params.id },
          { opportunity: { clientId: req.params.id } }
        ]
      }
    });
    await tx.opportunityChangeLog.deleteMany({ where: { opportunity: { clientId: req.params.id } } });
    await tx.opportunity.deleteMany({ where: { clientId: req.params.id } });
    await tx.client.delete({ where: { id: req.params.id } });
  });

  res.status(204).send();
});

router.get("/clients/:id/contacts", async (req, res) => {
  const client = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!client) return res.status(404).json({ message: "Não encontrado" });

  const contacts = await prisma.contact.findMany({
    where: {
      clientId: req.params.id,
      ...sellerWhere(req)
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
  });

  res.json(contacts);
});

router.post(
  "/clients/:id/contacts",
  validateBody(clientContactSchema),
  async (req, res) => {
    const client = await prisma.client.findFirst({
      where: {
        id: req.params.id,
        ...sellerWhere(req)
      },
      select: { id: true }
    });

    if (!client) return res.status(404).json({ message: "Não encontrado" });

    const data = await prisma.contact.create({
      data: {
        ...req.body,
        clientId: req.params.id,
        ownerSellerId: resolveOwnerId(req),
      },
    });

    res.status(201).json(data);
  }
);

router.put(
  "/clients/:id/contacts/:contactId",
  validateBody(clientContactSchema.partial()),
  async (req, res) => {
    const client = await prisma.client.findFirst({
      where: {
        id: req.params.id,
        ...sellerWhere(req)
      },
      select: { id: true }
    });

    if (!client) return res.status(404).json({ message: "Não encontrado" });

    const existingContact = await prisma.contact.findFirst({
      where: {
        id: req.params.contactId,
        clientId: req.params.id,
        ...sellerWhere(req)
      },
      select: { id: true }
    });

    if (!existingContact) return res.status(404).json({ message: "Não encontrado" });

    const data = await prisma.contact.update({
      where: { id: req.params.contactId },
      data: req.body
    });

    res.json(data);
  }
);

router.delete("/clients/:id/contacts/:contactId", async (req, res) => {
  const existingContact = await prisma.contact.findFirst({
    where: {
      id: req.params.contactId,
      clientId: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingContact) return res.status(404).json({ message: "Não encontrado" });

  await prisma.contact.delete({ where: { id: req.params.contactId } });
  res.status(204).send();
});

// Compatibilidade legada: empresas agora são clientes do tipo PJ
router.get("/companies", async (req, res) => {
  const data = await prisma.client.findMany({
    where: {
      ...sellerWhere(req),
      clientType: "PJ"
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(
    data.map((client) => ({
      id: client.id,
      name: client.name,
      cnpj: client.cnpj,
      segment: client.segment,
      ownerSellerId: client.ownerSellerId,
      createdAt: client.createdAt
    }))
  );
});

router.post("/companies", validateBody(companySchema), async (req, res) => {
  try {
    const payload = withClientNormalizedFields({
      name: req.body.name,
      city: "Não informado",
      state: "NI",
      region: req.user?.region || "Nacional",
      clientType: ClientType.PJ,
      cnpj: req.body.cnpj,
      segment: req.body.segment,
      ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId)
    });

    await ensureClientIsNotDuplicate({ candidate: payload, scope: sellerWhere(req) });

    const data = await prisma.client.create({ data: payload });

    res.status(201).json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.put("/companies/:id", validateBody(companySchema.partial()), async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });

  try {
    const mergedClientForValidation = {
      name: req.body.name ?? old.name,
      city: old.city,
      state: old.state,
      cnpj: req.body.cnpj ?? old.cnpj
    };

    await ensureClientIsNotDuplicate({
      candidate: mergedClientForValidation,
      scope: sellerWhere(req),
      ignoreClientId: old.id
    });

    const normalized = normalizeClientForComparison(mergedClientForValidation);

    const data = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.name ? { name: req.body.name } : {}),
        ...(req.body.cnpj !== undefined ? { cnpj: req.body.cnpj } : {}),
        ...(req.body.segment !== undefined ? { segment: req.body.segment } : {}),
        clientType: ClientType.PJ,
        state: normalized.state,
        nameNormalized: normalized.nameNormalized,
        cityNormalized: normalized.cityNormalized,
        cnpjNormalized: normalized.cnpjNormalized || null
      }
    });

    res.json(data);
  } catch (error) {
    if (error instanceof DuplicateClientError) {
      return res.status(error.statusCode).json({ message: error.message, existingClient: error.existingClient, matchType: error.matchType });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.delete("/companies/:id", async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/contacts", async (req, res) =>
  res.json(
    await prisma.contact.findMany({
      where: sellerWhere(req),
      include: { client: true },
      orderBy: { createdAt: "desc" }
    })
  )
);

router.post("/contacts", validateBody(contactSchema), async (req, res) =>
  res
    .status(201)
    .json(await prisma.contact.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } }))
);

router.put("/contacts/:id", validateBody(contactSchema.partial()), async (req, res) =>
  res.json(await prisma.contact.update({ where: { id: req.params.id }, data: req.body }))
);

router.delete("/contacts/:id", async (req, res) => {
  await prisma.contact.delete({ where: { id: req.params.id } });
  res.status(204).send();
});


router.post("/ai/opportunity-insight", async (req, res) => {
  const parsed = opportunityInsightRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido", errors: parsed.error.issues });
  }

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: parsed.data.opportunityId },
    select: {
      id: true,
      stage: true,
      value: true,
      createdAt: true,
      lastContactAt: true,
      followUpDate: true,
      client: {
        select: {
          id: true,
          name: true
        }
      },
      timelineEvents: {
        select: {
          id: true,
          createdAt: true,
          type: true,
          description: true
        },
        orderBy: { createdAt: "desc" },
        take: 25
      },
      activities: {
        select: {
          id: true,
          createdAt: true,
          date: true,
          notes: true,
          description: true,
          result: true
        },
        orderBy: { createdAt: "desc" },
        take: 15
      }
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const recentTimelineObservation = opportunity.timelineEvents
    .find((event) => event.description?.trim())
    ?.description
    ?.trim();

  const recentActivityWithObservation = opportunity.activities.find((activity) => {
    const texts = [activity.notes, activity.description, activity.result].map((text) => text?.trim() || "");
    return texts.some(Boolean);
  });

  const recentActivityObservation = recentActivityWithObservation
    ? [recentActivityWithObservation.notes, recentActivityWithObservation.description, recentActivityWithObservation.result]
      .map((text) => text?.trim() || "")
      .find(Boolean) || null
    : null;

  const recentActivityDate = recentActivityWithObservation
    ? (recentActivityWithObservation.date || recentActivityWithObservation.createdAt).getTime()
    : 0;
  const recentTimelineDate = opportunity.timelineEvents.find((event) => event.description?.trim())?.createdAt.getTime() || 0;

  const latestObservation = recentActivityDate >= recentTimelineDate
    ? recentActivityObservation
    : (recentTimelineObservation || recentActivityObservation);

  const insight = generateOpportunityInsight({
    ...opportunity,
    observationInsight: parseActivityObservation(latestObservation)
  });

  return res.json(insight);
});

const opportunityMessageQuerySchema = z.object({
  opportunityId: z.string().trim().min(1, "opportunityId é obrigatório")
});

const clientSummaryParamsSchema = z.object({
  clientId: z.string().trim().min(1, "clientId é obrigatório")
});

router.get("/ai/client-summary/:clientId", async (req, res) => {
  const parsed = clientSummaryParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ message: "Parâmetros inválidos", errors: parsed.error.issues });
  }

  const { clientId } = parsed.data;

  const client = await prisma.client.findFirst({
    where: {
      id: clientId,
      ...sellerWhere(req)
    },
    select: {
      id: true,
      name: true,
      city: true,
      state: true
    }
  });

  if (!client) {
    return res.status(404).json({ message: "Cliente não encontrado" });
  }

  const [recentActivities, openOpportunities, lastWonOpportunity] = await Promise.all([
    prisma.activity.findMany({
      where: { clientId: client.id },
      orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        type: true,
        notes: true,
        done: true,
        dueDate: true,
        createdAt: true,
        date: true
      }
    }),
    prisma.opportunity.findMany({
      where: {
        clientId: client.id,
        stage: { notIn: [...CLOSED_STAGE_VALUES] }
      },
      orderBy: [{ followUpDate: "asc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        title: true,
        stage: true,
        followUpDate: true,
        value: true,
        notes: true,
        createdAt: true,
        lastContactAt: true
      }
    }),
    prisma.opportunity.findFirst({
      where: {
        clientId: client.id,
        stage: "ganho"
      },
      orderBy: [{ closedAt: "desc" }, { createdAt: "desc" }],
      select: {
        title: true,
        value: true,
        closedAt: true,
        createdAt: true
      }
    })
  ]);

  const recentObservations = recentActivities
    .map((activity) => ({ text: activity.notes?.trim() || "", createdAt: activity.createdAt }))
    .filter((activity) => Boolean(activity.text))
    .slice(0, 10);

  const lastContactCandidates = [
    ...recentActivities.map((activity) => activity.date || activity.dueDate || activity.createdAt),
    ...openOpportunities.map((opportunity) => opportunity.lastContactAt).filter(Boolean) as Date[],
    lastWonOpportunity?.closedAt || null,
    lastWonOpportunity?.createdAt || null
  ].filter(Boolean) as Date[];

  const lastContact = lastContactCandidates.length
    ? new Date(Math.max(...lastContactCandidates.map((value) => value.getTime())))
    : null;

  const payload = generateClientSummary({
    client: {
      name: client.name,
      city: client.city,
      state: client.state
    },
    recentActivities: recentActivities.map((activity) => ({
      type: activity.type,
      notes: activity.notes,
      done: activity.done,
      dueDate: activity.dueDate,
      createdAt: activity.createdAt
    })),
    recentObservations,
    openOpportunities: openOpportunities.map((opportunity) => ({
      title: opportunity.title,
      stage: opportunity.stage,
      followUpDate: opportunity.followUpDate,
      value: opportunity.value,
      notes: opportunity.notes,
      createdAt: opportunity.createdAt
    })),
    lastWonOpportunity: lastWonOpportunity
      ? {
          title: lastWonOpportunity.title,
          value: lastWonOpportunity.value,
          closedAt: lastWonOpportunity.closedAt,
          updatedAt: lastWonOpportunity.createdAt
        }
      : null,
    lastContact
  });

  return res.json(payload);
});

router.get("/ai/opportunity-message", async (req, res) => {
  const parsed = opportunityMessageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Query inválida", errors: parsed.error.issues });
  }

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: parsed.data.opportunityId },
    select: {
      id: true,
      title: true,
      stage: true,
      crop: true,
      productOffered: true,
      followUpDate: true,
      lastContactAt: true,
      createdAt: true,
      client: {
        select: {
          name: true
        }
      },
      timelineEvents: {
        select: {
          description: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" },
        take: 2
      }
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const message = generateSalesMessage({
    clientName: opportunity.client?.name || null,
    title: opportunity.title,
    crop: opportunity.crop,
    productOffered: opportunity.productOffered,
    stage: opportunity.stage,
    followUpDate: opportunity.followUpDate,
    lastContactAt: opportunity.lastContactAt,
    createdAt: opportunity.createdAt,
    timelineEvents: opportunity.timelineEvents
  });

  return res.json({ message });
});

router.get("/ai/today-priorities", async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Não autenticado" });
  }

  const todayStart = getUtcTodayStart();
  const openOpportunities = await prisma.opportunity.findMany({
    where: {
      ownerSellerId: req.user.id,
      stage: { notIn: [...CLOSED_STAGE_VALUES] }
    },
    select: {
      id: true,
      value: true,
      followUpDate: true,
      createdAt: true,
      lastContactAt: true,
      stage: true,
      client: { select: { name: true } },
      timelineEvents: {
        select: { createdAt: true, description: true },
        orderBy: { createdAt: "desc" },
        take: 25
      },
      activities: {
        select: {
          createdAt: true,
          date: true,
          notes: true,
          description: true,
          result: true
        },
        orderBy: { createdAt: "desc" },
        take: 15
      }
    }
  });

  const priorities = calculateTodayPriorities(openOpportunities, todayStart);

  return res.json(priorities);
});

router.get("/opportunities", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = parsePositiveInt(req.query.pageSize, 20);
  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(req, parsedFilters.params, todayStart);

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][list][request]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities",
      filters: parsedFilters.params,
      prismaWhere: where,
      query: req.query
    });
  }

  const baseQuery = {
    where,
    include: {
      client: { select: { id: true, name: true, city: true, state: true } },
      ownerSeller: { select: { id: true, name: true } }
    },
    orderBy: [{ expectedCloseDate: "asc" }, { value: "desc" }] as Prisma.Enumerable<Prisma.OpportunityOrderByWithRelationInput>
  };

  if (!hasPagination) {
    const opportunities: any[] = await prisma.opportunity.findMany(baseQuery);
    if (shouldLogOpportunityDiagnostics) {
      const totals = opportunities.reduce((acc, opportunity) => {
        const weighted = getWeightedValue(opportunity.value, opportunity.probability);
        const isOverdue = isOpportunityOverdue(opportunity, todayStart);
        return {
          count: acc.count + 1,
          value: acc.value + opportunity.value,
          weighted: acc.weighted + weighted,
          overdueCount: acc.overdueCount + (isOverdue ? 1 : 0)
        };
      }, { count: 0, value: 0, weighted: 0, overdueCount: 0 });
      const consideredOpportunities = opportunities.slice(0, 50).map((opportunity) => ({
        id: opportunity.id,
        title: opportunity.title,
        stage: opportunity.stage,
        value: opportunity.value,
        closedAt: toIsoStringOrNull(opportunity.closedAt),
        expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
        proposalDate: toIsoStringOrNull(opportunity.proposalDate),
        sellerId: opportunity.ownerSeller?.id || null,
        sellerName: opportunity.ownerSeller?.name || null
      }));
      console.info("[diag-opportunities-api][list][response]", {
        userId: req.user?.id,
        role: req.user?.role,
        endpoint: "/opportunities",
        filters: parsedFilters.params,
        totals,
        consideredOpportunities
      });
    }
    return res.json(opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)));
  }

  const [total, opportunities] = await Promise.all([
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({
      ...baseQuery,
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (shouldLogOpportunityDiagnostics) {
    const totals = opportunities.reduce((acc, opportunity) => {
      const weighted = getWeightedValue(opportunity.value, opportunity.probability);
      const isOverdue = isOpportunityOverdue(opportunity, todayStart);
      return {
        count: acc.count + 1,
        value: acc.value + opportunity.value,
        weighted: acc.weighted + weighted,
        overdueCount: acc.overdueCount + (isOverdue ? 1 : 0)
      };
    }, { count: 0, value: 0, weighted: 0, overdueCount: 0 });
    const consideredOpportunities = opportunities.slice(0, 50).map((opportunity) => ({
      id: opportunity.id,
      title: opportunity.title,
      stage: opportunity.stage,
      value: opportunity.value,
      closedAt: toIsoStringOrNull(opportunity.closedAt),
      expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
      proposalDate: toIsoStringOrNull(opportunity.proposalDate),
      sellerId: opportunity.ownerSeller?.id || null,
      sellerName: opportunity.ownerSeller?.name || null
    }));
    console.info("[diag-opportunities-api][list][response-paginated]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities",
      filters: parsedFilters.params,
      prismaWhere: where,
      pagination: { page, pageSize, total },
      returnedTotals: totals,
      consideredOpportunities
    });
  }
  return res.json({
    items: opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)),
    total,
    page,
    pageSize,
    totalPages
  });
});

router.get("/opportunities/summary", async (req, res) => {
  const parsedFilters = parseOpportunityFilterParams(req);
  if ("error" in parsedFilters) return res.status(400).json({ message: parsedFilters.error });
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  const todayStart = getUtcTodayStart();
  const where = buildOpportunityWhere(req, parsedFilters.params, todayStart);

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][summary][request]", {
      userId: req.user?.id,
      role: req.user?.role,
      filters: parsedFilters.params,
      query: req.query
    });
  }

  const opportunities: any[] = await prisma.opportunity.findMany({
    where,
    select: {
      id: true,
      title: true,
      value: true,
      stage: true,
      crop: true,
      season: true,
      probability: true,
      followUpDate: true,
      closedAt: true,
      expectedCloseDate: true,
      proposalDate: true,
      ownerSeller: { select: { id: true, name: true } }
    }
  });

  const totalsByStage: Record<string, { value: number; weighted: number }> = {};
  const countByStage: Record<string, number> = {};
  const breakdownByCrop: Record<string, { value: number; weighted: number; count: number }> = {};
  const breakdownBySeason: Record<string, { value: number; weighted: number; count: number }> = {};

  const pipelineMetrics = calculatePipelineMetrics(opportunities, todayStart);
  let wonCount = 0;
  let lossCount = 0;

  for (const opportunity of opportunities) {
    const weighted = getWeightedValue(opportunity.value, opportunity.probability);

    if (opportunity.stage === "ganho") wonCount += 1;
    if (opportunity.stage === "perdido") lossCount += 1;

    if (!totalsByStage[opportunity.stage]) totalsByStage[opportunity.stage] = { value: 0, weighted: 0 };
    totalsByStage[opportunity.stage].value += opportunity.value;
    totalsByStage[opportunity.stage].weighted += weighted;
    countByStage[opportunity.stage] = (countByStage[opportunity.stage] || 0) + 1;

    const cropKey = opportunity.crop || "não informado";
    if (!breakdownByCrop[cropKey]) breakdownByCrop[cropKey] = { value: 0, weighted: 0, count: 0 };
    breakdownByCrop[cropKey].value += opportunity.value;
    breakdownByCrop[cropKey].weighted += weighted;
    breakdownByCrop[cropKey].count += 1;

    const seasonKey = opportunity.season || "não informado";
    if (!breakdownBySeason[seasonKey]) breakdownBySeason[seasonKey] = { value: 0, weighted: 0, count: 0 };
    breakdownBySeason[seasonKey].value += opportunity.value;
    breakdownBySeason[seasonKey].weighted += weighted;
    breakdownBySeason[seasonKey].count += 1;

  }

  const closedCount = wonCount + lossCount;
  const conversionRate = parsedFilters.params.status === "open" || closedCount === 0 ? 0 : (wonCount / closedCount) * 100;
  if (shouldLogOpportunityDiagnostics) {
    const wonOpportunities = opportunities.filter((opportunity) => opportunity.stage === "ganho");
    const sample = opportunities.slice(0, 50).map((opportunity) => ({
      id: opportunity.id,
      title: opportunity.title,
      stage: opportunity.stage,
      value: opportunity.value,
      closedAt: toIsoStringOrNull(opportunity.closedAt),
      expectedCloseDate: toIsoStringOrNull(opportunity.expectedCloseDate),
      proposalDate: toIsoStringOrNull(opportunity.proposalDate),
      sellerId: opportunity.ownerSeller?.id || null,
      sellerName: opportunity.ownerSeller?.name || null
    }));
    console.info("[diag-opportunities-api][summary][response]", {
      userId: req.user?.id,
      role: req.user?.role,
      endpoint: "/opportunities/summary",
      filters: parsedFilters.params,
      prismaWhere: where,
      totalCount: opportunities.length,
      pipelineTotal: pipelineMetrics.pipelineTotal,
      weightedTotal: pipelineMetrics.weightedTotal,
      overdueCount: pipelineMetrics.overdueCount,
      conversionRate,
      wonDiagnostics: { count: wonOpportunities.length },
      consideredOpportunities: sample
    });
  }
  res.json({
    pipelineTotalValue: pipelineMetrics.pipelineTotal,
    weightedValue: pipelineMetrics.weightedTotal,
    pipelineTotal: pipelineMetrics.pipelineTotal,
    weightedTotal: pipelineMetrics.weightedTotal,
    overdueCount: pipelineMetrics.overdueCount,
    overdueValue: pipelineMetrics.overdueValue,
    conversionRate,
    byStage: totalsByStage,
    totalPipelineValue: pipelineMetrics.pipelineTotal,
    totalWeightedValue: pipelineMetrics.weightedTotal,
    totalsByStage,
    countByStage,
    totalCount: opportunities.length,
    breakdownByCrop,
    breakdownBySeason
  });
});

router.patch("/opportunities/:id/close", async (req, res) => {
  const stage = normalizeStageInput(String(req.body?.stage || ""));
  if (!stage || !CLOSED_STAGES.has(stage)) {
    return res.status(400).json({ message: "Etapa de encerramento inválida." });
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const existingOpportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true, clientId: true, ownerSellerId: true, stage: true }
  });

  if (!existingOpportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const closedAt = new Date();
  const shouldLogOpportunityDiagnostics = process.env.NODE_ENV !== "production";

  if (shouldLogOpportunityDiagnostics) {
    console.info("[diag-opportunities-api][close][request]", {
      opportunityId: req.params.id,
      body: req.body,
      userId: req.user?.id,
      userRole: req.user?.role
    });
  }

  try {
    const updatedOpportunity = await prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.update({
        where: { id: req.params.id },
        data: {
          stage,
          closedAt,
          expectedCloseDate: closedAt,
          followUpDate: closedAt
        },
        include: {
          client: {
            select: { id: true, name: true, city: true, state: true }
          },
          ownerSeller: {
            select: { id: true, name: true }
          }
        }
      });

      if (existingOpportunity.stage !== stage) {
        await tx.timelineEvent.create({
          data: {
            type: "mudanca_etapa",
            description: `Etapa alterada de ${STAGE_LABELS[STAGE_ALIASES[existingOpportunity.stage] || "prospeccao"]} para ${STAGE_LABELS[stage]}`,
            opportunityId: opportunity.id,
            clientId: opportunity.clientId,
            ownerSellerId: opportunity.ownerSellerId
          }
        });
      }

      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: reason
            ? `Oportunidade encerrada como ${STAGE_LABELS[stage]}. Motivo/observação: ${reason}`
            : `Oportunidade encerrada como ${STAGE_LABELS[stage]}`,
          opportunityId: opportunity.id,
          clientId: opportunity.clientId,
          ownerSellerId: opportunity.ownerSellerId
        }
      });

      return opportunity;
    });

    const responsePayload = {
      message: `Oportunidade encerrada como ${STAGE_LABELS[stage]}`,
      opportunity: serializeOpportunity(updatedOpportunity, getUtcTodayStart())
    };

    if (shouldLogOpportunityDiagnostics) {
      console.info("[diag-opportunities-api][close][response]", {
        status: 200,
        opportunityId: responsePayload.opportunity?.id,
        stage: responsePayload.opportunity?.stage
      });
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    if (shouldLogOpportunityDiagnostics) {
      console.error("[diag-opportunities-api][close][error]", {
        opportunityId: req.params.id,
        error
      });
    }
    return res.status(422).json({
      message: "Não foi possível encerrar a oportunidade. Verifique as regras de negócio e tente novamente."
    });
  }
});

router.patch("/opportunities/:id/closed-report", async (req, res) => {
  const parsed = closedOpportunityEditSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido para edição." });
  }

  const existingOpportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req),
      stage: { in: ["ganho", "perdido"] }
    },
    include: {
      client: {
        select: { id: true, name: true, city: true, state: true }
      },
      ownerSeller: {
        select: { id: true, name: true }
      }
    }
  });

  if (!existingOpportunity) {
    return res.status(404).json({ message: "Oportunidade encerrada não encontrada." });
  }

  const nextValues = parsed.data;
  const normalizedCrop = nextValues.crop === undefined ? undefined : (nextValues.crop?.trim() || null);
  const normalizedSeason = nextValues.season === undefined ? undefined : (nextValues.season?.trim() || null);

  const changedFields: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

  if (nextValues.title !== undefined && nextValues.title !== existingOpportunity.title) {
    changedFields.push({ field: "title", oldValue: existingOpportunity.title, newValue: nextValues.title });
  }
  if (nextValues.value !== undefined && nextValues.value !== existingOpportunity.value) {
    changedFields.push({ field: "value", oldValue: String(existingOpportunity.value), newValue: String(nextValues.value) });
  }
  if (normalizedCrop !== undefined && normalizedCrop !== existingOpportunity.crop) {
    changedFields.push({ field: "crop", oldValue: existingOpportunity.crop, newValue: normalizedCrop });
  }
  if (normalizedSeason !== undefined && normalizedSeason !== existingOpportunity.season) {
    changedFields.push({ field: "season", oldValue: existingOpportunity.season, newValue: normalizedSeason });
  }
  if (nextValues.stage !== undefined && nextValues.stage !== existingOpportunity.stage) {
    changedFields.push({ field: "stage", oldValue: existingOpportunity.stage, newValue: nextValues.stage });
  }

  if (!changedFields.length) {
    return res.status(200).json({
      message: "Nenhuma alteração detectada.",
      opportunity: serializeOpportunity(existingOpportunity, getUtcTodayStart())
    });
  }

  const actorId = req.user?.id;
  if (!actorId) {
    return res.status(401).json({ message: "Usuário autenticado não encontrado." });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedOpportunity = await tx.opportunity.update({
      where: { id: req.params.id },
      data: {
        ...(nextValues.title !== undefined ? { title: nextValues.title } : {}),
        ...(nextValues.value !== undefined ? { value: nextValues.value } : {}),
        ...(normalizedCrop !== undefined ? { crop: normalizedCrop } : {}),
        ...(normalizedSeason !== undefined ? { season: normalizedSeason } : {}),
        ...(nextValues.stage !== undefined ? { stage: nextValues.stage } : {})
      },
      include: {
        client: {
          select: { id: true, name: true, city: true, state: true }
        },
        ownerSeller: {
          select: { id: true, name: true }
        }
      }
    });

    await tx.opportunityChangeLog.createMany({
      data: changedFields.map((fieldChange) => ({
        opportunityId: updatedOpportunity.id,
        actorId,
        field: fieldChange.field,
        oldValue: fieldChange.oldValue,
        newValue: fieldChange.newValue
      }))
    });

    await Promise.all(changedFields.map((fieldChange) =>
      tx.timelineEvent.create({
        data: {
          type: fieldChange.field === "stage" ? "mudanca_etapa" : "status",
          description: `Edição de oportunidade encerrada: ${fieldChange.field} de '${fieldChange.oldValue ?? "—"}' para '${fieldChange.newValue ?? "—"}'`,
          opportunityId: updatedOpportunity.id,
          clientId: updatedOpportunity.clientId,
          ownerSellerId: updatedOpportunity.ownerSellerId
        }
      })
    ));

    return updatedOpportunity;
  });

  return res.json({
    message: "Oportunidade encerrada atualizada com sucesso.",
    opportunity: serializeOpportunity(updated, getUtcTodayStart())
  });
});

router.post("/opportunities/import", async (req, res) => {
  const payload = opportunityImportPayloadSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: "Payload inválido para importação." });

  const rows = payload.data.rows;
  const createClientIfMissing = Boolean(payload.data.options?.createClientIfMissing);
  const dryRun = Boolean(payload.data.options?.dryRun);
  const dedupe = {
    ...DEFAULT_OPPORTUNITY_IMPORT_DEDUPE,
    ...(payload.data.options?.dedupe ?? {})
  };

  const startedAt = new Date();
  const result = await processOpportunityImport({
    req,
    rows,
    createClientIfMissing,
    dryRun,
    dedupe
  });
  const finishedAt = new Date();

  console.info("[opportunities/import][audit]", {
    actorId: req.user?.id,
    actorEmail: req.user?.email,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalRows: rows.length,
    totalProcessed: result.summary.totalProcessed,
    created: result.summary.created,
    updated: result.summary.updated,
    ignored: result.summary.ignored,
    failed: result.summary.failed,
    batchSize: OPPORTUNITY_IMPORT_BATCH_SIZE,
    dryRun
  });

  return res.status(200).json({
    ...result,
    message: "Importação concluída",
    summary: {
      ...result.summary,
      created: result.summary.created,
      updated: result.summary.updated,
      ignored: result.summary.ignored,
      conflicts: result.summary.failed
    }
  });
});

router.post("/opportunities/import/preview", async (req, res) => {
  const payload = opportunityImportPayloadSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ message: "Payload inválido para preview." });

  const rows = payload.data.rows;
  const createClientIfMissing = Boolean(payload.data.options?.createClientIfMissing);
  const dedupe = {
    ...DEFAULT_OPPORTUNITY_IMPORT_DEDUPE,
    ...(payload.data.options?.dedupe ?? {}),
    mode: payload.data.options?.dedupe?.mode ?? "skip"
  };

  const result = await processOpportunityImport({
    req,
    rows,
    createClientIfMissing,
    dryRun: true,
    dedupe
  });

  return res.status(200).json(result);
});

router.get("/opportunities/import/dictionary", async (_req, res) => {
  return res.status(200).json({
    columns: [
      { key: "titulo", required: true, example: "Algodão Safra 25/26" },
      { key: "cliente", required: true, example: "Coop X" },
      { key: "vendedor_responsavel", required: true, notes: "nome do vendedor; também aceitamos email_responsavel" },
      { key: "email_responsavel", required: true, notes: "compatível com arquivos legados" },
      { key: "etapa", required: true, accepted: ["prospeccao", "negociacao", "proposta", "ganho"] },
      { key: "valor", required: true, example: "52000.00", notes: "use ponto como decimal" },
      { key: "probabilidade", required: true, notes: "0 a 100" },
      { key: "data_entrada", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "follow_up", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "area_ha", required: false },
      { key: "ticket_esperado_ha", required: false },
      { key: "cultura", required: false },
      { key: "safra", required: false },
      { key: "produto_ofertado", required: false },
      { key: "fechamento_previsto", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "ultimo_contato", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
      { key: "observacoes", required: false },
      { key: "status", required: false, accepted: ["open", "closed"] }
    ],
    tips: [
      "Se 'cliente' não existir e a opção 'Criar cliente automaticamente' estiver ligada, será criado como PJ com dados mínimos.",
      "Etapa inválida vira erro na linha (não bloqueia o arquivo todo).",
      "Datas inválidas viram erro na linha."
    ]
  });
});



const productSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120)
});

const opportunityItemPayloadSchema = z.object({
  productId: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
  erpProductCode: z.string().trim().min(1).max(60).optional(),
  erpProductClassCode: z.string().trim().min(1).max(60).optional(),
  productNameSnapshot: z.string().trim().min(1).max(240).optional(),
  unit: z.string().trim().max(30).optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountType: z.enum(["value", "percent"]).optional(),
  discountValue: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional()
});

const computeOpportunityItemTotals = (payload: { quantity: number; unitPrice: number; discountType?: "value" | "percent"; discountValue?: number }) => {
  const quantity = Number(payload.quantity || 0);
  const unitPrice = Number(payload.unitPrice || 0);
  const grossTotal = Number((quantity * unitPrice).toFixed(2));
  const discountType = payload.discountType || "value";
  const discountValue = Number(payload.discountValue || 0);
  // TODO: adicionar limites de desconto por perfil via Configurações.
  if (discountType === "percent" && (discountValue < 0 || discountValue > 100)) {
    throw Object.assign(new Error("Desconto percentual deve estar entre 0 e 100."), { status: 400 });
  }
  if (discountType === "value" && (discountValue < 0 || discountValue > grossTotal)) {
    throw Object.assign(new Error("Desconto em valor não pode ser maior que o valor bruto do item."), { status: 400 });
  }
  const rawDiscount = discountType === "percent" ? grossTotal * (discountValue / 100) : discountValue;
  const discountTotal = Number(Math.max(0, Math.min(grossTotal, rawDiscount)).toFixed(2));
  const netTotal = Number((grossTotal - discountTotal).toFixed(2));
  if (netTotal < 0) {
    throw Object.assign(new Error("Valor líquido do item não pode ser negativo."), { status: 400 });
  }
  return { grossTotal, discountTotal, netTotal, discountType, discountValue };
};

const mapOpportunityItemResponse = (item: any) => ({
  ...item,
  createdAt: toIsoStringOrNull(item.createdAt),
  updatedAt: toIsoStringOrNull(item.updatedAt)
});


router.get("/products", async (_req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ name: "asc" }],
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });
  return res.json(products);
});

router.get("/products/search", async (req, res) => {
  const parsed = productSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: "Parâmetro q é obrigatório" });
  const q = parsed.data.q;
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      isSuspended: false,
      prices: { some: { price: { gt: 0 } } },
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { erpProductCode: { contains: q, mode: "insensitive" } },
        { erpProductClassCode: { contains: q, mode: "insensitive" } }
      ]
    },
    take: 30,
    orderBy: [{ name: "asc" }],
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });
  return res.json(products);
});

router.get("/products/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { prices: { orderBy: [{ validFrom: "desc" }] } }
  });
  if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  return res.json(product);
});

router.get("/opportunities/:id/items", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const items = await prisma.opportunityItem.findMany({
    where: { opportunityId: req.params.id },
    orderBy: [{ lineNumber: "asc" }],
    include: { product: true }
  });

  const totals = items.reduce(
    (acc, item) => ({ grossTotal: acc.grossTotal + item.grossTotal, discountTotal: acc.discountTotal + item.discountTotal, netTotal: acc.netTotal + item.netTotal }),
    { grossTotal: 0, discountTotal: 0, netTotal: 0 }
  );

  return res.json({
    items: items.map(mapOpportunityItemResponse),
    totals: {
      grossTotal: Number(totals.grossTotal.toFixed(2)),
      discountTotal: Number(totals.discountTotal.toFixed(2)),
      netTotal: Number(totals.netTotal.toFixed(2))
    }
  });
});

router.post("/opportunities/:id/items", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const parsed = opportunityItemPayloadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido" });

  const payload = parsed.data;
  let product = null;
  if (payload.productId) {
    product = await prisma.product.findUnique({ where: { id: payload.productId } });
    if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  }

  const maxLine = await prisma.opportunityItem.aggregate({
    where: { opportunityId: req.params.id },
    _max: { lineNumber: true }
  });

  const { grossTotal, discountTotal, netTotal, discountType, discountValue } = computeOpportunityItemTotals(payload);

  const created = await prisma.opportunityItem.create({
    data: {
      opportunityId: req.params.id,
      productId: payload.productId || null,
      lineNumber: payload.lineNumber || (maxLine._max.lineNumber || 0) + 1,
      erpProductCode: payload.erpProductCode || product?.erpProductCode || "manual",
      erpProductClassCode: payload.erpProductClassCode || product?.erpProductClassCode || "manual",
      productNameSnapshot: payload.productNameSnapshot || product?.name || "Item sem produto",
      unit: payload.unit || product?.unit || null,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice,
      discountType,
      discountValue,
      grossTotal,
      discountTotal,
      netTotal,
      notes: payload.notes || null
    },
    include: { product: true }
  });

  return res.status(201).json(mapOpportunityItemResponse(created));
});

router.put("/opportunities/:id/items/:itemId", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const existing = await prisma.opportunityItem.findFirst({ where: { id: req.params.itemId, opportunityId: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Item não encontrado" });

  const parsed = opportunityItemPayloadSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Payload inválido" });

  const payload = parsed.data;
  const nextQuantity = payload.quantity ?? existing.quantity;
  const nextUnitPrice = payload.unitPrice ?? existing.unitPrice;
  const nextDiscountType = payload.discountType ?? existing.discountType;
  const nextDiscountValue = payload.discountValue ?? existing.discountValue;

  let product = null;
  const productId = payload.productId === undefined ? existing.productId : payload.productId;
  if (productId) {
    product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Produto não encontrado" });
  }

  const { grossTotal, discountTotal, netTotal } = computeOpportunityItemTotals({
    quantity: nextQuantity,
    unitPrice: nextUnitPrice,
    discountType: nextDiscountType,
    discountValue: nextDiscountValue
  });

  const updated = await prisma.opportunityItem.update({
    where: { id: existing.id },
    data: {
      productId: productId || null,
      lineNumber: payload.lineNumber ?? existing.lineNumber,
      erpProductCode: payload.erpProductCode ?? product?.erpProductCode ?? existing.erpProductCode,
      erpProductClassCode: payload.erpProductClassCode ?? product?.erpProductClassCode ?? existing.erpProductClassCode,
      productNameSnapshot: payload.productNameSnapshot ?? product?.name ?? existing.productNameSnapshot,
      unit: payload.unit ?? product?.unit ?? existing.unit,
      quantity: nextQuantity,
      unitPrice: nextUnitPrice,
      discountType: nextDiscountType,
      discountValue: nextDiscountValue,
      grossTotal,
      discountTotal,
      netTotal,
      notes: payload.notes === undefined ? existing.notes : payload.notes || null
    },
    include: { product: true }
  });

  return res.json(mapOpportunityItemResponse(updated));
});

router.delete("/opportunities/:id/items/:itemId", async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const existing = await prisma.opportunityItem.findFirst({ where: { id: req.params.itemId, opportunityId: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Item não encontrado" });

  await prisma.opportunityItem.delete({ where: { id: req.params.itemId } });
  return res.status(204).send();
});

router.get("/opportunities/:id", async (req, res) => {
  const todayStart = getUtcTodayStart();
  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          city: true,
          state: true
        }
      },
      ownerSeller: true
    }
  });

  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada" });

  return res.json(serializeOpportunity(opportunity, todayStart));
});

router.post("/opportunities", validateBody(opportunitySchema), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId);
  const data = await prisma.opportunity.create({
    data: {
      ...(normalizeOpportunityDates(req.body) as any),
      ownerSellerId
    }
  });

  await createEvent({
    type: "status",
    description: `Oportunidade criada: ${data.title}`,
    opportunityId: data.id,
    clientId: data.clientId,
    ownerSellerId
  });

  if (req.body.notes?.trim()) {
    await createEvent({
      type: "comentario",
      description: req.body.notes,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId
    });
  }

  return res.status(201).json(data);
});
router.put("/opportunities/:id", validateBody(opportunitySchema.partial()), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const previous = await prisma.opportunity.findUnique({
    where: { id: req.params.id },
    select: { stage: true, notes: true, clientId: true, ownerSellerId: true, followUpDate: true, probability: true }
  });

  const nextStageRaw = typeof req.body.stage === "string" ? STAGE_ALIASES[req.body.stage] : undefined;
  const isMovingToClosedStage = !!(nextStageRaw && CLOSED_STAGES.has(nextStageRaw) && previous && !CLOSED_STAGES.has(previous.stage));
  const closedAt = isMovingToClosedStage ? new Date() : null;

  const data = await prisma.opportunity.update({
    where: { id: req.params.id },
    data: {
      ...(normalizeOpportunityDates(req.body) as any),
      ...(closedAt ? { closedAt, expectedCloseDate: closedAt, followUpDate: closedAt } : {}),
      ...(nextStageRaw && !CLOSED_STAGES.has(nextStageRaw) ? { closedAt: null } : {})
    }
  });

  if (req.body.stage && previous && req.body.stage !== previous.stage) {
    const fromStage = STAGE_ALIASES[previous.stage] || "prospeccao";
    const toStage = STAGE_ALIASES[req.body.stage] || "prospeccao";
    await createEvent({
      type: "mudanca_etapa",
      description: `Etapa alterada de ${STAGE_LABELS[fromStage]} para ${STAGE_LABELS[toStage]}`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.followUpDate && previous && previous.followUpDate.getTime() !== data.followUpDate.getTime()) {
    await createEvent({
      type: "status",
      description: `Follow-up alterado de ${previous.followUpDate.toISOString().slice(0, 10)} para ${data.followUpDate.toISOString().slice(0, 10)}`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.probability !== undefined && previous && previous.probability !== data.probability) {
    await createEvent({
      type: "status",
      description: `Probabilidade alterada de ${previous.probability ?? 0}% para ${data.probability ?? 0}%`,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  if (req.body.notes && previous && req.body.notes !== previous.notes) {
    await createEvent({
      type: "comentario",
      description: req.body.notes,
      opportunityId: data.id,
      clientId: data.clientId,
      ownerSellerId: data.ownerSellerId
    });
  }

  return res.json(data);
});
router.delete("/opportunities/:id", async (req, res) => { await prisma.opportunity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

const resolveStatus = (payload: { done: boolean; endAt: Date }) => {
  if (payload.done) return "realizado";
  return payload.endAt.getTime() < getBrazilNow().getTime() ? "vencido" : "agendado";
};

const mapActivity = (activity: any) => {
  const status = resolveStatus({ done: activity.done, endAt: activity.dueDate });
  return {
    ...activity,
    ownerId: activity.ownerSellerId,
    status,
    isOverdue: status === "vencido"
  };
};

router.get("/activities", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const month = req.query.month ? String(req.query.month) : "";
  const doneQuery = req.query.done === "true" ? true : req.query.done === "false" ? false : undefined;
  const type = req.query.type ? String(req.query.type) : "";
  const clientId = req.query.clientId ? String(req.query.clientId) : "";
  const overdueOnly = req.query.overdueOnly === "true";
  const sellerId = req.user!.role === "vendedor" ? req.user!.id : (req.query.sellerId as string | undefined);

  const monthRange = month && /^\d{4}-\d{2}$/.test(month) ? getMonthRangeFromKey(month) : null;

  const activities = await prisma.activity.findMany({
    where: {
      ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
      ...(type ? resolveActivityTypeFilters(type) : {}),
      ...(doneQuery !== undefined ? { done: doneQuery } : {}),
      ...(monthRange
        ? (doneQuery === true
            ? { date: { gte: monthRange.start, lte: monthRange.end } }
            : { dueDate: { gte: monthRange.start, lte: monthRange.end } })
        : {}),
      ...(clientId
        ? {
            OR: [
              { clientId },
              { opportunity: { clientId } }
            ]
          }
        : {}),
      ...(q
        ? {
            OR: [
              { notes: { contains: q, mode: "insensitive" } },
              { client: { name: { contains: q, mode: "insensitive" } } },
              { opportunity: { title: { contains: q, mode: "insensitive" } } },
              { opportunity: { client: { name: { contains: q, mode: "insensitive" } } } }
            ]
          }
        : {})
    },
    include: {
      ownerSeller: { select: { id: true, name: true } },
      client: {
        select: {
          id: true,
          name: true
        }
      },
      opportunity: {
        select: {
          id: true,
          title: true,
          client: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  const mapped = activities.map(mapActivity);
  return res.json(overdueOnly ? mapped.filter((item) => item.isOverdue) : mapped);
});
router.get("/activities/monthly-counts", async (req, res) => {
  const month = (req.query.month as string | undefined) || getMonthKey(new Date());
  const sellerIdQuery = req.query.sellerId as string | undefined;

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const sellerId = req.user!.role === "vendedor" ? req.user!.id : sellerIdQuery;
  const { start, end } = getMonthRangeFromKey(month);

  const groupedCounts = await prisma.activity.groupBy({
    by: ["ownerSellerId", "type"],
    where: {
      ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
      createdAt: { gte: start, lte: end }
    },
    _count: { _all: true }
  });

  return res.json(
    groupedCounts.map((countEntry) => ({
      sellerId: countEntry.ownerSellerId,
      type: countEntry.type,
      month,
      logicalCount: countEntry._count._all
    }))
  );
});
router.post("/activities", validateBody(activitySchema), async (req, res) => {
  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId || req.body.ownerId);
  const notes = (req.body.notes || req.body.description || "Sem notas").trim();

  const relatedOpportunity = req.body.opportunityId
    ? await prisma.opportunity.findFirst({
      where: {
        id: req.body.opportunityId,
        ...sellerWhere(req)
      },
      select: { id: true, clientId: true, title: true }
    })
    : null;

  if (req.body.opportunityId && !relatedOpportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const providedClientId = req.body.clientId || undefined;
  const resolvedClientId = relatedOpportunity?.clientId || providedClientId;

  if (providedClientId && relatedOpportunity && providedClientId !== relatedOpportunity.clientId) {
    return res.status(400).json({ message: "Cliente informado é diferente do cliente da oportunidade" });
  }

  const agendaEventId = req.body.agendaEventId || undefined;
  if (agendaEventId) {
    const agendaEvent = await prisma.agendaEvent.findFirst({
      where: {
        id: agendaEventId,
        ...(req.user!.role === "vendedor" ? { sellerId: req.user!.id } : {})
      },
      select: { id: true }
    });

    if (!agendaEvent) {
      return res.status(404).json({ message: "Evento da agenda não encontrado." });
    }
  }

  const normalizedType = normalizeActivityType(req.body.type);

  const activityDateSource = req.body.date || req.body.dueDate;
  if (!activityDateSource) {
    return res.status(400).json({ message: "Informe date ou dueDate para a atividade." });
  }
  const dueDate = new Date(req.body.dueDate || activityDateSource);
  const executionDate = req.body.date ? new Date(req.body.date) : dueDate;
  const isExecuted = Boolean(req.body.done);

  if (isExecuted && (!req.body.description || !String(req.body.description).trim())) {
    return res.status(400).json({ message: "Atividades concluídas exigem o resumo da visita." });
  }

  const createdActivity = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        type: normalizedType,
        notes,
        description: req.body.description || notes,
        result: req.body.result,
        dueDate,
        date: executionDate,
        duration: req.body.duration,
        city: req.body.city,
        crop: req.body.crop,
        areaEstimated: req.body.areaEstimated,
        product: req.body.product,
        checkInAt: req.body.checkInAt ? new Date(req.body.checkInAt) : null,
        checkInLat: req.body.checkInLat ?? null,
        checkInLng: req.body.checkInLng ?? null,
        checkInAccuracy: req.body.checkInAccuracy ?? null,
        done: req.body.done,
        clientId: resolvedClientId,
        opportunityId: req.body.opportunityId,
        agendaEventId,
        ownerSellerId
      }
    });

    if (agendaEventId) {
      await tx.agendaEvent.update({
        where: { id: agendaEventId },
        data: { status: "realizado" }
      });
    }

    if (activity.done && activity.clientId) {
      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: buildActivityExecutedDescription({ ...activity, opportunityTitle: relatedOpportunity?.title }),
          clientId: activity.clientId,
          opportunityId: activity.opportunityId,
          ownerSellerId: activity.ownerSellerId
        }
      });
    }

    return activity;
  });

  await createEvent({
    type: "status",
    description: `Atividade criada: ${createdActivity.type}`,
    opportunityId: createdActivity.opportunityId || undefined,
    clientId: resolvedClientId,
    ownerSellerId
  });

  const month = getMonthKey(createdActivity.createdAt);
  const logicalCount = await getActivityCountByTypeInMonth(ownerSellerId, normalizeActivityType(createdActivity.type), month);

  return res.status(201).json({
    ...mapActivity(createdActivity),
    metrics: {
      month,
      logicalCount
    }
  });
});
const activityUpdateSchema = activitySchema.partial().extend({
  description: z.string().optional()
});

router.put("/activities/:id", validateBody(activityUpdateSchema), async (req, res) => {
  const normalizedType = req.body.type ? normalizeActivityType(req.body.type) : undefined;
  const notes = req.body.notes ?? req.body.description;

  const ownerSellerId = req.body.ownerSellerId ?? req.body.ownerId;
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : undefined;
  const executionDate = req.body.date ? new Date(req.body.date) : undefined;

  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: {
      id: true,
      done: true,
      type: true,
      date: true,
      description: true,
      result: true,
      clientId: true,
      opportunityId: true,
      ownerSellerId: true
    }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  const nextDone = req.body.done ?? existingActivity.done;
  const nextDescription = req.body.description !== undefined ? req.body.description : existingActivity.description;
  if (nextDone && !String(nextDescription || "").trim()) {
    return res.status(400).json({ message: "Atividades concluídas exigem o resumo da visita." });
  }

  const updatedActivity = await prisma.$transaction(async (tx) => {
    const activity = await tx.activity.update({
      where: { id: req.params.id },
      data: {
        ...(normalizedType ? { type: normalizedType } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(req.body.description !== undefined ? { description: req.body.description } : {}),
        ...(req.body.result !== undefined ? { result: req.body.result } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(executionDate ? { date: executionDate } : {}),
        ...(req.body.duration !== undefined ? { duration: req.body.duration } : {}),
        ...(req.body.city !== undefined ? { city: req.body.city } : {}),
        ...(req.body.crop !== undefined ? { crop: req.body.crop } : {}),
        ...(req.body.areaEstimated !== undefined ? { areaEstimated: req.body.areaEstimated } : {}),
        ...(req.body.product !== undefined ? { product: req.body.product } : {}),
        ...(req.body.checkInAt !== undefined ? { checkInAt: req.body.checkInAt ? new Date(req.body.checkInAt) : null } : {}),
        ...(req.body.checkInLat !== undefined ? { checkInLat: req.body.checkInLat } : {}),
        ...(req.body.checkInLng !== undefined ? { checkInLng: req.body.checkInLng } : {}),
        ...(req.body.checkInAccuracy !== undefined ? { checkInAccuracy: req.body.checkInAccuracy } : {}),
        ...(req.body.done !== undefined ? { done: req.body.done } : {}),
        ...(req.body.clientId !== undefined ? { clientId: req.body.clientId } : {}),
        ...(req.body.opportunityId !== undefined ? { opportunityId: req.body.opportunityId } : {}),
        ...(req.body.agendaEventId !== undefined ? { agendaEventId: req.body.agendaEventId } : {}),
        ...(ownerSellerId !== undefined ? { ownerSellerId } : {})
      }
    });

    const transitionedToDone = !existingActivity.done && activity.done;
    if (transitionedToDone && activity.clientId) {
      await tx.timelineEvent.create({
        data: {
          type: "status",
          description: buildActivityExecutedDescription(activity),
          clientId: activity.clientId,
          opportunityId: activity.opportunityId,
          ownerSellerId: activity.ownerSellerId
        }
      });
    }

    return activity;
  });
  return res.json(mapActivity(updatedActivity));
});
router.patch("/activities/:id/done", async (req, res) => {
  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  const updatedActivity = await prisma.activity.update({ where: { id: req.params.id }, data: { done: Boolean(req.body.done) } });
  return res.json(mapActivity(updatedActivity));
});
router.delete("/activities/:id", async (req, res) => {
  const existingActivity = await prisma.activity.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });

  if (!existingActivity) {
    return res.status(404).json({ message: "Atividade não encontrada" });
  }

  await prisma.activity.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/events", async (req, res) => {
  const opportunityId = req.query.opportunityId as string | undefined;
  const clientId = req.query.clientId as string | undefined;
  const takeRaw = Number(req.query.take ?? 20);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), 100) : 20;
  const cursor = req.query.cursor as string | undefined;

  const events = await prisma.timelineEvent.findMany({
    where: buildTimelineEventWhere({
      baseWhere: sellerWhere(req),
      opportunityId,
      clientId
    }),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take,
    include: {
      ownerSeller: { select: { id: true, name: true } },
      opportunity: { select: { id: true, title: true } },
      client: { select: { id: true, name: true } }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  const hasMore = events.length === take;
  const nextCursor = hasMore ? events[events.length - 1]?.id ?? null : null;

  res.json({
    items: events,
    nextCursor
  });
});
router.post("/events", validateBody(eventSchema), async (req, res) => {
  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id: req.body.opportunityId,
      ...sellerWhere(req)
    },
    select: {
      clientId: true
    }
  });

  if (!opportunity) {
    return res.status(404).json({ message: "Oportunidade não encontrada" });
  }

  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId);
  const created = await createEvent({
    type: req.body.type,
    description: req.body.description,
    opportunityId: req.body.opportunityId,
    clientId: opportunity.clientId,
    ownerSellerId
  });

  return res.status(201).json(created);
});

router.delete(["/events/:id", "/agenda/:id", "/agenda/events/:id"], async (req, res) => {
  const agendaEvent = await prisma.agendaEvent.findUnique({
    where: { id: req.params.id },
    select: { id: true, sellerId: true }
  });

  if (agendaEvent) {
    if (req.user!.role === "vendedor" && agendaEvent.sellerId !== req.user!.id) {
      return res.status(403).json({ message: "Acesso negado." });
    }

    await prisma.agendaEvent.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  }

  const timelineEvent = await prisma.timelineEvent.findUnique({
    where: { id: req.params.id },
    select: { id: true, ownerSellerId: true }
  });

  if (!timelineEvent) {
    return res.status(404).json({ message: "Evento não encontrado." });
  }

  if (req.user!.role === "vendedor" && timelineEvent.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  await prisma.timelineEvent.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

const mapAgendaEvent = (agendaEvent: any) => {
  const status = mapAgendaStatusFromDb(agendaEvent.status);
  const startsAt = agendaEvent.startDateTime.toISOString();
  const endsAt = agendaEvent.endDateTime.toISOString();
  const ownerId = agendaEvent.sellerId;
  const isOverdue = status === "planned" && new Date(endsAt).getTime() < Date.now();
  const linkedActivityId = agendaEvent.activities?.[0]?.id || null;

  return {
  id: agendaEvent.id,
  ownerId,
  userId: ownerId,
  sellerId: ownerId,
  title: agendaEvent.title,
  type: agendaEvent.type,
  startsAt,
  endsAt,
  startDateTime: startsAt,
  endDateTime: endsAt,
  clientId: agendaEvent.clientId,
  opportunityId: agendaEvent.opportunityId,
  status,
  isOverdue,
  city: agendaEvent.city,
  notes: agendaEvent.notes,
  linkedActivityId,
  hasLinkedActivity: Boolean(linkedActivityId),
  stops: (agendaEvent.stops || []).map((stop: any) => ({
    id: stop.id,
    order: stop.order,
    clientId: stop.clientId,
    clientName: stop.client?.name || null,
    city: stop.city,
    address: stop.address,
    plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
    notes: stop.notes,
    checkInAt: stop.checkInAt ? stop.checkInAt.toISOString() : null,
    checkInLat: stop.checkInLat,
    checkInLng: stop.checkInLng,
    checkInAccuracy: stop.checkInAccuracy,
    checkOutAt: stop.checkOutAt ? stop.checkOutAt.toISOString() : null,
    checkOutLat: stop.checkOutLat,
    checkOutLng: stop.checkOutLng,
    checkOutAccuracy: stop.checkOutAccuracy,
    resultStatus: stop.resultStatus,
    resultReason: stop.resultReason,
    resultSummary: stop.resultSummary,
    nextStep: stop.nextStep,
    nextStepDate: stop.nextStepDate ? stop.nextStepDate.toISOString() : null
  }))
  };
};

router.get(["/agenda", "/agenda/events"], async (req, res) => {
  const fromInput = req.query.from as string | undefined;
  const toInput = req.query.to as string | undefined;

  const from = fromInput ? normalizeDateToUtc(fromInput) : new Date(Date.now() - 86400000 * 7);
  const to = toInput ? normalizeDateToUtc(toInput, true) : new Date(Date.now() + 86400000 * 30);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const requestedOwnerId = (req.query.ownerId || req.query.sellerId) as string | undefined;
  const scopedSellerId = req.user?.role === "vendedor" ? req.user.id : requestedOwnerId;

  const where: Prisma.AgendaEventWhereInput = {
    ...(scopedSellerId ? { sellerId: scopedSellerId } : {}),
    startDateTime: { lte: to },
    endDateTime: { gte: from }
  };

  const events = await prisma.agendaEvent.findMany({
    where,
    include: {
      stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } },
      client: true,
      activities: { select: { id: true }, orderBy: { createdAt: "desc" }, take: 1 }
    },
    orderBy: { startDateTime: "asc" }
  });

  const mappedEvents = events.map(mapAgendaEvent);
  const summary = mappedEvents.reduce(
    (acc, event) => {
      if (event.status !== "planned") return acc;

      if (event.type === "roteiro_visita") acc.routes += 1;
      else if (event.type === "followup") acc.followups += 1;
      else acc.meetings += 1;

      if (new Date(event.endsAt || event.endDateTime).getTime() < Date.now()) acc.overdue += 1;
      return acc;
    },
    { meetings: 0, routes: 0, followups: 0, overdue: 0 }
  );

  return res.json({
    items: mappedEvents,
    summary,
    period: {
      from: from.toISOString(),
      to: to.toISOString()
    }
  });
});

router.post(["/agenda", "/agenda/events"], validateBody(agendaEventCreateSchema), async (req, res) => {
  const sellerId = resolveOwnerId(req, req.body.ownerId || req.body.ownerSellerId || req.body.sellerId);

  if (req.body.type === "roteiro_visita" && (!Array.isArray(req.body.stops) || req.body.stops.length === 0)) {
    return res.status(400).json({ message: "Roteiro de visita deve conter ao menos uma parada." });
  }

  const event = await prisma.agendaEvent.create({
    data: {
      title: req.body.title,
      type: req.body.type,
      startDateTime: new Date(req.body.startsAt || req.body.startDateTime),
      endDateTime: new Date(req.body.endsAt || req.body.endDateTime),
      sellerId,
      clientId: req.body.clientId,
      city: req.body.city,
      notes: req.body.notes,
      opportunityId: req.body.opportunityId,
      ...(req.body.stops?.length
        ? {
            stops: {
              create: req.body.stops.map((stop: any, index: number) => ({
                order: index + 1,
                clientId: stop.clientId,
                city: stop.city,
                address: stop.address,
                plannedTime: stop.plannedTime ? new Date(stop.plannedTime) : undefined,
                notes: stop.notes
              }))
            }
          }
        : {})
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

  if (event.clientId) {
    await createEvent({
      type: "status",
      description: buildAgendaCreatedDescription({ type: event.type, title: event.title }),
      clientId: event.clientId,
      ownerSellerId: event.sellerId
    });
  }

  if (event.type === "roteiro_visita" && event.stops?.length) {
    for (const stop of event.stops) {
      if (!stop.clientId) continue;
      const stopLabel = `Visita em roteiro planejada: ${event.title} (parada ${stop.order})`;
      await createEvent({
        type: "status",
        description: stopLabel,
        clientId: stop.clientId,
        ownerSellerId: event.sellerId
      });
    }
  }

  return res.status(201).json(mapAgendaEvent(event));
});

router.patch(["/agenda/:id", "/agenda/events/:id"], validateBody(agendaEventUpdateSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({
    where: { id: req.params.id },
    select: { sellerId: true, title: true, type: true, status: true, clientId: true }
  });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const updated = await prisma.agendaEvent.update({
    where: { id: req.params.id },
    data: {
      ...(req.body.title ? { title: req.body.title } : {}),
      ...((req.body.startsAt || req.body.startDateTime) ? { startDateTime: new Date(req.body.startsAt || req.body.startDateTime) } : {}),
      ...((req.body.endsAt || req.body.endDateTime) ? { endDateTime: new Date(req.body.endsAt || req.body.endDateTime) } : {}),
      ...(req.body.status ? { status: mapAgendaStatusToDb(req.body.status) } : {}),
      ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
      ...(req.body.city !== undefined ? { city: req.body.city } : {}),
      ...(req.body.opportunityId !== undefined ? { opportunityId: req.body.opportunityId } : {})
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

  const previousStatus = mapAgendaStatusFromDb(event.status);
  const currentStatus = mapAgendaStatusFromDb(updated.status);
  if (event.clientId && previousStatus !== currentStatus && (currentStatus === "completed" || currentStatus === "cancelled")) {
    await createEvent({
      type: "status",
      description: buildAgendaStatusDescription(currentStatus, { type: updated.type, title: updated.title }),
      clientId: event.clientId,
      ownerSellerId: updated.sellerId
    });
  }

  return res.json(mapAgendaEvent(updated));
});

router.post("/agenda/events/:id/stops", validateBody(agendaStopCreateSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({ where: { id: req.params.id }, include: { stops: true } });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const stop = await prisma.agendaStop.create({
    data: {
      agendaEventId: req.params.id,
      order: event.stops.length + 1,
      clientId: req.body.clientId,
      city: req.body.city,
      address: req.body.address,
      plannedTime: req.body.plannedTime ? new Date(req.body.plannedTime) : undefined,
      notes: req.body.notes
    },
    include: { client: { select: { name: true } } }
  });

  return res.status(201).json({
    id: stop.id,
    order: stop.order,
    clientId: stop.clientId,
    clientName: stop.client?.name || null,
    city: stop.city,
    address: stop.address,
    plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
    notes: stop.notes
  });
});

router.patch("/agenda/events/:id/stops/reorder", validateBody(agendaStopReorderSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({ where: { id: req.params.id }, select: { sellerId: true } });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  await prisma.$transaction(
    req.body.stopIds.map((stopId: string, index: number) =>
      prisma.agendaStop.update({ where: { id: stopId }, data: { order: index + 1 } })
    )
  );

  const stops = await prisma.agendaStop.findMany({
    where: { agendaEventId: req.params.id },
    include: { client: { select: { name: true } } },
    orderBy: { order: "asc" }
  });

  return res.json(
    stops.map((stop) => ({
      id: stop.id,
      order: stop.order,
      clientId: stop.clientId,
      clientName: stop.client?.name || null,
      city: stop.city,
      address: stop.address,
      plannedTime: stop.plannedTime ? stop.plannedTime.toISOString() : null,
      notes: stop.notes
    }))
  );
});

router.patch(["/agenda-events/:id/check-in", "/agenda/events/:id/check-in"], validateBody(agendaStopGeoSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({ where: { id: req.params.id }, include: { agendaEvent: { select: { sellerId: true } } } });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const checkInAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
  const updated = await prisma.agendaStop.update({
    where: { id: req.params.id },
    data: {
      checkInAt,
      checkInLat: req.body.lat ?? null,
      checkInLng: req.body.lng ?? null,
      checkInAccuracy: req.body.accuracy ?? null
    }
  });
  return res.json({
    id: updated.id,
    checkInAt: updated.checkInAt?.toISOString() || null,
    checkInLat: updated.checkInLat,
    checkInLng: updated.checkInLng,
    checkInAccuracy: updated.checkInAccuracy
  });
});

router.patch(["/agenda-events/:id/check-out", "/agenda/events/:id/check-out"], validateBody(agendaStopGeoSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({ where: { id: req.params.id }, include: { agendaEvent: { select: { sellerId: true } } } });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const checkOutAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
  const updated = await prisma.agendaStop.update({
    where: { id: req.params.id },
    data: {
      checkOutAt,
      checkOutLat: req.body.lat ?? null,
      checkOutLng: req.body.lng ?? null,
      checkOutAccuracy: req.body.accuracy ?? null
    }
  });
  return res.json({
    id: updated.id,
    checkOutAt: updated.checkOutAt?.toISOString() || null,
    checkOutLat: updated.checkOutLat,
    checkOutLng: updated.checkOutLng,
    checkOutAccuracy: updated.checkOutAccuracy
  });
});

router.patch(["/agenda-events/:id/result", "/agenda/events/:id/result"], validateBody(agendaStopResultSchema), async (req, res) => {
  const stop = await prisma.agendaStop.findUnique({
    where: { id: req.params.id },
    include: { agendaEvent: { select: { sellerId: true, title: true } } }
  });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  if (req.body.status === "nao_realizada" && !req.body.reason) {
    return res.status(400).json({ message: "Motivo é obrigatório quando a visita não é realizada." });
  }
  const ownerSellerIdForAutoActivity = stop.agendaEvent.sellerId || req.user!.id;
  if (req.body.status === "realizada" && !stop.clientId) {
    return res.status(400).json({ message: "clientId é obrigatório para registrar atividade automática da parada." });
  }
  if (req.body.status === "realizada" && !ownerSellerIdForAutoActivity) {
    return res.status(400).json({ message: "ownerSellerId é obrigatório para registrar atividade automática da parada." });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const completionAt = req.body.status === "realizada" ? (stop.checkOutAt ?? new Date()) : null;
    const updatedStop = await tx.agendaStop.update({
      where: { id: req.params.id },
      data: {
        resultStatus: req.body.status,
        resultReason: req.body.reason,
        resultSummary: req.body.summary,
        nextStep: req.body.nextStep,
        nextStepDate: req.body.nextStepDate ? new Date(req.body.nextStepDate) : null,
        ...(completionAt && !stop.checkOutAt ? { checkOutAt: completionAt } : {})
      }
    });

    if (req.body.status === "realizada") {
      const executionDate = updatedStop.checkOutAt ?? completionAt;
      if (!executionDate) {
        throw new Error("Não foi possível determinar o horário de conclusão da parada.");
      }
      const ownerSellerId = ownerSellerIdForAutoActivity!;
      const clientId = updatedStop.clientId || stop.clientId!;
      const stopRefToken = `[AUTO_AGENDA_STOP:${updatedStop.id}]`;
      const summary = (req.body.summary || "").trim();
      const agendaTitle = stop.agendaEvent.title?.trim() || "Roteiro de visita";
      const notes = summary || `Parada do roteiro "${agendaTitle}" concluída.`;
      const result = summary || "Visita realizada em parada de roteiro.";
      const description = `Visita em roteiro (${agendaTitle}) ${stopRefToken}`;
      const activityData = {
        type: ActivityType.visita,
        done: true,
        notes,
        result,
        description,
        dueDate: executionDate,
        date: executionDate,
        agendaEventId: updatedStop.agendaEventId,
        ownerSellerId,
        clientId
      };

      const existingAutoActivity = await tx.activity.findFirst({
        where: {
          agendaEventId: updatedStop.agendaEventId,
          ownerSellerId,
          type: ActivityType.visita,
          description: { contains: stopRefToken }
        },
        orderBy: { createdAt: "asc" }
      });

      if (existingAutoActivity) {
        await tx.activity.update({
          where: { id: existingAutoActivity.id },
          data: activityData
        });
      } else {
        await tx.activity.create({ data: activityData });
      }
    }

    return updatedStop;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (updated.clientId) {
    const statusLabel = updated.resultStatus === "realizada" ? "Compromisso concluído" : "Compromisso cancelado";
    await createEvent({
      type: "status",
      description: `${statusLabel}: Visita em roteiro (${stop.agendaEvent.title})`,
      clientId: updated.clientId,
      ownerSellerId: stop.agendaEvent.sellerId
    });
  }

  return res.json({
    id: updated.id,
    resultStatus: updated.resultStatus,
    resultReason: updated.resultReason,
    resultSummary: updated.resultSummary,
    nextStep: updated.nextStep,
    nextStepDate: updated.nextStepDate ? updated.nextStepDate.toISOString() : null
  });
});


router.get("/settings/weekly-visit-minimum", async (_req, res) => {
  const weeklyVisitGoal = await getWeeklyVisitGoal();
  return res.json({ minimumWeeklyVisits: weeklyVisitGoal });
});

router.put(
  "/settings/weekly-visit-minimum",
  authorize("diretor"),
  validateBody(weeklyVisitMinimumSchema),
  async (req, res) => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: WEEKLY_VISIT_GOAL_KEY },
        update: { value: String(req.body.minimumWeeklyVisits) },
        create: { key: WEEKLY_VISIT_GOAL_KEY, value: String(req.body.minimumWeeklyVisits) },
        select: { value: true }
      });

      const parsedValue = parseWeeklyVisitGoal(config.value);
      weeklyVisitGoalCache.value = parsedValue;
      weeklyVisitGoalCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return res.json({ minimumWeeklyVisits: parsedValue });
    } catch (error) {
      console.error("[appConfig] Falha ao atualizar weeklyVisitGoal.", error);
      return res.status(200).json({ minimumWeeklyVisits: DEFAULT_WEEKLY_VISIT_GOAL });
    }
  }
);


router.get("/objectives", authorize("diretor", "gerente"), async (req, res) => {
  const parsedPeriod = parseObjectivePeriod(req.query.month as string | undefined, req.query.year as string | undefined);

  if (!parsedPeriod) {
    return res.status(400).json({ message: "Mês/ano inválidos" });
  }

  const goals = await prisma.goal.findMany({
    where: { month: parsedPeriod.monthKey },
    orderBy: { createdAt: "desc" }
  });

  return res.json(
    goals.map((goal) => ({
      id: goal.id,
      userId: goal.sellerId,
      month: parsedPeriod.month,
      year: parsedPeriod.year,
      amount: goal.targetValue,
      createdAt: goal.createdAt
    }))
  );
});

router.put("/objectives/:userId", authorize("diretor", "gerente"), validateBody(objectiveUpsertSchema), async (req, res) => {
  const { month, year, amount } = req.body;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const seller = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  if (amount === 0) {
    await prisma.goal.deleteMany({
      where: {
        sellerId: req.params.userId,
        month: monthKey
      }
    });

    return res.json({
      userId: req.params.userId,
      month,
      year,
      amount: null,
      removed: true
    });
  }

  const goal = await prisma.goal.upsert({
    where: {
      sellerId_month: {
        sellerId: req.params.userId,
        month: monthKey
      }
    },
    update: {
      targetValue: amount
    },
    create: {
      sellerId: req.params.userId,
      month: monthKey,
      targetValue: amount
    }
  });

  return res.json({
    id: goal.id,
    userId: goal.sellerId,
    month,
    year,
    amount: goal.targetValue,
    createdAt: goal.createdAt,
    removed: false
  });
});

router.delete("/objectives/:userId", authorize("diretor", "gerente"), async (req, res) => {
  const parsedPeriod = parseObjectivePeriod(req.query.month as string | undefined, req.query.year as string | undefined);

  if (!parsedPeriod) {
    return res.status(400).json({ message: "Mês/ano inválidos" });
  }

  const seller = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  await prisma.goal.deleteMany({
    where: {
      sellerId: req.params.userId,
      month: parsedPeriod.monthKey
    }
  });

  return res.status(204).send();
});

router.get("/goals", async (req, res) => {
  const sellerId = req.user!.role === "vendedor" ? req.user!.id : (req.query.sellerId as string | undefined);
  res.json(await prisma.goal.findMany({ where: sellerId ? { sellerId } : {}, include: { seller: { select: { name: true, email: true } } }, orderBy: [{ month: "desc" }] }));
});
router.get("/activity-kpis", async (req, res) => {
  const month = req.query.month as string | undefined;
  const sellerIdQuery = req.query.sellerId as string | undefined;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  const sellerId = req.user!.role === "vendedor" ? req.user!.id : sellerIdQuery;
  const { start, end } = getMonthRangeFromKey(month);

  const [activityKpis, monthActivityCounts, visitCountsBySeller] = await Promise.all([
    prisma.activityKPI.findMany({
      where: {
        month,
        ...(sellerId ? { sellerId } : {})
      },
      include: {
        seller: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: [{ sellerId: "asc" }, { type: "asc" }]
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId", "type"],
      where: {
        ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
        done: true,
        ...resolveExecutionActivityDateFilter(start, end)
      },
      _count: { _all: true }
    }),
    prisma.activity.groupBy({
      by: ["ownerSellerId"],
      where: {
        ...(sellerId ? { ownerSellerId: sellerId } : sellerWhere(req)),
        done: true,
        type: { in: [...VISIT_TYPES] },
        date: { gte: start, lte: end }
      },
      _count: { _all: true }
    })
  ]);

  const logicalCountBySellerAndType = new Map(
    monthActivityCounts.map((countEntry) => [`${countEntry.ownerSellerId}:${countEntry.type}`, countEntry._count._all])
  );
  const visitLogicalCountBySeller = new Map(visitCountsBySeller.map((countEntry) => [countEntry.ownerSellerId, countEntry._count._all]));

  return res.json(
    activityKpis.map((activityKpi) => ({
      ...activityKpi,
      logicalCount: VISIT_TYPES.includes(activityKpi.type as (typeof VISIT_TYPES)[number])
        ? (visitLogicalCountBySeller.get(activityKpi.sellerId) ?? 0)
        : (logicalCountBySellerAndType.get(`${activityKpi.sellerId}:${activityKpi.type}`) ?? 0)
    }))
  );
});

router.put("/activity-kpis/:sellerId", authorize("diretor", "gerente"), validateBody(activityKpiUpsertSchema), async (req, res) => {
  const seller = await prisma.user.findUnique({ where: { id: req.params.sellerId }, select: { id: true, role: true } });

  if (!seller || seller.role !== "vendedor") {
    return res.status(404).json({ message: "Vendedor não encontrado" });
  }

  const activityKpi = await prisma.activityKPI.upsert({
    where: {
      sellerId_month_type: {
        sellerId: req.params.sellerId,
        month: req.body.month,
        type: req.body.type
      }
    },
    update: {
      targetValue: req.body.targetValue
    },
    create: {
      sellerId: req.params.sellerId,
      month: req.body.month,
      type: req.body.type,
      targetValue: req.body.targetValue
    },
    include: {
      seller: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  return res.json(activityKpi);
});

router.post("/goals", authorize("diretor", "gerente"), validateBody(goalSchema), async (req, res) => res.status(201).json(await prisma.goal.create({ data: req.body })));
router.put("/goals/:id", authorize("diretor", "gerente"), validateBody(goalSchema.partial()), async (req, res) => res.json(await prisma.goal.update({ where: { id: req.params.id }, data: req.body })));
router.delete("/goals/:id", authorize("diretor", "gerente"), async (req, res) => { await prisma.goal.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/users", authorize("diretor", "gerente"), async (_req, res) => res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, region: true, isActive: true, createdAt: true } })));
router.post("/users", authorize("diretor"), validateBody(userCreateSchema), async (req, res) => {
  const { name, email, password, role, region } = req.body;
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role, region } });
  return res.status(201).json({ success: true, message: "Usuário criado com sucesso.", data: { id: user.id, email: user.email } });
});
router.put("/users/:id", authorize("diretor"), validateBody(userUpdateSchema), async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role, region } = req.body;

  if (req.user!.id === id && role !== "diretor") {
    return res.status(400).json({ success: false, message: "Você não pode remover seu próprio papel de diretor." });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado." });

    const data: Record<string, unknown> = { name, email, role, region };

    if (typeof password === "string" && password.trim().length > 0) {
      data.passwordHash = await hashPassword(password);
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, region: true, isActive: true, createdAt: true }
    });

    return res.json({ success: true, message: "Usuário atualizado com sucesso.", data: updated });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ success: false, message: "Já existe outro usuário com este e-mail corporativo." });
    }

    console.error("[users:update]", error);
    return res.status(500).json({ success: false, message: "Não foi possível atualizar o usuário.", details: error?.message });
  }
});
router.patch("/users/:id/region", authorize("diretor", "gerente"), async (req, res) => res.json(await prisma.user.update({ where: { id: req.params.id }, data: { region: req.body.region } })));
router.patch("/users/:id/active", authorize("diretor"), validateBody(userActivationSchema), async (req, res) => {
  if (req.user!.id === req.params.id && !req.body.isActive) {
    return res.status(400).json({ message: "Você não pode desativar seu próprio usuário" });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: req.body.isActive },
    select: { id: true, name: true, role: true, isActive: true }
  });

  return res.json(updatedUser);
});
router.patch("/users/:id/role", authorize("diretor"), validateBody(userRoleUpdateSchema), async (req, res) => {
  if (req.user!.id === req.params.id && req.body.role !== "diretor") {
    return res.status(400).json({ message: "Você não pode remover seu próprio papel de diretor" });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { role: req.body.role },
    select: { id: true, name: true, role: true, isActive: true }
  });

  return res.json(updatedUser);
});
router.post("/users/:id/reset-password", authorize("diretor"), validateBody(userResetPasswordSchema), async (req, res) => {
  const temporaryPasswordLength = req.body.temporaryPasswordLength ?? 12;
  const temporaryPassword = randomBytes(temporaryPasswordLength).toString("base64url").slice(0, temporaryPasswordLength);
  const passwordHash = await hashPassword(temporaryPassword);

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash },
    select: { id: true, name: true, email: true }
  });

  return res.json({
    message: "Senha resetada com sucesso",
    user: updatedUser,
    temporaryPassword
  });
});
router.delete("/users/:id", authorize("diretor"), async (req, res) => {
  const { id } = req.params;

  if (req.user!.id === id) {
    return res.status(400).json({ success: false, message: "Você não pode excluir seu próprio usuário." });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    }

    if (user.role === "diretor") {
      const directorsCount = await prisma.user.count({ where: { role: "diretor" } });
      if (directorsCount <= 1) {
        return res.status(400).json({ success: false, message: "Não é possível excluir o último diretor." });
      }
    }

    if (user.role === "gerente") {
      const managersCount = await prisma.user.count({ where: { role: "gerente" } });
      if (managersCount <= 1) {
        return res.status(400).json({ success: false, message: "Não é possível excluir o último gerente." });
      }
    }

    await prisma.goal.deleteMany({
      where: {
        sellerId: id,
        targetValue: { lte: 0 }
      }
    });

    const [clientsCount, opportunitiesCount, activitiesCount, agendaEventsCount, contactsCount, timelineEventsCount, goalsCount, activityKpisCount, salesCount] =
      await Promise.all([
        prisma.client.count({ where: { ownerSellerId: id } }),
        prisma.opportunity.count({ where: { ownerSellerId: id } }),
        prisma.activity.count({ where: { ownerSellerId: id } }),
        prisma.agendaEvent.count({ where: { sellerId: id } }),
        prisma.contact.count({ where: { ownerSellerId: id } }),
        prisma.timelineEvent.count({ where: { ownerSellerId: id } }),
        prisma.goal.count({ where: { sellerId: id, targetValue: { gt: 0 } } }),
        prisma.activityKPI.count({ where: { sellerId: id } }),
        prisma.sale.count({ where: { sellerId: id } })
      ]);

    if (clientsCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem clientes vinculados." });
    }

    if (opportunitiesCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem oportunidades vinculadas." });
    }

    if (activitiesCount > 0 || agendaEventsCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem atividades/agendas vinculadas." });
    }

    if (contactsCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem contatos vinculados." });
    }

    if (timelineEventsCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem eventos vinculados." });
    }

    if (goalsCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Não é possível excluir este usuário porque existem objetivos mensais vinculados. Remova os objetivos na aba Equipe e tente novamente."
      });
    }

    if (activityKpisCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem KPIs vinculados." });
    }

    if (salesCount > 0) {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem vendas vinculadas." });
    }

    await prisma.user.delete({ where: { id } });
    return res.json({ success: true, message: "Usuário excluído com sucesso." });
  } catch (error: any) {
    if (error?.code === "P2003") {
      return res.status(400).json({ success: false, message: "Não é possível excluir este usuário porque existem vínculos ativos em outros registros." });
    }

    console.error("[users:delete]", error);
    return res.status(500).json({ success: false, message: "Não foi possível excluir o usuário.", details: error?.message });
  }
});


const listCulturesHandler = async (req: express.Request, res: express.Response) => {
  const parsedQuery = cultureQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: parsedQuery.error.issues[0]?.message || "Parâmetros inválidos." });
  }

  const { active, search, tags, category, page = 1, pageSize = 20 } = parsedQuery.data;
  const where: Prisma.CultureCatalogWhereInput = {
    ...(active ? { isActive: active === "true" } : {}),
    ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
    ...(search
      ? {
          OR: [
            { label: { contains: search, mode: "insensitive" } },
            { slug: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(tags
      ? {
          tags: {
            hasSome: tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.cultureCatalog.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { label: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.cultureCatalog.count({ where }),
  ]);

  return res.status(200).json({ data: items, total, page, pageSize });
};

router.get("/cultures", listCulturesHandler);
router.get("/technical/cultures", listCulturesHandler);
router.get("/technical-cultures", async (_req, res) => {
  try {
    const dbCultures = await prisma.cultureCatalog.findMany({
      where: { isActive: true },
      orderBy: [{ label: "asc" }],
      select: {
        slug: true,
        label: true,
        category: true,
        defaultKgHaMin: true,
        defaultKgHaMax: true,
        pmsDefault: true,
        populationTargetDefault: true,
        rowSpacingCmDefault: true,
        germinationDefault: true,
        purityDefault: true,
        notes: true,
      },
    });

    if (!dbCultures.length) {
      return res.status(200).json({ items: TECHNICAL_CULTURES_STATIC_SEED, source: "seed" });
    }

    return res.status(200).json({ items: dbCultures.map(serializeTechnicalCultureCatalogItem), source: "db" });
  } catch (error) {
    console.error("[technical-cultures] Falha ao carregar do banco. Usando catálogo static.", error);
    return res.status(200).json({ items: TECHNICAL_CULTURES_STATIC_SEED, source: "static" });
  }
});

router.post("/cultures", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const created = await prisma.cultureCatalog.create({ data: payload });
    res.status(201).json(created);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    next(error);
  }
});

router.put("/cultures/:id", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: payload });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

router.delete("/cultures/:id", authorize("diretor", "gerente"), async (req, res, next) => {
  try {
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});


router.post("/technical/cultures", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const created = await prisma.cultureCatalog.create({ data: payload });
    res.status(201).json(created);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    next(error);
  }
});

router.put("/technical/cultures/:id", authorize("diretor", "gerente"), validateBody(cultureCatalogSchema), async (req, res, next) => {
  try {
    const payload = normalizeCulturePayload(req.body);
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: payload });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Slug já cadastrado." });
    }
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

router.delete("/technical/cultures/:id", authorize("diretor", "gerente"), async (req, res, next) => {
  try {
    const updated = await prisma.cultureCatalog.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(200).json(updated);
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Cultura não encontrada." });
    }
    next(error);
  }
});

export default router;
