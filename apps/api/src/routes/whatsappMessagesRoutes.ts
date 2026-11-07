import type { Request, Response } from "express";
import { Role } from "@prisma/client";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { authMiddleware } from "../middlewares/auth.js";
import { prisma } from "../config/prisma.js";
import { resolveUniqueActiveTenantForUser } from "../services/ultraFv3SyncService.js";
import { EVOLUTION_PROVIDER } from "../services/whatsappMessages/whatsappMessageStore.js";
import { brazilDayStart, readClientDayCards, readConversationDayMessages } from "../services/whatsappMessages/whatsappConversationReads.js";

// WhatsApp Fase B2: leitura das conversas gravadas (Evolution). Não existe envio.
// Quem vê:
// - gerente e diretor: tudo do próprio tenant;
// - vendedor: conversas dos clientes da carteira atual dele (client.ownerSellerId) e, só na rota e na tela
//   da oportunidade, as do cliente de uma oportunidade dele (desde a criação da oportunidade).
// A leitura não depende da flag de gravação: o que já foi gravado continua visível dentro da retenção.
export const whatsappMessagesRoutes = createAsyncRouter();

whatsappMessagesRoutes.use(authMiddleware);

const isManager = (req: Request) => req.user!.role === Role.diretor || req.user!.role === Role.gerente;

const resolveTenant = async (req: Request, res: Response) => {
  try {
    return await resolveUniqueActiveTenantForUser(req.user!.id);
  } catch (error) {
    if ((error as { status?: number })?.status !== 403) throw error;
    res.status(403).json({ message: "Contexto de tenant ausente ou ambíguo." });
    return null;
  }
};

const readableClient = (req: Request, tenantId: string, clientId: string) =>
  prisma.client.findFirst({
    where: { id: clientId, tenantId, ...(isManager(req) ? {} : { ownerSellerId: req.user!.id }) },
    select: { id: true }
  });

const readableOpportunity = (req: Request, tenantId: string, opportunityId: string) =>
  prisma.opportunity.findFirst({
    where: {
      id: opportunityId,
      client: { tenantId },
      ...(isManager(req) ? {} : { OR: [{ ownerSellerId: req.user!.id }, { client: { ownerSellerId: req.user!.id } }] })
    },
    select: { id: true, clientId: true, createdAt: true }
  });

const queryText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const parseBefore = (req: Request, res: Response) => {
  const before = queryText(req.query.before);
  if (before && !brazilDayStart(before)) {
    res.status(400).json({ message: "Dia inválido.", code: "invalid_day" });
    return undefined;
  }
  return before;
};

const parseTake = (req: Request) => {
  const take = Number(req.query.take);
  return Number.isFinite(take) ? take : undefined;
};

whatsappMessagesRoutes.get("/clients/:clientId/days", async (req, res) => {
  const before = parseBefore(req, res);
  if (before === undefined) return;
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const client = await readableClient(req, tenantId, req.params.clientId);
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });
  return res.json(await readClientDayCards({ clientId: client.id, before, take: parseTake(req) }));
});

whatsappMessagesRoutes.get("/opportunities/:opportunityId/days", async (req, res) => {
  const before = parseBefore(req, res);
  if (before === undefined) return;
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const opportunity = await readableOpportunity(req, tenantId, req.params.opportunityId);
  if (!opportunity) return res.status(404).json({ message: "Oportunidade não encontrada." });
  const page = await readClientDayCards({ clientId: opportunity.clientId, before, since: opportunity.createdAt, take: parseTake(req) });
  return res.json({ ...page, clientId: opportunity.clientId, since: opportunity.createdAt });
});

whatsappMessagesRoutes.get("/conversations/:conversationId/messages", async (req, res) => {
  const day = queryText(req.query.day);
  if (!day || !brazilDayStart(day)) return res.status(400).json({ message: "Dia inválido.", code: "invalid_day" });
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const notFound = () => res.status(404).json({ message: "Conversa não encontrada." });
  const conversation = await prisma.communicationConversation.findFirst({
    where: { id: req.params.conversationId, provider: EVOLUTION_PROVIDER, clientId: { not: null }, client: { tenantId } },
    select: { clientId: true }
  });
  if (!conversation?.clientId) return notFound();

  // Pela oportunidade: só mensagens desde a criação dela, e só se a conversa é do cliente dela.
  let since: Date | null = null;
  const opportunityId = queryText(req.query.opportunityId);
  if (opportunityId) {
    const opportunity = await readableOpportunity(req, tenantId, opportunityId);
    if (!opportunity || opportunity.clientId !== conversation.clientId) return notFound();
    since = opportunity.createdAt;
  } else if (!(await readableClient(req, tenantId, conversation.clientId))) {
    return notFound();
  }
  return res.json(await readConversationDayMessages({ conversationId: req.params.conversationId, day, since, cursor: queryText(req.query.cursor) }));
});
