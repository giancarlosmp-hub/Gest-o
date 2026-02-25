import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { activitySchema, clientSchema, companySchema, contactSchema, goalSchema, opportunitySchema, timelineCommentSchema } from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";

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

const TIMELINE_TYPE_LABEL: Record<string, string> = {
  comentario: "Comentário",
  atividade: "Atividade",
  mudanca_estagio: "Stage",
  criacao_oportunidade: "Oportunidade",
  mudanca_followup: "Follow-up"
};

const createTimelineEvent = async ({
  type,
  title,
  message,
  clientId,
  opportunityId,
  userId,
  meta,
  createdAt
}: {
  type: "comentario" | "atividade" | "mudanca_estagio" | "criacao_oportunidade" | "mudanca_followup";
  title: string;
  message: string;
  clientId: string;
  opportunityId?: string | null;
  userId: string;
  meta?: Record<string, unknown>;
  createdAt?: Date;
}) => prisma.timelineEvent.create({
  data: {
    type,
    title,
    message,
    clientId,
    opportunityId: opportunityId || null,
    userId,
    meta: (meta as any) ?? undefined,
    ...(createdAt ? { createdAt } : {})
  }
});


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
  owner: opportunity.ownerSeller?.name,
  daysOverdue: getDaysOverdue(opportunity.expectedCloseDate, opportunity.stage, todayStart),
  weightedValue: getWeightedValue(opportunity.value, opportunity.probability)
});

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
  const data = await prisma.client.findMany({ where: sellerWhere(req), orderBy: { createdAt: "desc" } });
  res.json(data);
});
router.get("/clients/:id", async (req, res) => {
  const client = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    include: {
      ownerSeller: { select: { id: true, name: true, role: true } },
      opportunities: {
        select: { id: true, title: true, stage: true, followUpDate: true, expectedCloseDate: true },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });
  res.json(client);
});

