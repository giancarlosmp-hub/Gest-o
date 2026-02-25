import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { authorize } from "../middlewares/authorize.js";
import { resolveOwnerId, sellerWhere } from "../utils/access.js";

import {
  activitySchema,
  clientSchema,
  companySchema,
  contactSchema,
  goalSchema,
  opportunitySchema,
  timelineCommentSchema
} from "@salesforce-pro/shared";

const router = Router();

router.use(authMiddleware);

const CLOSED_STAGE_VALUES = ["ganho", "perdido"] as const;
const CLOSED_STAGES = new Set<string>(CLOSED_STAGE_VALUES);

function normalizeOpportunityDates(body: any) {
  return {
    ...body,
    proposalDate: body.proposalDate ? new Date(body.proposalDate) : undefined,
    followUpDate: body.followUpDate ? new Date(body.followUpDate) : undefined,
    expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : undefined,
    plantingForecastDate: body.plantingForecastDate ? new Date(body.plantingForecastDate) : undefined,
  };
}

async function createTimelineEvent(data: {
  type: any;
  title: string;
  message: string;
  clientId: string;
  opportunityId?: string;
  userId: string;
  meta?: any;
}) {
  await prisma.timelineEvent.create({
    data: {
      type: data.type,
      title: data.title,
      message: data.message,
      clientId: data.clientId,
      opportunityId: data.opportunityId,
      userId: data.userId,
      meta: data.meta
    }
  });
}

//
// ========================= OPPORTUNITIES =========================
//

router.post(
  "/opportunities",
  validateBody(opportunitySchema),
  async (req, res) => {
    const ownerSellerId = resolveOwnerId(req);

    const data = await prisma.opportunity.create({
      data: {
        ...normalizeOpportunityDates(req.body),
        ownerSellerId
      }
    });

    // 🔵 Evento: criação da oportunidade
    await createTimelineEvent({
      type: "criacao_oportunidade",
      title: "Oportunidade criada",
      message: `A oportunidade "${data.title}" foi criada no estágio ${data.stage}.`,
      clientId: data.clientId,
      opportunityId: data.id,
      userId: req.user!.id,
      meta: { stage: data.stage, value: data.value }
    });

    // 🔵 Evento: comentário inicial
    if (req.body.notes?.trim()) {
      await createTimelineEvent({
        type: "comentario",
        title: "Comentário adicionado",
        message: req.body.notes,
        clientId: data.clientId,
        opportunityId: data.id,
        userId: req.user!.id
      });
    }

    return res.status(201).json(data);
  }
);

router.put(
  "/opportunities/:id",
  validateBody(opportunitySchema),
  async (req, res) => {
    const current = await prisma.opportunity.findFirst({
      where: { id: req.params.id, ...sellerWhere(req) }
    });

    if (!current) {
      return res.status(404).json({ message: "Oportunidade não encontrada" });
    }

    const data = await prisma.opportunity.update({
      where: { id: req.params.id },
      data: normalizeOpportunityDates(req.body) as any
    });

    // 🔵 Mudança de estágio
    if (req.body.stage && req.body.stage !== current.stage) {
      await createTimelineEvent({
        type: "mudanca_estagio",
        title: "Mudança de estágio",
        message: `Estágio alterado de ${current.stage} para ${req.body.stage}.`,
        clientId: data.clientId,
        opportunityId: data.id,
        userId: req.user!.id,
        meta: { from: current.stage, to: req.body.stage }
      });
    }

    // 🔵 Mudança de follow-up
    if (
      req.body.followUpDate &&
      current.followUpDate?.toISOString() !== data.followUpDate?.toISOString()
    ) {
      await createTimelineEvent({
        type: "mudanca_followup",
        title: "Mudança de follow-up",
        message: `Follow-up alterado.`,
        clientId: data.clientId,
        opportunityId: data.id,
        userId: req.user!.id
      });
    }

    // 🔵 Novo comentário
    if (req.body.notes && req.body.notes !== current.notes) {
      await createTimelineEvent({
        type: "comentario",
        title: "Comentário atualizado",
        message: req.body.notes,
        clientId: data.clientId,
        opportunityId: data.id,
        userId: req.user!.id
      });
    }

    return res.json(data);
  }
);

router.get("/opportunities", async (req, res) => {
  const where = sellerWhere(req);

  const data = await prisma.opportunity.findMany({
    where,
    orderBy: { createdAt: "desc" }
  });

  res.json(data);
});

router.delete("/opportunities/:id", async (req, res) => {
  await prisma.opportunity.delete({
    where: { id: req.params.id }
  });

  res.status(204).send();
});

export default router;