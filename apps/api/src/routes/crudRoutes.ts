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
  userResetPasswordSchema,
  userRoleUpdateSchema
} from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";
import { randomBytes } from "node:crypto";
import { buildTimelineEventWhere } from "./timelineEventWhere.js";
import { ActivityType, ClientType } from "@prisma/client";
import type { Prisma } from "@prisma/client";

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
      ? { plantingForecastDate: payload.plantingForecastDate ? new Date(new Date(String(payload.plantingForecastDate)).toISOString()) : null }
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
  const overdueBySeller: Record<string, { sellerId: string; sellerName: string; overdueCount: number; overdueValue: number }> = {};
  const byClient: Record<string, { clientId: string; clientName: string; weightedValue: number; value: number; opportunities: number }> = {};
  const byStage: Record<string, number> = {};
  const plantingWindow: Record<string, { month: string; opportunities: number; weightedValue: number; pipelineValue: number }> = {};
  const portfolioByPotential: Record<string, { clientId: string; clientName: string; potentialHa: number; farmSizeHa: number; opportunities: number; weightedValue: number }> = {};

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

  const hasAdvancedQuery = ["q", "uf", "regiao", "tipo", "ownerSellerId", "vendedorId", "page", "pageSize", "sort"].some((key) => req.query[key] !== undefined);

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

  // Estrutura paginada final consumida pelo web: { items, total, page, pageSize }.
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
  res.json(data);
});

router.post("/clients", validateBody(clientSchema), async (req, res) => {
  const ownerSellerId =
    req.user!.role === "vendedor"
      ? req.user!.id
      : req.user!.role === "gerente" || req.user!.role === "diretor"
        ? resolveOwnerId(req, req.body.ownerSellerId)
        : resolveOwnerId(req);

  const data = await prisma.client.create({ data: { ...req.body, ownerSellerId } });
  res.status(201).json(data);
});

router.put("/clients/:id", validateBody(clientSchema.partial()), async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) return res.status(403).json({ message: "Sem permissão" });
  const data = await prisma.client.update({ where: { id: req.params.id }, data: req.body });
  res.json(data);
});

router.delete("/clients/:id", async (req, res) => {
  const old = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ message: "Não encontrado" });
  if (req.user!.role === "vendedor" && old.ownerSellerId !== req.user!.id) return res.status(403).json({ message: "Sem permissão" });
  await prisma.client.delete({ where: { id: req.params.id } });
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

router.post("/clients/:id/contacts", validateBody(clientContactSchema), async (req, res) => {
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
      ownerSellerId: resolveOwnerId(req)
    }
  });

  res.status(201).json(data);
});

router.put("/clients/:id/contacts/:contactId", validateBody(clientContactSchema.partial()), async (req, res) => {
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
});

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
  const data = await prisma.client.create({
    data: {
      name: req.body.name,
      city: "Não informado",
      state: "NI",
      region: req.user?.region || "Nacional",
      clientType: "PJ",
      cnpj: req.body.cnpj,
      segment: req.body.segment,
      ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId)
    }
  });

  res.status(201).json(data);
});

router.put("/companies/:id", validateBody(companySchema.partial()), async (req, res) => {
  const data = await prisma.client.update({
    where: { id: req.params.id },
    data: {
      ...(req.body.name ? { name: req.body.name } : {}),
      ...(req.body.cnpj !== undefined ? { cnpj: req.body.cnpj } : {}),
      ...(req.body.segment !== undefined ? { segment: req.body.segment } : {}),
      clientType: "PJ"
    }
  });

  res.json(data);
});

router.delete("/companies/:id", async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/contacts", async (req, res) =>
  res.json(await prisma.contact.findMany({ where: sellerWhere(req), include: { client: true }, orderBy: { createdAt: "desc" } }))
);
router.post("/contacts", validateBody(contactSchema), async (req, res) =>
  res.status(201).json(await prisma.contact.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } }))
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

