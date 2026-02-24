import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { activitySchema, clientSchema, companySchema, contactSchema, goalSchema, opportunitySchema } from "@salesforce-pro/shared";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";

const router = Router();
router.use(authMiddleware);

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
  const stage = req.query.stage as any;
  const ownerSellerId = req.query.ownerSellerId as string | undefined;
  const clientId = req.query.clientId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const overdue = req.query.overdue === "true";
  const dueSoon = req.query.dueSoon === "true";

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const in3Days = new Date(todayStart);
  in3Days.setDate(in3Days.getDate() + 3);

  const followUpDateWhere: any = {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lte: new Date(to) } : {}),
  };

  if (overdue) {
    followUpDateWhere.lt = todayStart;
  }

  if (dueSoon) {
    followUpDateWhere.gte = todayStart;
    followUpDateWhere.lte = in3Days;
  }

  const blockedStages = overdue || dueSoon ? ["ganho", "perdido"] : [];
  const where: any = {
    ...sellerWhere(req),
    ...(stage ? { stage } : {}),
    ...(ownerSellerId ? { ownerSellerId } : {}),
    ...(clientId ? { clientId } : {}),
    ...((overdue || dueSoon || from || to) ? { followUpDate: followUpDateWhere } : {}),
    ...(blockedStages.length ? { NOT: { stage: { in: blockedStages } } } : {}),
  };

  res.json(await prisma.opportunity.findMany({
    where,
    include: {
      client: true,
      ownerSeller: { select: { id: true, name: true, email: true } }
    },
    orderBy: [{ followUpDate: "asc" }, { value: "desc" }]
  }));
});
router.post("/opportunities", validateBody(opportunitySchema), async (req, res) => res.status(201).json(await prisma.opportunity.create({ data: { ...req.body, proposalDate: new Date(req.body.proposalDate), followUpDate: new Date(req.body.followUpDate), expectedCloseDate: new Date(req.body.expectedCloseDate), lastContactAt: req.body.lastContactAt ? new Date(req.body.lastContactAt) : null, ownerSellerId: resolveOwnerId(req, req.body.ownerSellerId) } })));
router.put("/opportunities/:id", validateBody(opportunitySchema.partial()), async (req, res) => res.json(await prisma.opportunity.update({ where: { id: req.params.id }, data: { ...req.body, ...(req.body.proposalDate ? { proposalDate: new Date(req.body.proposalDate) } : {}), ...(req.body.followUpDate ? { followUpDate: new Date(req.body.followUpDate) } : {}), ...(req.body.expectedCloseDate ? { expectedCloseDate: new Date(req.body.expectedCloseDate) } : {}), ...(req.body.lastContactAt !== undefined ? { lastContactAt: req.body.lastContactAt ? new Date(req.body.lastContactAt) : null } : {}) } })));
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
