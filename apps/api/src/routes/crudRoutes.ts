import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { activitySchema, clientSchema, companySchema, contactSchema, goalSchema, opportunitySchema } from "@salesforce-pro/shared";
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

router.get("/clients", async (req, res) => {
  const data = await prisma.client.findMany({ where: sellerWhere(req), orderBy: { createdAt: "desc" } });
  res.json(data);
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

  res.json(opportunities.map((opportunity) => {
    const daysOverdue = getDaysOverdue(opportunity.expectedCloseDate, opportunity.stage, todayStart);
    return {
      ...opportunity,
      proposalDate: opportunity.proposalDate.toISOString(),
      followUpDate: opportunity.followUpDate.toISOString(),
      expectedCloseDate: opportunity.expectedCloseDate.toISOString(),
      lastContactAt: opportunity.lastContactAt ? opportunity.lastContactAt.toISOString() : null,
      createdAt: opportunity.createdAt.toISOString(),
      client: opportunity.client.name,
      owner: opportunity.ownerSeller.name,
      daysOverdue,
      weightedValue: getWeightedValue(opportunity.value, opportunity.probability)
    };
  }));
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

  return res.status(201).json(data);
});
router.put("/opportunities/:id", validateBody(opportunitySchema.partial()), async (req, res) => {
  if (!assertProbability(req.body.probability)) return res.status(400).json({ message: "probability deve estar entre 0 e 100" });

  const proposalDate = (req.body.proposalDate || req.body.proposalEntryDate) as string | undefined;
  const expectedCloseDate = (req.body.expectedCloseDate || req.body.expectedReturnDate) as string | undefined;
  if (!validateDateOrder(proposalDate, expectedCloseDate)) {
    return res.status(400).json({ message: "expectedReturnDate não pode ser anterior a proposalEntryDate" });
  }

  const data = await prisma.opportunity.update({ where: { id: req.params.id }, data: normalizeOpportunityDates(req.body) as any });
  return res.json(data);
});
router.delete("/opportunities/:id", async (req, res) => { await prisma.opportunity.delete({ where: { id: req.params.id } }); res.status(204).send(); });

router.get("/activities", async (req, res) => res.json(await prisma.activity.findMany({ where: sellerWhere(req), include: { opportunity: true }, orderBy: { createdAt: "desc" } })));
router.post("/activities", validateBody(activitySchema), async (req, res) => res.status(201).json(await prisma.activity.create({ data: { ...req.body, dueDate: new Date(req.body.dueDate), ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } })));
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
