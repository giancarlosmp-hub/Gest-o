import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import {
  activityKpiUpsertSchema,
  activitySchema,
  clientContactSchema,
  clientSchema,
  companySchema,
  contactSchema,
  eventSchema,
  goalSchema,
  objectiveUpsertSchema,
  opportunitySchema,
  userActivationSchema,
  userCreateSchema,
  userResetPasswordSchema,
  userRoleUpdateSchema,
  weeklyVisitMinimumSchema
} from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";
import { normalizeCnpj, normalizeState, normalizeText } from "../utils/normalize.js";
import { randomBytes } from "node:crypto";
import { buildTimelineEventWhere } from "./timelineEventWhere.js";
import { ActivityType, ClientType, Prisma } from "@prisma/client";
import { z } from "zod";

const router = Router();
router.use(authMiddleware);

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

const getStageFilter = (stage?: string) => (stage ? STAGE_ALIASES[stage] : undefined);
type OpportunityStatusFilter = "open" | "closed" | "all";
const getOpportunityStatusFilter = (status?: string): OpportunityStatusFilter | undefined => {
  if (!status) return "open";
  if (status === "open" || status === "closed" || status === "all") return status;
  return undefined;
};
const getWeightedValue = (value: number, probability?: number | null) => value * ((probability ?? 0) / 100);

const getDaysOverdue = (expectedCloseDate: Date, stage: string, todayStart: Date) => {
  if (CLOSED_STAGES.has(stage)) return null;
  if (expectedCloseDate >= todayStart) return null;
  return Math.floor((todayStart.getTime() - expectedCloseDate.getTime()) / 86400000);
};

const serializeOpportunity = (opportunity: any, todayStart: Date) => ({
  ...opportunity,
  proposalDate: opportunity.proposalDate.toISOString(),
  followUpDate: opportunity.followUpDate.toISOString(),
  expectedCloseDate: opportunity.expectedCloseDate.toISOString(),
  lastContactAt: opportunity.lastContactAt ? opportunity.lastContactAt.toISOString() : null,
  plantingForecastDate: opportunity.plantingForecastDate ? opportunity.plantingForecastDate.toISOString() : null,
  createdAt: opportunity.createdAt.toISOString(),
  client: opportunity.client?.name,
  clientCity: opportunity.client?.city || null,
  clientState: opportunity.client?.state || null,
  owner: opportunity.ownerSeller?.name,
  daysOverdue: getDaysOverdue(opportunity.expectedCloseDate, opportunity.stage, todayStart),
  weightedValue: getWeightedValue(opportunity.value, opportunity.probability)
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

const DEFAULT_MINIMUM_WEEKLY_VISITS = 25;
const MINIMUM_WEEKLY_VISITS_KEY = "minimumWeeklyVisits";
const APP_CONFIG_CACHE_TTL_MS = 60_000;

const minimumWeeklyVisitsCache: {
  value: number;
  expiresAt: number;
  pending: Promise<number> | null;
} = {
  value: DEFAULT_MINIMUM_WEEKLY_VISITS,
  expiresAt: 0,
  pending: null
};

const parseMinimumWeeklyVisits = (value: string | null | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MINIMUM_WEEKLY_VISITS;
};

const getMinimumWeeklyVisits = async () => {
  const now = Date.now();
  if (minimumWeeklyVisitsCache.expiresAt > now) {
    return minimumWeeklyVisitsCache.value;
  }

  if (minimumWeeklyVisitsCache.pending) {
    return minimumWeeklyVisitsCache.pending;
  }

  minimumWeeklyVisitsCache.pending = (async () => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: MINIMUM_WEEKLY_VISITS_KEY },
        update: {},
        create: { key: MINIMUM_WEEKLY_VISITS_KEY, value: String(DEFAULT_MINIMUM_WEEKLY_VISITS) },
        select: { value: true }
      });

      const parsedValue = parseMinimumWeeklyVisits(config.value);
      minimumWeeklyVisitsCache.value = parsedValue;
      minimumWeeklyVisitsCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return parsedValue;
    } catch (error) {
      console.error("[appConfig] Falha ao obter minimumWeeklyVisits. Usando fallback padrão.", error);
      minimumWeeklyVisitsCache.value = DEFAULT_MINIMUM_WEEKLY_VISITS;
      minimumWeeklyVisitsCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return DEFAULT_MINIMUM_WEEKLY_VISITS;
    } finally {
      minimumWeeklyVisitsCache.pending = null;
    }
  })();

  return minimumWeeklyVisitsCache.pending;
};