router.delete("/opportunities/:id", async (req, res) => {
  await prisma.opportunity.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

/**
 * ✅ CONFLITO RESOLVIDO AQUI:
 * - suporta filtro por month (YYYY-MM)
 * - suporta filtro por sellerId para gerente/diretor
 * - vendedor sempre vê só dele
 * - inclui ownerSeller (nome) e opportunity + client (para UI ficar profissional)
 */
router.get("/activities", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const typeQuery = typeof req.query.type === "string" ? req.query.type.trim() : "";
  const doneQuery = typeof req.query.done === "string" ? req.query.done.trim().toLowerCase() : "";
  const month = req.query.month as string | undefined;
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
  const sellerIdQuery = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

  if (typeQuery && !Object.values(ActivityType).includes(typeQuery as ActivityType)) {
    return res.status(400).json({ message: "type inválido" });
  }

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ message: "month deve estar no formato YYYY-MM" });
  }

  if (doneQuery && doneQuery !== "true" && doneQuery !== "false") {
    return res.status(400).json({ message: "done deve ser true ou false" });
  }

  if (sellerIdQuery && req.user!.role !== "gerente" && req.user!.role !== "diretor") {
    return res.status(403).json({ message: "Sem permissão" });
  }

  const sellerFilter: Prisma.ActivityWhereInput =
    req.user!.role === "vendedor"
      ? { ownerSellerId: req.user!.id }
      : sellerIdQuery
        ? { ownerSellerId: sellerIdQuery }
        : sellerWhere(req);

  const monthFilter: Prisma.ActivityWhereInput =
    month
      ? (() => {
          const { start, end } = getMonthRangeFromKey(month);
          return { dueDate: { gte: start, lte: end } };
        })()
      : {};

  const doneFilter: Prisma.ActivityWhereInput =
    doneQuery === "true" || doneQuery === "false"
      ? { done: doneQuery === "true" }
      : {};

  const typeFilter: Prisma.ActivityWhereInput = typeQuery ? { type: typeQuery as ActivityType } : {};

  const searchFilter: Prisma.ActivityWhereInput = q
    ? {
        OR: [
          { notes: { contains: q, mode: "insensitive" } },
          { opportunity: { title: { contains: q, mode: "insensitive" } } },
          { opportunity: { client: { name: { contains: q, mode: "insensitive" } } } }
        ]
      }
    : {};

  const clientFilter: Prisma.ActivityWhereInput = clientId
    ? {
        opportunity: {
          clientId
        }
      }
    : {};

  const activities = await prisma.activity.findMany({
    where: {
      ...sellerFilter,
      ...monthFilter,
      ...doneFilter,
      ...typeFilter,
      ...searchFilter,
      ...clientFilter
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

  return res.json(activities);
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
    ...createdActivity,
    metrics: {
      month,
      logicalCount
    }
  });
});

router.put("/activities/:id", validateBody(activitySchema.partial()), async (req, res) => {
  const { clientId: _clientId, ...payload } = req.body;
  return res.json(
    await prisma.activity.update({
      where: { id: req.params.id },
      data: { ...payload, ...(req.body.dueDate ? { dueDate: new Date(req.body.dueDate) } : {}) }
    })
  );
});

router.patch("/activities/:id/done", async (req, res) =>
  res.json(await prisma.activity.update({ where: { id: req.params.id }, data: { done: Boolean(req.body.done) } }))
);
router.delete("/activities/:id", async (req, res) => {
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
  res.json(
    await prisma.goal.findMany({
      where: sellerId ? { sellerId } : {},
      include: { seller: { select: { name: true, email: true } } },
      orderBy: [{ month: "desc" }]
    })
  );
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

router.post("/goals", authorize("diretor", "gerente"), validateBody(goalSchema), async (req, res) =>
  res.status(201).json(await prisma.goal.create({ data: req.body }))
);
router.put("/goals/:id", authorize("diretor", "gerente"), validateBody(goalSchema.partial()), async (req, res) =>
  res.json(await prisma.goal.update({ where: { id: req.params.id }, data: req.body }))
);
router.delete("/goals/:id", authorize("diretor", "gerente"), async (req, res) => {
  await prisma.goal.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get("/users", authorize("diretor", "gerente"), async (_req, res) =>
  res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, region: true, isActive: true, createdAt: true } }))
);

router.post("/users", authorize("diretor"), async (req, res) => {
  const { name, email, password, role, region } = req.body;
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role, region } });
  res.status(201).json({ id: user.id, email: user.email });
});

router.patch("/users/:id/region", authorize("diretor", "gerente"), async (req, res) =>
  res.json(await prisma.user.update({ where: { id: req.params.id }, data: { region: req.body.region } }))
);

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
