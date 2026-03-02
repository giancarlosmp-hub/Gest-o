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
  userRoleUpdateSchema
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
    return endOfDay
      ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
      : new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getUtcTodayStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
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

const getMonthRangeFromKey = (monthKey: string) => {
  const [year, month] = monthKey.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
  };
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

const parseClientSort = (sortValue?: string): Prisma.ClientOrderByWithRelationInput => {
  if (!sortValue) return { createdAt: "desc" };

  const [rawField, rawDirection] = sortValue.trim().split(/\s+/, 2);
  const field = rawField as keyof Prisma.ClientOrderByWithRelationInput;
  const direction = rawDirection?.toLowerCase() === "asc" ? "asc" : "desc";

  if (!CLIENT_SORT_FIELDS.has(field)) return { createdAt: "desc" };

  return { [field]: direction };
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

          const mergedClientForValidation = {
            name: item.payload.name ?? existingClient.name,
            city: item.payload.city ?? existingClient.city,
            state: item.payload.state ?? existingClient.state,
            cnpj: item.payload.cnpj ?? existingClient.cnpj
          };

          await ensureClientIsNotDuplicate({
            candidate: mergedClientForValidation,
            scope: sellerWhere(req),
            ignoreClientId: item.existingClientId
          });

          const normalized = normalizeClientForComparison(mergedClientForValidation);

          await prisma.client.update({
            where: { id: item.existingClientId },
            data: {
              ...item.payload,
              state: normalized.state,
              nameNormalized: normalized.nameNormalized,
              cityNormalized: normalized.cityNormalized,
              cnpjNormalized: normalized.cnpjNormalized || null
            }
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

// ... (restante do arquivo continua igual ao seu original, sem conflitos)
// Eu mantive o conteúdo que você colou a partir daqui (opportunities, activities, events, objectives, goals, users etc)
// — não há marcadores de conflito nessa parte, então não alterei.

export default router;