const getActivityCountByTypeInMonth = async (ownerSellerId: string, type: ActivityType, monthKey: string) => {
  const { start, end } = getMonthRangeFromKey(monthKey);
  return prisma.activity.count({
    where: {
      ownerSellerId,
      type,
      createdAt: { gte: start, lte: end }
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
const agendaEventStatusSchema = z.enum(["agendado", "realizado", "vencido"]);

const agendaEventCreateSchema = z.object({
  title: z.string().min(2),
  type: agendaEventTypeSchema,
  startDateTime: z.string(),
  endDateTime: z.string(),
  ownerSellerId: z.string().optional(),
  sellerId: z.string().optional(),
  clientId: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
  opportunityId: z.string().optional()
});

const agendaEventUpdateSchema = z.object({
  title: z.string().min(2).optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
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

class DuplicateClientError extends Error {
  statusCode: number;

  constructor(message = DUPLICATE_CLIENT_MESSAGE) {
    super(message);
    this.name = "DuplicateClientError";
    this.statusCode = 409;
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

const ensureClientIsNotDuplicate = async ({
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

    if (existingByCnpj) throw new DuplicateClientError();
    return;
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

  if (existingByIdentity) throw new DuplicateClientError();
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

const clientImportRowSchema = clientSchema.extend({
  sourceRowNumber: z.number().int().positive().optional(),
  existingClientId: z.string().optional(),
  action: clientImportActionSchema
});

const clientImportRequestSchema = z.object({
  rows: z.array(clientImportRowSchema).optional(),
  clients: z.array(clientImportRowSchema).optional()
});

const resolveImportRows = (body: unknown) => {
  const parsed = clientImportRequestSchema.safeParse(body);
  if (!parsed.success) return { rows: [] as z.infer<typeof clientImportRowSchema>[], isValid: false };
  const rows = parsed.data.rows ?? parsed.data.clients ?? [];
  return { rows, isValid: true };
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

const isMeaningfulImportString = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "-";
};

const resolveImportUpdateData = (payload: z.infer<typeof clientSchema>, req: any, existingClient: any) => {
  const data: Record<string, unknown> = {};

  if (isMeaningfulImportString(payload.name)) data.name = payload.name.trim();
  if (isMeaningfulImportString(payload.city)) data.city = payload.city.trim();
  if (isMeaningfulImportString(payload.state)) data.state = payload.state.trim();
  if (isMeaningfulImportString(payload.region)) data.region = payload.region.trim();
  const segmentValue = payload.segment;
  if (typeof segmentValue === "string" && isMeaningfulImportString(segmentValue)) data.segment = segmentValue.trim();

  const clientTypeValue = payload.clientType;
  if (typeof clientTypeValue === "string" && isMeaningfulImportString(clientTypeValue)) {
    data.clientType = clientTypeValue.trim().toUpperCase();
  }

  const cnpjValue = payload.cnpj;
  if (typeof cnpjValue === "string" && isMeaningfulImportString(cnpjValue)) data.cnpj = cnpjValue.trim();

  if (typeof payload.potentialHa === "number" && Number.isFinite(payload.potentialHa) && payload.potentialHa >= 0) {
    data.potentialHa = payload.potentialHa;
  }

  if (typeof payload.farmSizeHa === "number" && Number.isFinite(payload.farmSizeHa) && payload.farmSizeHa >= 0) {
    data.farmSizeHa = payload.farmSizeHa;
  }

  const ownerSellerValue = payload.ownerSellerId;
  if (req.user?.role !== "vendedor" && typeof ownerSellerValue === "string" && isMeaningfulImportString(ownerSellerValue)) {
    data.ownerSellerId = ownerSellerValue.trim();
  }

  const mergedClientForValidation = {
    name: (data.name as string | undefined) ?? existingClient.name,
    city: (data.city as string | undefined) ?? existingClient.city,
    state: (data.state as string | undefined) ?? existingClient.state,
    cnpj: (data.cnpj as string | undefined) ?? existingClient.cnpj
  };

  const normalized = normalizeClientForComparison(mergedClientForValidation);

  return {
    data: {
      ...data,
      state: normalized.state,
      nameNormalized: normalized.nameNormalized,
      cityNormalized: normalized.cityNormalized,
      cnpjNormalized: normalized.cnpjNormalized || null
    },
    mergedClientForValidation
  };
};

const buildImportPreview = async (req: any, rows: z.infer<typeof clientImportRowSchema>[]): Promise<ImportPreviewItem[]> => {
  const scopedWhere = sellerWhere(req);

  // Carrega o mínimo necessário para deduplicação
  const existingClients = await prisma.client.findMany({
    where: scopedWhere,
    select: { id: true, cnpj: true, name: true, city: true, state: true }
  });

  // Indexa base por doc e por fingerprint name/city/state
  const existingByDoc = new Map<string, string>();
  const existingByFingerprint = new Map<string, string>();

  existingClients.forEach((c) => {
    const doc = normalizeCnpj(c.cnpj);
    if (doc) existingByDoc.set(doc, c.id);

    const fp = buildDuplicateFingerprint({
      cnpj: null,
      name: c.name,
      city: c.city,
      state: c.state
    });
    existingByFingerprint.set(fp, c.id);
  });

  // Dedup dentro do arquivo
  const fileFingerprintCount = new Map<string, number>();

  // Primeiro passo: valida e resolve ownerSellerId, e computa fingerprints do arquivo
  const prepared = rows.map((row, index) => {
    const parsedRow = clientSchema.safeParse(row);
    const rowNumber = Number(row.sourceRowNumber ?? index + 2);

    if (!parsedRow.success) {
      const message = parsedRow.error.issues[0]?.message ?? "Dados inválidos para importação.";
      return { kind: "error" as const, rowNumber, row, error: message };
    }

    const ownerSellerId =
      req.user!.role === "vendedor"
        ? req.user!.id
        : req.user!.role === "gerente" || req.user!.role === "diretor"
          ? resolveOwnerId(req, parsedRow.data.ownerSellerId)
          : resolveOwnerId(req);

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
    if (doc) {
      const existingId = existingByDoc.get(doc);
      if (existingId) {
        return {
          rowNumber: p.rowNumber,
          row: p.row,
          status: "duplicate" as const,
          existingClientId: existingId,
          payload: p.payload,
          reason: "Cliente já existe (documento)"
        };
      }
    } else {
      const fp = buildDuplicateFingerprint({
        cnpj: null,
        name: p.payload.name,
        city: p.payload.city,
        state: p.payload.state
      });
      const existingId = existingByFingerprint.get(fp);
      if (existingId) {
        return {
          rowNumber: p.rowNumber,
          row: p.row,
          status: "duplicate" as const,
          existingClientId: existingId,
          payload: p.payload,
          reason: "Cliente já existe (nome/cidade/UF)"
        };
      }
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

// ==============================
// ROUTES
// ==============================

router.get("/reports/agro-crm", async (req, res) => {
  const todayStart = getUtcTodayStart();
  const opportunities = await prisma.opportunity.findMany({
    where: sellerWhere(req),
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

    const isOverdue = opportunity.expectedCloseDate < todayStart && !CLOSED_STAGES.has(opportunity.stage);
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

  const orderedStages = ["prospeccao", "negociacao", "proposta", "ganho"];
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

  const plannedEvents = await prisma.agendaEvent.findMany({
    where: {
      type: "roteiro_visita",
      startDateTime: { gte: from, lte: to },
      ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
    },
    select: {
      id: true,
      sellerId: true,
      startDateTime: true,
      opportunityId: true,
      seller: { select: { name: true } },
      stops: {
        select: {
          plannedTime: true,
          checkInAt: true,
          checkOutAt: true
        },
        orderBy: { order: "asc" }
      }
    }
  });

  const followUpWhere: Prisma.ActivityWhereInput = {
    type: "follow_up",
    createdAt: { gte: from, lte: to },
    ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {})
  };

  const followUps = await prisma.activity.findMany({
    where: followUpWhere,
    select: { ownerSellerId: true }
  });

  const followUpsBySeller = followUps.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerSellerId] = (acc[item.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const opportunitiesBySeller = plannedEvents.reduce<Record<string, Set<string>>>((acc, event) => {
    if (!event.opportunityId) return acc;
    if (!acc[event.sellerId]) acc[event.sellerId] = new Set<string>();
    acc[event.sellerId].add(event.opportunityId);
    return acc;
  }, {});

  const punctualToleranceMs = 10 * 60 * 1000;

  const sellerStatsMap = plannedEvents.reduce<
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
  >((acc, event) => {
    const sellerStat =
      acc[event.sellerId] ||
      (acc[event.sellerId] = {
        sellerId: event.sellerId,
        sellerName: event.seller.name,
        planned: 0,
        executed: 0,
        punctualCount: 0
      });

    sellerStat.planned += 1;

    const firstStopWithCheckIn = event.stops.find((stop) => Boolean(stop.checkInAt));
    const hasCheckout = event.stops.some((stop) => Boolean(stop.checkOutAt));

    if (hasCheckout) {
      sellerStat.executed += 1;
    }

    if (firstStopWithCheckIn) {
      const plannedReference = firstStopWithCheckIn.plannedTime || event.startDateTime;
      const checkInAt = firstStopWithCheckIn.checkInAt!;
      if (checkInAt.getTime() <= plannedReference.getTime() + punctualToleranceMs) {
        sellerStat.punctualCount += 1;
      }
    }

    return acc;
  }, {});

  const sellers = Object.values(sellerStatsMap).map((stats) => {
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

  const totalPlanned = sellers.reduce((sum, item) => sum + item.planned, 0);
  const totalExecuted = sellers.reduce((sum, item) => sum + item.executed, 0);
  const totalNotExecuted = sellers.reduce((sum, item) => sum + item.notExecuted, 0);
  const totalPunctual = sellers.reduce((sum, item) => sum + (item.punctualRate / 100) * item.executed, 0);
  const followUpGenerated = sellers.reduce((sum, item) => sum + item.followUps, 0);
  const opportunitiesGenerated = sellers.reduce((sum, item) => sum + item.opportunities, 0);

  return res.json({
    totalPlanned,
    totalExecuted,
    totalNotExecuted,
    executionRate: totalPlanned ? (totalExecuted / totalPlanned) * 100 : 0,
    punctualRate: totalExecuted ? (totalPunctual / totalExecuted) * 100 : 0,
    followUpGenerated,
    opportunitiesGenerated,
    sellers: sellers.sort((a, b) => b.executionRate - a.executionRate)
  });
});

router.get("/reports/weekly-discipline", async (req, res) => {
  const weekStart = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromMonday(weekStart);

  if (!range) {
    return res.status(400).json({ message: "weekStart deve estar no formato YYYY-MM-DD e ser uma segunda-feira." });
  }

  const scopedSellerId = undefined;
  const [minimumRequired, sellers, plannedBySeller, executedBySeller] = await Promise.all([
    getMinimumWeeklyVisits(),
    prisma.user.findMany({
      where: {
        role: "vendedor",
        isActive: true,
        ...(scopedSellerId ? { id: scopedSellerId } : {})
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: range.start, lte: range.end },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    }),
    prisma.agendaEvent.groupBy({
      by: ["sellerId"],
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: range.start, lte: range.end },
        stops: {
          some: {
            checkOutAt: { not: null }
          }
        },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      _count: { _all: true }
    })
  ]);

  const plannedMap = plannedBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  const executedMap = executedBySeller.reduce<Record<string, number>>((acc, item) => {
    acc[item.sellerId] = item._count._all;
    return acc;
  }, {});

  return res.json(
    sellers.map((seller) => {
      const planned = plannedMap[seller.id] || 0;
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        planned,
        executed: executedMap[seller.id] || 0,
        minimumRequired,
        belowMinimum: planned < minimumRequired
      };
    })
  );
});

router.get("/reports/discipline-ranking", async (req, res) => {
  const fromRaw = req.query.from as string | undefined;
  const toRaw = req.query.to as string | undefined;

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ message: "Parâmetros from e to são obrigatórios." });
  }

  const from = normalizeDateToUtc(fromRaw);
  const to = normalizeDateToUtc(toRaw, true);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const scopedSellerId = undefined;
  const punctualToleranceMs = 10 * 60 * 1000;
  const inactivityWindow = getLastBusinessDaysWindow(3);
  const minimumWeeklyVisits = await getMinimumWeeklyVisits();

  const plannedEvents = await prisma.agendaEvent.findMany({
    where: {
      type: "roteiro_visita",
      startDateTime: { gte: from, lte: to },
      ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
    },
    select: {
      id: true,
      sellerId: true,
      opportunityId: true,
      seller: { select: { name: true } },
      stops: {
        select: {
          plannedTime: true,
          checkInAt: true,
          checkOutAt: true
        },
        orderBy: { order: "asc" }
      }
    }
  });

  const sellersWithRecentVisits = await prisma.agendaEvent.groupBy({
    by: ["sellerId"],
    where: {
      type: "roteiro_visita",
      startDateTime: { gte: inactivityWindow.start, lte: inactivityWindow.end },
      stops: {
        some: {
          checkOutAt: { not: null }
        }
      },
      ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
    }
  });

  const activeSellersInWindow = new Set(sellersWithRecentVisits.map((item) => item.sellerId));

  const opportunities = Array.from(new Set(plannedEvents.map((event) => event.opportunityId).filter(Boolean))) as string[];

  const followUps = opportunities.length
    ? await prisma.activity.findMany({
        where: {
          type: "follow_up",
          createdAt: { gte: from, lte: to },
          ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {}),
          opportunityId: { in: opportunities }
        },
        select: {
          ownerSellerId: true,
          opportunityId: true,
          createdAt: true
        }
      })
    : [];

  const followUpsIndex = followUps.reduce<Record<string, Date[]>>((acc, followUp) => {
    if (!followUp.opportunityId) return acc;
    const key = `${followUp.ownerSellerId}:${followUp.opportunityId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(followUp.createdAt);
    return acc;
  }, {});

  const statsBySeller = plannedEvents.reduce<
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
  >((acc, event) => {
    const sellerStats =
      acc[event.sellerId] ||
      (acc[event.sellerId] = {
        sellerId: event.sellerId,
        sellerName: event.seller.name,
        planned: 0,
        executed: 0,
        punctual: 0,
        followUpAfterVisit: 0
      });

    sellerStats.planned += 1;

    const firstStopWithCheckIn = event.stops.find((stop) => Boolean(stop.checkInAt));
    const firstCheckout = event.stops.find((stop) => Boolean(stop.checkOutAt))?.checkOutAt;

    if (firstCheckout) {
      sellerStats.executed += 1;

      if (event.opportunityId) {
        const key = `${event.sellerId}:${event.opportunityId}`;
        const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= firstCheckout.getTime());
        if (hasFollowUpAfterVisit) {
          sellerStats.followUpAfterVisit += 1;
        }
      }
    }

    if (firstStopWithCheckIn) {
      const plannedReference = firstStopWithCheckIn.plannedTime;
      const checkInAt = firstStopWithCheckIn.checkInAt!;
      if (plannedReference && checkInAt.getTime() <= plannedReference.getTime() + punctualToleranceMs) {
        sellerStats.punctual += 1;
      }
    }

    return acc;
  }, {});

  const ranking = Object.values(statsBySeller)
    .map((stats) => {
      const executionRate = stats.planned ? (stats.executed / stats.planned) * 100 : 0;
      const punctualRate = stats.executed ? (stats.punctual / stats.executed) * 100 : 0;
      const followUpRate = stats.executed ? (stats.followUpAfterVisit / stats.executed) * 100 : 0;
      const baseDisciplineScore = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const isUnderExecutionThreshold = executionRate < 60;
      const hasInactivityFlag = !activeSellersInWindow.has(stats.sellerId);
      const disciplineScoreBase = isUnderExecutionThreshold ? baseDisciplineScore * 0.9 : baseDisciplineScore;
      const volumeFactor = stats.planned < minimumWeeklyVisits ? stats.planned / minimumWeeklyVisits : 1;
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

router.get("/reports/weekly-highlights", async (req, res) => {
  const weekStartRaw = String(req.query.weekStart || "").trim();
  const range = getWeekRangeFromStart(weekStartRaw);

  if (!range) {
    return res.status(400).json({ message: "Parâmetro weekStart inválido. Use YYYY-MM-DD." });
  }

  const punctualToleranceMs = 10 * 60 * 1000;
  const minimumWeeklyVisits = await getMinimumWeeklyVisits();

  const [sellers, currentSales, previousSales, plannedEvents, opportunitiesCreated] = await Promise.all([
    prisma.user.findMany({
      where: { role: "vendedor" },
      select: { id: true, name: true }
    }),
    prisma.sale.groupBy({
      by: ["sellerId"],
      where: { date: { gte: range.start, lte: range.end } },
      _sum: { value: true }
    }),
    prisma.sale.groupBy({
      by: ["sellerId"],
      where: { date: { gte: range.previousStart, lte: range.previousEnd } },
      _sum: { value: true }
    }),
    prisma.agendaEvent.findMany({
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: range.start, lte: range.end }
      },
      select: {
        id: true,
        sellerId: true,
        opportunityId: true,
        stops: {
          select: {
            plannedTime: true,
            checkInAt: true,
            checkOutAt: true
          },
          orderBy: { order: "asc" }
        }
      }
    }),
    prisma.opportunity.findMany({
      where: { createdAt: { gte: range.start, lte: range.end } },
      select: { ownerSellerId: true }
    })
  ]);

  const opportunities = Array.from(new Set(plannedEvents.map((event) => event.opportunityId).filter(Boolean))) as string[];

  const followUps = opportunities.length
    ? await prisma.activity.findMany({
        where: {
          type: "follow_up",
          createdAt: { gte: range.start, lte: range.end },
          opportunityId: { in: opportunities }
        },
        select: {
          ownerSellerId: true,
          opportunityId: true,
          createdAt: true
        }
      })
    : [];

  const currentSalesMap = currentSales.reduce<Record<string, number>>((acc, row) => {
    acc[row.sellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const previousSalesMap = previousSales.reduce<Record<string, number>>((acc, row) => {
    acc[row.sellerId] = row._sum.value ?? 0;
    return acc;
  }, {});

  const opportunitiesCreatedMap = opportunitiesCreated.reduce<Record<string, number>>((acc, row) => {
    acc[row.ownerSellerId] = (acc[row.ownerSellerId] || 0) + 1;
    return acc;
  }, {});

  const followUpsIndex = followUps.reduce<Record<string, Date[]>>((acc, followUp) => {
    if (!followUp.opportunityId) return acc;
    const key = `${followUp.ownerSellerId}:${followUp.opportunityId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(followUp.createdAt);
    return acc;
  }, {});

  const disciplineBySeller = plannedEvents.reduce<
    Record<
      string,
      {
        planned: number;
        executed: number;
        punctual: number;
        followUpAfterVisit: number;
      }
    >
  >((acc, event) => {
    const row =
      acc[event.sellerId] ||
      (acc[event.sellerId] = {
        planned: 0,
        executed: 0,
        punctual: 0,
        followUpAfterVisit: 0
      });

    row.planned += 1;

    const firstStopWithCheckIn = event.stops.find((stop) => Boolean(stop.checkInAt));
    const firstCheckout = event.stops.find((stop) => Boolean(stop.checkOutAt))?.checkOutAt;

    if (firstCheckout) {
      row.executed += 1;

      if (event.opportunityId) {
        const key = `${event.sellerId}:${event.opportunityId}`;
        const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some(
          (createdAt) => createdAt.getTime() >= firstCheckout.getTime()
        );
        if (hasFollowUpAfterVisit) row.followUpAfterVisit += 1;
      }
    }

    if (firstStopWithCheckIn?.plannedTime && firstStopWithCheckIn.checkInAt) {
      if (firstStopWithCheckIn.checkInAt.getTime() <= firstStopWithCheckIn.plannedTime.getTime() + punctualToleranceMs) {
        row.punctual += 1;
      }
    }

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
      const discipline = disciplineBySeller[seller.id] || { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      const executionRate = discipline.planned ? (discipline.executed / discipline.planned) * 100 : 0;
      const punctualRate = discipline.executed ? (discipline.punctual / discipline.executed) * 100 : 0;
      const followUpRate = discipline.executed ? (discipline.followUpAfterVisit / discipline.executed) * 100 : 0;
      const disciplineScoreBase = executionRate * 0.5 + punctualRate * 0.3 + followUpRate * 0.2;
      const volumeFactor = discipline.planned < minimumWeeklyVisits ? discipline.planned / minimumWeeklyVisits : 1;
      const metricValue = disciplineScoreBase * volumeFactor;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Discipline score da semana",
        metricValue,
        medal: "🥇"
      };
    })
  );

  const executedVisitsMap = plannedEvents.reduce<Record<string, number>>((acc, event) => {
    const hasCheckout = event.stops.some((stop) => Boolean(stop.checkOutAt));
    if (!hasCheckout) return acc;
    acc[event.sellerId] = (acc[event.sellerId] || 0) + 1;
    return acc;
  }, {});

  const bestConversion = topByMetric(
    sellers.map((seller) => {
      const created = opportunitiesCreatedMap[seller.id] || 0;
      const executedVisits = executedVisitsMap[seller.id] || 0;
      const conversionRate = executedVisits > 0 ? (created / executedVisits) * 100 : 0;

      return {
        sellerId: seller.id,
        sellerName: seller.name,
        metricLabel: "Oportunidades criadas / visitas realizadas (%)",
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
  const punctualToleranceMs = 10 * 60 * 1000;
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
    prisma.agendaEvent.findMany({
      where: {
        type: "roteiro_visita",
        startDateTime: { gte: start, lte: end },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
      },
      select: {
        sellerId: true,
        opportunityId: true,
        stops: {
          select: {
            plannedTime: true,
            checkInAt: true,
            checkOutAt: true
          },
          orderBy: { order: "asc" }
        }
      }
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
    prisma.sale.groupBy({
      by: ["sellerId"],
      where: {
        date: { gte: start, lte: end },
        ...(scopedSellerId ? { sellerId: scopedSellerId } : {})
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

  const opportunities = Array.from(new Set(plannedEvents.map((event) => event.opportunityId).filter(Boolean))) as string[];
  const followUps = opportunities.length
    ? await prisma.activity.findMany({
        where: {
          type: "follow_up",
          createdAt: { gte: start, lte: end },
          ...(scopedSellerId ? { ownerSellerId: scopedSellerId } : {}),
          opportunityId: { in: opportunities }
        },
        select: {
          ownerSellerId: true,
          opportunityId: true,
          createdAt: true
        }
      })
    : [];

  const followUpsIndex = followUps.reduce<Record<string, Date[]>>((acc, followUp) => {
    if (!followUp.opportunityId) return acc;
    const key = `${followUp.ownerSellerId}:${followUp.opportunityId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(followUp.createdAt);
    return acc;
  }, {});

  const disciplineBySeller = plannedEvents.reduce<Record<string, { planned: number; executed: number; punctual: number; followUpAfterVisit: number }>>(
    (acc, event) => {
      if (!acc[event.sellerId]) {
        acc[event.sellerId] = { planned: 0, executed: 0, punctual: 0, followUpAfterVisit: 0 };
      }

      const sellerStats = acc[event.sellerId];
      sellerStats.planned += 1;

      const firstStopWithCheckIn = event.stops.find((stop) => Boolean(stop.checkInAt));
      const firstCheckout = event.stops.find((stop) => Boolean(stop.checkOutAt))?.checkOutAt;

      if (firstCheckout) {
        sellerStats.executed += 1;
        if (event.opportunityId) {
          const key = `${event.sellerId}:${event.opportunityId}`;
          const hasFollowUpAfterVisit = (followUpsIndex[key] || []).some((createdAt) => createdAt.getTime() >= firstCheckout.getTime());
          if (hasFollowUpAfterVisit) sellerStats.followUpAfterVisit += 1;
        }
      }

      if (firstStopWithCheckIn?.plannedTime && firstStopWithCheckIn.checkInAt) {
        if (firstStopWithCheckIn.checkInAt.getTime() <= firstStopWithCheckIn.plannedTime.getTime() + punctualToleranceMs) {
          sellerStats.punctual += 1;
        }
      }

      return acc;
    },
    {}
  );

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
    acc[item.sellerId] = item._sum.value ?? 0;
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
  const monthKeys = getLastNMonthKeys(3);

  const scopedSellerFilter = req.user?.role === "vendedor" ? { id: req.user.id } : { role: "vendedor" as const };
  const sellers = await prisma.user.findMany({
    where: scopedSellerFilter,
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });

  const monthlyStats = await Promise.all(
    monthKeys.map(async (month) => {
      const { start, end } = getMonthRangeFromKey(month);
      const [sales, goals] = await Promise.all([
        prisma.sale.groupBy({
          by: ["sellerId"],
          where: {
            date: { gte: start, lte: end },
            sellerId: { in: sellers.map((seller) => seller.id) }
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
        acc[item.sellerId] = item._sum.value ?? 0;
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

router.get("/clients/:id([0-9a-fA-F-]{36})", async (req, res) => {
  const data = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    }
  });

  if (!data) return res.status(404).json({ message: "Não encontrado" });
  res.json(data);
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
      return res.status(error.statusCode).json({ message: error.message });
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

// ✅ Import (com ações por linha)
router.post("/clients/import", async (req, res) => {
  const { rows, isValid } = resolveImportRows(req.body);
  if (!isValid) return res.status(400).json({ message: "Payload de importação inválido." });

  const preview = await buildImportPreview(req, rows);

  let totalImportados = 0;
  let totalAtualizados = 0;
  let totalIgnorados = 0;
  let totalErros = 0;
  const errors: Array<{ rowNumber: number; clientName: string; message: string }> = [];

  for (const item of preview) {
    const rowAction = item.row?.action;
    const clientName = String(item.row?.name ?? "");

    if (item.status === "error") {
      totalErros += 1;
      errors.push({ rowNumber: item.rowNumber, clientName, message: item.error });
      continue;
    }

    // Se for duplicado dentro do arquivo, existingClientId pode vir vazio.
    // Regra:
    // - update exige existingClientId válido
    // - skip ignora
    // - import_anyway cria novo
    if (item.status === "duplicate") {
      if (rowAction === "skip") {
        totalIgnorados += 1;
        continue;
      }

      if (rowAction === "update") {
        if (!item.existingClientId) {
          totalErros += 1;
          errors.push({
            rowNumber: item.rowNumber,
            clientName,
            message: "Não é possível atualizar: duplicado no arquivo (sem cliente existente vinculado)."
          });
          continue;
        }

        try {
          const existingClient = await prisma.client.findUnique({ where: { id: item.existingClientId } });
          if (!existingClient) throw new Error("existing_client_not_found");

          const { data: resolvedUpdateData, mergedClientForValidation } = resolveImportUpdateData(
            item.payload,
            req,
            existingClient
          );

          await ensureClientIsNotDuplicate({
            candidate: mergedClientForValidation,
            scope: sellerWhere(req),
            ignoreClientId: item.existingClientId
          });

          await prisma.client.update({
            where: { id: item.existingClientId },
            data: resolvedUpdateData
          });
          totalAtualizados += 1;
        } catch (error) {
          if (isDatabaseUniqueViolation(error)) {
            totalErros += 1;
            errors.push({ rowNumber: item.rowNumber, clientName, message: DUPLICATE_CLIENT_MESSAGE });
            continue;
          }
          totalErros += 1;
          errors.push({
            rowNumber: item.rowNumber,
            clientName,
            message: "Não foi possível atualizar cliente existente."
          });
        }
        continue;
      }

      // import_anyway ou ação vazia -> cria novo (ação vazia é erro, para forçar decisão)
      if (!rowAction) {
        totalErros += 1;
        errors.push({ rowNumber: item.rowNumber, clientName, message: "Cliente duplicado sem ação definida." });
        continue;
      }
    }

    // New ou Duplicate com import_anyway
    if (rowAction === "skip") {
      totalIgnorados += 1;
      continue;
    }

    try {
      const payload = withClientNormalizedFields(item.payload);
      await ensureClientIsNotDuplicate({ candidate: payload, scope: sellerWhere(req) });
      await prisma.client.create({ data: payload });
      totalImportados += 1;
    } catch (error) {
      if (isDatabaseUniqueViolation(error)) {
        totalErros += 1;
        errors.push({ rowNumber: item.rowNumber, clientName, message: DUPLICATE_CLIENT_MESSAGE });
        continue;
      }
      totalErros += 1;
      errors.push({ rowNumber: item.rowNumber, clientName, message: "Não foi possível importar cliente." });
    }
  }

  res.json({ totalImportados, totalAtualizados, totalIgnorados, totalErros, errors });
});

router.put("/clients/:id([0-9a-fA-F-]{36})", validateBody(clientSchema.partial()), async (req, res) => {
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
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (isDatabaseUniqueViolation(error)) {
      return res.status(409).json({ message: DUPLICATE_CLIENT_MESSAGE });
    }
    throw error;
  }
});

router.delete("/clients/:id([0-9a-fA-F-]{36})", async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) {
    return res.status(403).json({ message: "Sem permissão" });
  }
  await prisma.client.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/clients/:id([0-9a-fA-F-]{36})/contacts", async (req, res) => {
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
  "/clients/:id([0-9a-fA-F-]{36})/contacts",
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
  "/clients/:id([0-9a-fA-F-]{36})/contacts/:contactId",
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

router.delete("/clients/:id([0-9a-fA-F-]{36})/contacts/:contactId", async (req, res) => {
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
      return res.status(error.statusCode).json({ message: error.message });
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
      return res.status(error.statusCode).json({ message: error.message });
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

router.get("/opportunities", async (req, res) => {
  const stage = getStageFilter(req.query.stage as string | undefined);
  if (req.query.stage && !stage) return res.status(400).json({ message: "stage inválido" });
  const status = getOpportunityStatusFilter(req.query.status as string | undefined);
  if (req.query.status && !status) return res.status(400).json({ message: "status inválido" });

  const ownerSellerId = (req.query.ownerId as string | undefined) || (req.query.ownerSellerId as string | undefined);
  const clientId = req.query.clientId as string | undefined;
  const search = req.query.search as string | undefined;
  const crop = req.query.crop as string | undefined;
  const season = req.query.season as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const overdue = req.query.overdue === "true";
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = parsePositiveInt(req.query.pageSize, 20);
  const todayStart = getUtcTodayStart();

  const proposalDateWhere: Record<string, Date> = {};
  if (dateFrom) {
    const parsed = normalizeDateToUtc(dateFrom, false);
    if (!parsed) return res.status(400).json({ message: "dateFrom inválido" });
    proposalDateWhere.gte = parsed;
  }
  if (dateTo) {
    const parsed = normalizeDateToUtc(dateTo, true);
    if (!parsed) return res.status(400).json({ message: "dateTo inválido" });
    proposalDateWhere.lte = parsed;
  }

  const where: any = {
    ...sellerWhere(req),
    ...(status === "open" ? { NOT: { stage: { in: [...CLOSED_STAGE_VALUES] } } } : {}),
    ...(status === "closed" ? { stage: { in: [...CLOSED_STAGE_VALUES] } } : {}),
    ...(stage ? { stage } : {}),
    ...(ownerSellerId ? { ownerSellerId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(crop ? { crop } : {}),
    ...(season ? { season } : {}),
    ...(dateFrom || dateTo ? { proposalDate: proposalDateWhere } : {}),
    ...(overdue ? { expectedCloseDate: { lt: todayStart }, NOT: { stage: { in: [...CLOSED_STAGE_VALUES] } } } : {}),
    ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { client: { name: { contains: search, mode: "insensitive" } } }] } : {})
  };

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
  return res.json({
    items: opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)),
    total,
    page,
    pageSize,
    totalPages
  });
});

router.get("/opportunities/summary", async (req, res) => {
  const todayStart = getUtcTodayStart();
  const opportunities: any[] = await prisma.opportunity.findMany({
    where: sellerWhere(req),
    select: { value: true, stage: true, crop: true, season: true, probability: true, expectedCloseDate: true }
  });

  const totalsByStage: Record<string, { value: number; weighted: number }> = {};
  const breakdownByCrop: Record<string, { value: number; weighted: number; count: number }> = {};
  const breakdownBySeason: Record<string, { value: number; weighted: number; count: number }> = {};

  let totalPipelineValue = 0;
  let totalWeightedValue = 0;
  let overdueCount = 0;
  let overdueValue = 0;

  for (const opportunity of opportunities) {
    const weighted = getWeightedValue(opportunity.value, opportunity.probability);
    totalPipelineValue += opportunity.value;
    totalWeightedValue += weighted;

    if (!totalsByStage[opportunity.stage]) totalsByStage[opportunity.stage] = { value: 0, weighted: 0 };
    totalsByStage[opportunity.stage].value += opportunity.value;
    totalsByStage[opportunity.stage].weighted += weighted;

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

    const isOverdue = opportunity.expectedCloseDate < todayStart && !CLOSED_STAGES.has(opportunity.stage);
    if (isOverdue) {
      overdueCount += 1;
      overdueValue += opportunity.value;
    }
  }

  res.json({ totalPipelineValue, totalWeightedValue, totalsByStage, overdueCount, overdueValue, breakdownByCrop, breakdownBySeason });
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

  const data = await prisma.opportunity.update({ where: { id: req.params.id }, data: normalizeOpportunityDates(req.body) as any });

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
      ...(type ? { type: type as ActivityType } : {}),
      ...(doneQuery !== undefined ? { done: doneQuery } : {}),
      ...(monthRange ? { dueDate: { gte: monthRange.start, lte: monthRange.end } } : {}),
      ...(clientId ? { opportunity: { clientId } } : {}),
      ...(q
        ? {
            OR: [
              { notes: { contains: q, mode: "insensitive" } },
              { opportunity: { title: { contains: q, mode: "insensitive" } } },
              { opportunity: { client: { name: { contains: q, mode: "insensitive" } } } }
            ]
          }
        : {})
    },
    include: {
      ownerSeller: { select: { id: true, name: true } },
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
  const ownerSellerId = resolveOwnerId(req, req.body.ownerSellerId);
  const relatedOpportunity = req.body.opportunityId
    ? await prisma.opportunity.findFirst({
      where: {
        id: req.body.opportunityId,
        ...sellerWhere(req)
      },
      select: { id: true, clientId: true }
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

  const createdActivity = await prisma.activity.create({
    data: {
      type: req.body.type,
      notes: req.body.notes,
      dueDate: new Date(req.body.dueDate),
      done: req.body.done,
      opportunityId: req.body.opportunityId,
      ownerSellerId
    }
  });

  await createEvent({
    type: "status",
    description: `Atividade criada: ${createdActivity.type}`,
    opportunityId: createdActivity.opportunityId || undefined,
    clientId: resolvedClientId,
    ownerSellerId
  });

  const month = getMonthKey(createdActivity.createdAt);
  const logicalCount = await getActivityCountByTypeInMonth(ownerSellerId, createdActivity.type, month);

  return res.status(201).json({
    ...mapActivity(createdActivity),
    metrics: {
      month,
      logicalCount
    }
  });
});
router.put("/activities/:id", validateBody(activitySchema.partial()), async (req, res) => {
  const { clientId: _clientId, ...payload } = req.body;
  const updatedActivity = await prisma.activity.update({
    where: { id: req.params.id },
    data: { ...payload, ...(req.body.dueDate ? { dueDate: new Date(req.body.dueDate) } : {}) }
  });
  return res.json(mapActivity(updatedActivity));
});
router.patch("/activities/:id/done", async (req, res) => {
  const updatedActivity = await prisma.activity.update({ where: { id: req.params.id }, data: { done: Boolean(req.body.done) } });
  return res.json(mapActivity(updatedActivity));
});
router.delete("/activities/:id", async (req, res) => { await prisma.activity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

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

const resolveAgendaEventStatus = (agendaEvent: { status: string; endDateTime: Date }) => resolveStatus({ done: agendaEvent.status === "realizado", endAt: agendaEvent.endDateTime });

const mapAgendaEvent = (agendaEvent: any) => ({
  id: agendaEvent.id,
  title: agendaEvent.title,
  type: agendaEvent.type,
  startDateTime: agendaEvent.startDateTime.toISOString(),
  endDateTime: agendaEvent.endDateTime.toISOString(),
  clientId: agendaEvent.clientId,
  opportunityId: agendaEvent.opportunityId,
  sellerId: agendaEvent.sellerId,
  status: resolveAgendaEventStatus(agendaEvent),
  isOverdue: resolveAgendaEventStatus(agendaEvent) === "vencido",
  city: agendaEvent.city,
  notes: agendaEvent.notes,
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
});

router.get(["/agenda", "/agenda/events"], async (req, res) => {
  const fromInput = req.query.from as string | undefined;
  const toInput = req.query.to as string | undefined;

  const from = fromInput ? normalizeDateToUtc(fromInput) : new Date(Date.now() - 86400000 * 7);
  const to = toInput ? normalizeDateToUtc(toInput, true) : new Date(Date.now() + 86400000 * 30);

  if (!from || !to) {
    return res.status(400).json({ message: "Parâmetros from/to inválidos." });
  }

  const where: Prisma.AgendaEventWhereInput = {
    ...sellerWhere(req),
    startDateTime: { gte: from },
    endDateTime: { lte: to }
  };

  const events = await prisma.agendaEvent.findMany({
    where,
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } }, client: true },
    orderBy: { startDateTime: "asc" }
  });

  const mappedEvents = events.map(mapAgendaEvent);
  const summary = mappedEvents.reduce(
    (acc, event) => {
      if (event.type === "roteiro_visita") acc.roteiros += 1;
      if (event.type === "followup") acc.followUps += 1;
      else if (event.type === "follow_up") acc.followUps += 1;
      else acc.reunioes += 1;

      if (event.status === "vencido") acc.vencidos += 1;
      return acc;
    },
    { reunioes: 0, roteiros: 0, followUps: 0, vencidos: 0 }
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
  const sellerId = resolveOwnerId(req, req.body.ownerSellerId || req.body.sellerId);
  const event = await prisma.agendaEvent.create({
    data: {
      title: req.body.title,
      type: req.body.type,
      startDateTime: new Date(req.body.startDateTime),
      endDateTime: new Date(req.body.endDateTime),
      sellerId,
      clientId: req.body.clientId,
      city: req.body.city,
      notes: req.body.notes,
      opportunityId: req.body.opportunityId
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

  return res.status(201).json(mapAgendaEvent(event));
});

router.patch(["/agenda/:id", "/agenda/events/:id"], validateBody(agendaEventUpdateSchema), async (req, res) => {
  const event = await prisma.agendaEvent.findUnique({ where: { id: req.params.id }, select: { sellerId: true } });
  if (!event) return res.status(404).json({ message: "Evento não encontrado." });
  if (req.user!.role === "vendedor" && event.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  const updated = await prisma.agendaEvent.update({
    where: { id: req.params.id },
    data: {
      ...(req.body.title ? { title: req.body.title } : {}),
      ...(req.body.startDateTime ? { startDateTime: new Date(req.body.startDateTime) } : {}),
      ...(req.body.endDateTime ? { endDateTime: new Date(req.body.endDateTime) } : {}),
      ...(req.body.status ? { status: req.body.status } : {}),
      ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
      ...(req.body.city !== undefined ? { city: req.body.city } : {}),
      ...(req.body.opportunityId !== undefined ? { opportunityId: req.body.opportunityId } : {})
    },
    include: { stops: { include: { client: { select: { name: true } } }, orderBy: { order: "asc" } } }
  });

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
  const stop = await prisma.agendaStop.findUnique({ where: { id: req.params.id }, include: { agendaEvent: { select: { sellerId: true } } } });
  if (!stop) return res.status(404).json({ message: "Parada não encontrada." });
  if (req.user!.role === "vendedor" && stop.agendaEvent.sellerId !== req.user!.id) {
    return res.status(403).json({ message: "Acesso negado." });
  }

  if (req.body.status === "nao_realizada" && !req.body.reason) {
    return res.status(400).json({ message: "Motivo é obrigatório quando a visita não é realizada." });
  }

  const updated = await prisma.agendaStop.update({
    where: { id: req.params.id },
    data: {
      resultStatus: req.body.status,
      resultReason: req.body.reason,
      resultSummary: req.body.summary,
      nextStep: req.body.nextStep,
      nextStepDate: req.body.nextStepDate ? new Date(req.body.nextStepDate) : null
    }
  });

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
  const minimumWeeklyVisits = await getMinimumWeeklyVisits();
  return res.json({ minimumWeeklyVisits });
});

router.put(
  "/settings/weekly-visit-minimum",
  authorize("diretor"),
  validateBody(weeklyVisitMinimumSchema),
  async (req, res) => {
    try {
      const config = await prisma.appConfig.upsert({
        where: { key: MINIMUM_WEEKLY_VISITS_KEY },
        update: { value: String(req.body.minimumWeeklyVisits) },
        create: { key: MINIMUM_WEEKLY_VISITS_KEY, value: String(req.body.minimumWeeklyVisits) },
        select: { value: true }
      });

      const parsedValue = parseMinimumWeeklyVisits(config.value);
      minimumWeeklyVisitsCache.value = parsedValue;
      minimumWeeklyVisitsCache.expiresAt = Date.now() + APP_CONFIG_CACHE_TTL_MS;
      return res.json({ minimumWeeklyVisits: parsedValue });
    } catch (error) {
      console.error("[appConfig] Falha ao atualizar minimumWeeklyVisits.", error);
      return res.status(200).json({ minimumWeeklyVisits: DEFAULT_MINIMUM_WEEKLY_VISITS });
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

  const existing = await prisma.goal.findFirst({
    where: {
      sellerId: req.params.userId,
      month: monthKey
    }
  });

  const goal = existing
    ? await prisma.goal.update({ where: { id: existing.id }, data: { targetValue: amount } })
    : await prisma.goal.create({ data: { sellerId: req.params.userId, month: monthKey, targetValue: amount } });

  return res.json({
    id: goal.id,
    userId: goal.sellerId,
    month,
    year,
    amount: goal.targetValue,
    createdAt: goal.createdAt
  });
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

  const [activityKpis, monthActivityCounts] = await Promise.all([
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
        createdAt: { gte: start, lte: end }
      },
      _count: { _all: true }
    })
  ]);

  const logicalCountBySellerAndType = new Map(
    monthActivityCounts.map((countEntry) => [`${countEntry.ownerSellerId}:${countEntry.type}`, countEntry._count._all])
  );

  return res.json(
    activityKpis.map((activityKpi) => ({
      ...activityKpi,
      logicalCount: logicalCountBySellerAndType.get(`${activityKpi.sellerId}:${activityKpi.type}`) ?? 0
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
router.post("/users", authorize("diretor"), async (req, res) => {
  const { name, email, password, role, region } = req.body;
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role, region } });
  res.status(201).json({ id: user.id, email: user.email });
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
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash(temporaryPassword, 10);

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

export default router;