router.get("/clients/:id/timeline", async (req, res) => {
  const client = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });

  const timeline = await prisma.timelineEvent.findMany({
    where: { clientId: req.params.id },
    include: {
      user: { select: { id: true, name: true, role: true } },
      opportunity: { select: { id: true, title: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(timeline.map((event) => ({
    ...event,
    badgeLabel: TIMELINE_TYPE_LABEL[event.type] || event.type
  })));
});

router.post("/clients/:id/timeline", validateBody(timelineCommentSchema), async (req, res) => {
  const client = await prisma.client.findFirst({
    where: {
      id: req.params.id,
      ...sellerWhere(req)
    },
    select: { id: true }
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado" });

  if (req.body.opportunityId) {
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.body.opportunityId, clientId: req.params.id, ...sellerWhere(req) }, select: { id: true } });
    if (!opportunity) return res.status(400).json({ message: "Oportunidade inválida para este cliente" });
  }

  const created = await createTimelineEvent({
    type: "comentario",
    title: "Comentário",
    message: req.body.message,
    clientId: req.params.id,
    opportunityId: req.body.opportunityId,
    userId: req.user!.id
  });

  const event = await prisma.timelineEvent.findUnique({
    where: { id: created.id },
    include: {
      user: { select: { id: true, name: true, role: true } },
      opportunity: { select: { id: true, title: true } }
    }
  });

  res.status(201).json({
    ...event,
    badgeLabel: event ? TIMELINE_TYPE_LABEL[event.type] || event.type : "Comentário"
  });
});
router.post("/clients", validateBody(clientSchema), async (req, res) => {
  const data = await prisma.client.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } });
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

router.get("/companies", async (req, res) => res.json(await prisma.company.findMany({ where: sellerWhere(req), orderBy: { createdAt: "desc" } })));
router.post("/companies", validateBody(companySchema), async (req, res) => res.status(201).json(await prisma.company.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } })));
router.put("/companies/:id", validateBody(companySchema.partial()), async (req, res) => res.json(await prisma.company.update({ where: { id: req.params.id }, data: req.body })));
router.delete("/companies/:id", async (req, res) => { await prisma.company.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/contacts", async (req, res) => res.json(await prisma.contact.findMany({ where: sellerWhere(req), include: { company: true }, orderBy: { createdAt: "desc" } })));
router.post("/contacts", validateBody(contactSchema), async (req, res) => res.status(201).json(await prisma.contact.create({ data: { ...req.body, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } })));
router.put("/contacts/:id", validateBody(contactSchema.partial()), async (req, res) => res.json(await prisma.contact.update({ where: { id: req.params.id }, data: req.body })));
router.delete("/contacts/:id", async (req, res) => { await prisma.contact.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/opportunities", async (req, res) => {
  const stage = getStageFilter(req.query.stage as string | undefined);
  if (req.query.stage && !stage) return res.status(400).json({ message: "stage inválido" });

  const ownerSellerId = (req.query.ownerId as string | undefined) || (req.query.ownerSellerId as string | undefined);
  const clientId = req.query.clientId as string | undefined;
  const search = req.query.search as string | undefined;
  const crop = req.query.crop as string | undefined;
  const season = req.query.season as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const overdue = req.query.overdue === "true";
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
    ...(stage ? { stage } : {}),
    ...(ownerSellerId ? { ownerSellerId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(crop ? { crop } : {}),
    ...(season ? { season } : {}),
    ...(dateFrom || dateTo ? { proposalDate: proposalDateWhere } : {}),
    ...(overdue ? { expectedCloseDate: { lt: todayStart }, NOT: { stage: { in: [...CLOSED_STAGE_VALUES] } } } : {}),
    ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { client: { name: { contains: search, mode: "insensitive" } } }] } : {})
  };

  const opportunities: any[] = await prisma.opportunity.findMany({
    where,
    include: {
      client: { select: { id: true, name: true } },
      ownerSeller: { select: { id: true, name: true } }
    },
    orderBy: [{ expectedCloseDate: "asc" }, { value: "desc" }]
  });

  res.json(opportunities.map((opportunity) => serializeOpportunity(opportunity, todayStart)));
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
      client: true,
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

  const data = await prisma.opportunity.create({
    data: {
      ...(normalizeOpportunityDates(req.body) as any),
      ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId)
    }
  });

  await createTimelineEvent({
    type: "criacao_oportunidade",
    title: "Oportunidade criada",
    message: `A oportunidade "${data.title}" foi criada no estágio ${data.stage}.`,
    clientId: data.clientId,
    opportunityId: data.id,
    userId: req.user!.id,
    meta: { stage: data.stage, value: data.value }
  });

  return res.status(201).json(data);
});
router.put("/opportunities/:id", validateBody(opportunitySchema.partial()), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const current = await prisma.opportunity.findFirst({ where: { id: req.params.id, ...sellerWhere(req) } });
  if (!current) return res.status(404).json({ message: "Oportunidade não encontrada" });

  const data = await prisma.opportunity.update({ where: { id: req.params.id }, data: normalizeOpportunityDates(req.body) as any });

  if (req.body.stage && req.body.stage !== current.stage) {
    await createTimelineEvent({
      type: "mudanca_estagio",
      title: "Mudança de estágio",
      message: `Estágio alterado de ${current.stage} para ${data.stage}.`,
      clientId: data.clientId,
      opportunityId: data.id,
      userId: req.user!.id,
      meta: { from: current.stage, to: data.stage }
    });
  }

  if (req.body.followUpDate && current.followUpDate.toISOString() !== data.followUpDate.toISOString()) {
    await createTimelineEvent({
      type: "mudanca_followup",
      title: "Data de follow-up alterada",
      message: `Follow-up alterado de ${current.followUpDate.toISOString()} para ${data.followUpDate.toISOString()}.`,
      clientId: data.clientId,
      opportunityId: data.id,
      userId: req.user!.id,
      meta: { from: current.followUpDate.toISOString(), to: data.followUpDate.toISOString() }
    });
  }

  return res.json(data);
});
router.delete("/opportunities/:id", async (req, res) => { await prisma.opportunity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/activities", async (req, res) => res.json(await prisma.activity.findMany({ where: sellerWhere(req), include: { opportunity: true }, orderBy: { createdAt: "desc" } })));
router.post("/activities", validateBody(activitySchema), async (req, res) => {
  const activity = await prisma.activity.create({ data: { ...req.body, dueDate: new Date(req.body.dueDate), ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } });

  if (activity.opportunityId) {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: activity.opportunityId }, select: { id: true, clientId: true, title: true } });
    if (opportunity) {
      await createTimelineEvent({
        type: "atividade",
        title: "Atividade registrada",
        message: `${activity.type} registrada para a oportunidade "${opportunity.title}".`,
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        userId: req.user!.id,
        meta: { activityType: activity.type, dueDate: activity.dueDate.toISOString() }
      });
    }
  }

  return res.status(201).json(activity);
});
router.put("/activities/:id", validateBody(activitySchema.partial()), async (req, res) => res.json(await prisma.activity.update({ where: { id: req.params.id }, data: { ...req.body, ...(req.body.dueDate ? { dueDate: new Date(req.body.dueDate) } : {}) } })));
router.patch("/activities/:id/done", async (req, res) => res.json(await prisma.activity.update({ where: { id: req.params.id }, data: { done: Boolean(req.body.done) } })));
router.delete("/activities/:id", async (req, res) => { await prisma.activity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/goals", async (req, res) => {
  const sellerId = req.user!.role === "vendedor" ? req.user!.id : (req.query.sellerId as string | undefined);
  res.json(await prisma.goal.findMany({ where: sellerId ? { sellerId } : {}, include: { seller: { select: { name: true, email: true } } }, orderBy: [{ month: "desc" }] }));
});
router.post("/goals", authorize("diretor", "gerente"), validateBody(goalSchema), async (req, res) => res.status(201).json(await prisma.goal.create({ data: req.body })));
router.put("/goals/:id", authorize("diretor", "gerente"), validateBody(goalSchema.partial()), async (req, res) => res.json(await prisma.goal.update({ where: { id: req.params.id }, data: req.body })));
router.delete("/goals/:id", authorize("diretor", "gerente"), async (req, res) => { await prisma.goal.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/users", authorize("diretor", "gerente"), async (_req, res) => res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, region: true, createdAt: true } })));
router.post("/users", authorize("diretor"), async (req, res) => {
  const { name, email, password, role, region } = req.body;
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role, region } });
  res.status(201).json({ id: user.id, email: user.email });
});
router.patch("/users/:id/region", authorize("diretor", "gerente"), async (req, res) => res.json(await prisma.user.update({ where: { id: req.params.id }, data: { region: req.body.region } })));

export default router;
