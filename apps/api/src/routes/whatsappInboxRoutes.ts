import type { Request, Response } from "express";
import { Role, WhatsAppConnectionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { validateBody } from "../middlewares/validate.js";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { resolveUniqueActiveTenantForUser } from "../services/ultraFv3SyncService.js";
import { EVOLUTION_PROVIDER } from "../services/whatsappMessages/whatsappMessageStore.js";
import {
  CRM_SEND_HTTP_STATUS,
  CRM_SEND_MAX_TEXT_LENGTH,
  CRM_SEND_MESSAGES,
  sendCrmText
} from "../services/whatsappConversations/crmConversationSender.js";
import { isCrmSendAvailable, loadCrmSendConfig, saveCrmSendConfig } from "../services/whatsappConversations/crmSendConfig.js";
import { CRM_SEND_LIMITS, crmSendLimiter } from "../services/whatsappConversations/crmSendLimits.js";
import {
  countOwnUnread,
  inboxConversationSelect,
  listInbox,
  readClientPhoneTargets,
  readInboxMessages,
  toInboxConversationView,
  type InboxConversationRow,
  type InboxViewer
} from "../services/whatsappConversations/inboxReads.js";

// WhatsApp Fase C: caixa de conversas e envio de texto pelo CRM (/whatsapp/inbox...).
// Quem vê:
// - "Meu número": as conversas vinculadas do próprio número (todos os perfis); abrir zera as não lidas;
// - "Equipe": gerente e diretor veem as dos outros números do tenant, SOMENTE LEITURA (não zera não lidas,
//   não responde: para enviar, só pelo próprio número, em conversa própria).
// Envio: um texto para um destino por requisição (conversa vinculada do próprio número, ou cliente + referência
// de telefone do índice). Nunca número digitado, nunca lista. Chave desligada por padrão; só o diretor muda.
// Ids vão na query ou no corpo; esta rota não grava log (o envio grava só resultado e código).
export const whatsappInboxRoutes = createAsyncRouter();

whatsappInboxRoutes.use("/inbox", authMiddleware);

const isManager = (req: Request) => req.user!.role === Role.diretor || req.user!.role === Role.gerente;
const viewerOf = (req: Request): InboxViewer => ({ id: req.user!.id, manager: isManager(req) });

const resolveTenant = async (req: Request, res: Response) => {
  try {
    return await resolveUniqueActiveTenantForUser(req.user!.id);
  } catch (error) {
    if ((error as { status?: number })?.status !== 403) throw error;
    res.status(403).json({ message: "Contexto de tenant ausente ou ambíguo." });
    return null;
  }
};

const queryText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const ownConnection = async (userId: string) => {
  const row = await prisma.whatsAppConnection.findUnique({ where: { userId }, select: { status: true, connectedPhone: true } });
  return row?.status === WhatsAppConnectionStatus.CONNECTED && row.connectedPhone ? row.connectedPhone : null;
};

/** Conversa vinculada do tenant que este usuário pode abrir: a do próprio número; gestão também as dos outros. */
const readableConversation = async (req: Request, tenantId: string, conversationId: string) => {
  const row = (await prisma.communicationConversation.findFirst({
    where: {
      id: conversationId,
      provider: EVOLUTION_PROVIDER,
      linkStatus: "linked",
      clientId: { not: null },
      client: { tenantId },
      ...(isManager(req) ? { numberOwnerUserId: { not: null } } : { numberOwnerUserId: req.user!.id })
    },
    select: inboxConversationSelect
  })) as unknown as InboxConversationRow | null;
  return row;
};

const notFound = (res: Response) => res.status(404).json({ message: "Conversa não encontrada." });

// Situação do envio para a tela: chave, número conectado, limites e uso de hoje, não lidas do próprio número.
whatsappInboxRoutes.get("/inbox/status", async (req, res) => {
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const [config, account, unreadTotal] = await Promise.all([loadCrmSendConfig(), ownConnection(req.user!.id), countOwnUnread({ tenantId, ownerUserId: req.user!.id })]);
  const available = isCrmSendAvailable();
  return res.json({
    available,
    enabled: config.enabled,
    sendEnabled: available && config.enabled,
    connected: Boolean(account),
    canEditConfig: req.user!.role === Role.diretor,
    limits: { perMinute: CRM_SEND_LIMITS.perMinute, perDay: CRM_SEND_LIMITS.perDay, firstContactsPerDay: CRM_SEND_LIMITS.firstContactsPerDay, maxTextLength: CRM_SEND_MAX_TEXT_LENGTH },
    today: account ? await crmSendLimiter.today(req.user!.id, account) : null,
    unreadTotal
  });
});

const configSchema = z.object({ enabled: z.boolean() }).strict();

whatsappInboxRoutes.put("/inbox/send-config", authorize(Role.diretor), validateBody(configSchema), async (req, res) => {
  return res.json(await saveCrmSendConfig({ enabled: req.body.enabled }));
});

// Caixa: "mine" (padrão) = próprio número; "team" (gestão) = outros números do tenant, opcionalmente um dono.
whatsappInboxRoutes.get("/inbox", async (req, res) => {
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const scope = queryText(req.query.scope) ?? "mine";
  if (scope !== "mine" && scope !== "team") return res.status(400).json({ message: "Escopo inválido.", code: "invalid_scope" });
  if (scope === "team" && !isManager(req)) return res.status(403).json({ message: "Somente gerente ou diretor vê as conversas da equipe." });
  const ownerUserId = scope === "mine" ? req.user!.id : queryText(req.query.ownerUserId);
  const take = Number(req.query.take);
  return res.json(
    await listInbox({
      tenantId,
      viewer: viewerOf(req),
      ownerUserId,
      excludeOwnerUserId: scope === "team" ? req.user!.id : null,
      cursor: queryText(req.query.cursor),
      take: Number.isFinite(take) ? take : undefined
    })
  );
});

// Conversa aberta: cabeçalho e mensagens (últimas, anteriores com `before`, ou alteradas desde `changedSince`).
whatsappInboxRoutes.get("/inbox/messages", async (req, res) => {
  const conversationId = queryText(req.query.conversationId);
  if (!conversationId) return res.status(400).json({ message: "Conversa obrigatória.", code: "invalid_conversation" });
  const changedSinceText = queryText(req.query.changedSince);
  const changedSince = changedSinceText ? new Date(changedSinceText) : null;
  if (changedSince && Number.isNaN(changedSince.getTime())) return res.status(400).json({ message: "Data inválida.", code: "invalid_since" });
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const conversation = await readableConversation(req, tenantId, conversationId);
  if (!conversation) return notFound(res);
  const serverTime = new Date();
  const page = await readInboxMessages({ conversationId, before: queryText(req.query.before), changedSince });
  return res.json({ conversation: toInboxConversationView(conversation, viewerOf(req)), ...page, serverTime });
});

const conversationBodySchema = z.object({ conversationId: z.string().trim().min(1).max(64) }).strict();

// Lida / não lida: só o dono do número (gestão olhando outro número não mexe nas não lidas do vendedor).
const setUnread = (value: "read" | "unread") => async (req: Request, res: Response) => {
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const conversation = await readableConversation(req, tenantId, req.body.conversationId);
  if (!conversation || conversation.numberOwnerUserId !== req.user!.id) return notFound(res);
  if (value === "read") {
    await prisma.communicationConversation.updateMany({ where: { id: conversation.id, numberOwnerUserId: req.user!.id }, data: { unreadCount: 0 } });
    return res.json({ unreadCount: 0 });
  }
  await prisma.communicationConversation.updateMany({ where: { id: conversation.id, numberOwnerUserId: req.user!.id, unreadCount: 0 }, data: { unreadCount: 1 } });
  return res.json({ unreadCount: Math.max(conversation.unreadCount ?? 0, 1) });
};

whatsappInboxRoutes.post("/inbox/read", validateBody(conversationBodySchema), setUnread("read"));
whatsappInboxRoutes.post("/inbox/unread", validateBody(conversationBodySchema), setUnread("unread"));

// Abrir pelo cliente (botão "WhatsApp"): telefones do cadastro e a conversa do próprio número com cada um.
whatsappInboxRoutes.get("/inbox/client-targets", async (req, res) => {
  const clientId = queryText(req.query.clientId);
  if (!clientId) return res.status(400).json({ message: "Cliente obrigatório.", code: "invalid_client" });
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId, isArchived: false, ...(isManager(req) ? {} : { ownerSellerId: req.user!.id }) },
    select: { id: true, name: true }
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });
  const account = await ownConnection(req.user!.id);
  return res.json({
    client,
    connected: Boolean(account),
    phones: await readClientPhoneTargets({ clientId: client.id, account, ownerUserId: req.user!.id })
  });
});

// Envio: UM destino, UM texto. Objetos estritos: lista, número solto ou campo a mais = 400.
const sendBodySchema = z.union([
  z.object({ conversationId: z.string().trim().min(1).max(64), text: z.string().max(CRM_SEND_MAX_TEXT_LENGTH * 2) }).strict(),
  z.object({ clientId: z.string().trim().min(1).max(64), phoneRef: z.string().trim().min(1).max(64), text: z.string().max(CRM_SEND_MAX_TEXT_LENGTH * 2) }).strict()
]);

whatsappInboxRoutes.post("/inbox/send", async (req, res) => {
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Envie uma conversa ou um cliente com um telefone, e um texto.", code: "invalid_payload" });
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return;
  const body = parsed.data;
  const target = "conversationId" in body ? { conversationId: body.conversationId } : { clientId: body.clientId, phoneRef: body.phoneRef };
  const result = await sendCrmText({ user: { id: req.user!.id, role: req.user!.role }, tenantId, target, text: body.text });
  if (!result.ok) return res.status(CRM_SEND_HTTP_STATUS[result.code]).json({ message: CRM_SEND_MESSAGES[result.code], code: result.code });
  return res.status(201).json({ conversationId: result.conversationId, message: result.message });
});
