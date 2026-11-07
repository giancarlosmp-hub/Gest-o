import type { Request, Response } from "express";
import { Role, WhatsAppConnectionStatus } from "@prisma/client";
import { z } from "zod";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { prisma } from "../config/prisma.js";
import { resolveUniqueActiveTenantForUser } from "../services/ultraFv3SyncService.js";
import { EVOLUTION_PROVIDER } from "../services/whatsappMessages/whatsappMessageStore.js";
import { brazilDayStart, readClientDayCards, readConversationDayMessages } from "../services/whatsappMessages/whatsappConversationReads.js";
import { isWhatsAppMessagesEnabled } from "../services/whatsappConnection/config.js";
import { readRecordingState, recordingSinceFor } from "../services/whatsappMessages/whatsappRecordingState.js";
import {
  WhatsAppQueueError,
  countUnlinkedConversations,
  discardUnlinkedConversation,
  linkUnlinkedConversation,
  listUnlinkedConversations
} from "../services/whatsappMessages/whatsappConversationQueue.js";

// WhatsApp Fase B2: leitura das conversas gravadas (Evolution). Não existe envio.
// Quem vê:
// - gerente e diretor: tudo do próprio tenant;
// - vendedor: conversas dos clientes da carteira atual dele (client.ownerSellerId) e, só na rota e na tela
//   da oportunidade, as do cliente de uma oportunidade dele (desde a criação da oportunidade).
// Fila "Conversas não vinculadas": só a do próprio usuário (dono do número), inclusive gerente e diretor.
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

const sendQueueError = (res: Response, error: unknown) => {
  if (error instanceof WhatsAppQueueError) return res.status(error.status).json({ message: error.message, code: error.code });
  throw error;
};

whatsappMessagesRoutes.get("/unlinked", async (req, res) => {
  return res.json(await listUnlinkedConversations({ ownerUserId: req.user!.id, cursor: queryText(req.query.cursor), take: parseTake(req) }));
});

const linkBodySchema = z.object({ clientId: z.string().trim().min(1).max(64) });

whatsappMessagesRoutes.post("/unlinked/:conversationId/link", validateBody(linkBodySchema), async (req, res) => {
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  try {
    return res.json(await linkUnlinkedConversation({ conversationId: req.params.conversationId, clientId: req.body.clientId, user: req.user!, tenantId }));
  } catch (error) {
    return sendQueueError(res, error);
  }
});

whatsappMessagesRoutes.post("/unlinked/:conversationId/discard", async (req, res) => {
  try {
    return res.json(await discardUnlinkedConversation({ conversationId: req.params.conversationId, ownerUserId: req.user!.id }));
  } catch (error) {
    return sendQueueError(res, error);
  }
});

// Cartão "Meu número": gravação ligada/desligada desde quando e o tamanho da própria fila.
whatsappMessagesRoutes.get("/messages/summary", async (req, res) => {
  const [state, connection, unlinkedCount] = await Promise.all([
    readRecordingState(),
    prisma.whatsAppConnection.findUnique({ where: { userId: req.user!.id }, select: { status: true, connectedAt: true } }),
    countUnlinkedConversations(req.user!.id)
  ]);
  const enabled = isWhatsAppMessagesEnabled();
  const connectedAt = connection?.status === WhatsAppConnectionStatus.CONNECTED ? connection.connectedAt : null;
  return res.json({ recording: { enabled, since: recordingSinceFor({ enabled, state, connectedAt }) }, unlinkedCount });
});
