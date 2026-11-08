import type { Request, Response } from "express";
import { Role, WhatsAppConnectionStatus } from "@prisma/client";
import {
  WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES,
  whatsappDailySummaryConfigSchema,
  whatsappDailySummarySellerSchema
} from "@salesforce-pro/shared";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { validateBody } from "../middlewares/validate.js";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { logApiEvent } from "../utils/logger.js";
import { isWhatsAppEvolutionConfigured, isWhatsAppEvolutionEnabled } from "../services/whatsappConnection/config.js";
import { resolveCrmUserRecipient } from "../services/whatsappConnection/crmUserRecipient.js";
import {
  appConfigDailySummaryStore,
  brazilClock,
  loadDailySummaryConfig,
  saveDailySummaryConfig
} from "../services/whatsappDailySummary/dailySummaryConfig.js";
import { buildDailySummaryText } from "../services/whatsappDailySummary/dailySummaryData.js";
import {
  checkDailySummarySender,
  DAILY_SUMMARY_SENDER_MESSAGES,
  DAILY_SUMMARY_SENDER_ROLES,
  sendDailySummaryText
} from "../services/whatsappDailySummary/dailySummarySender.js";

// WhatsApp Fase D: tela do resumo diário (Configurações → Automações Comerciais).
// - diretor e gerente veem configuração, situação do dia, prévia e "Enviar teste para mim"; só diretor salva;
// - a prévia nunca envia; o teste vai só para o celular de quem clicou (usuário ativo do CRM), pelo remetente;
// - log só com o resultado e o código.
export const whatsappDailySummaryRoutes = createAsyncRouter();

whatsappDailySummaryRoutes.use("/daily-summary", authMiddleware);

/** Intervalo mínimo entre dois "Enviar teste para mim" do mesmo usuário. */
export const TEST_SEND_COOLDOWN_MS = 60_000;
const lastTestSendAt = new Map<string, number>();
export const resetDailySummaryTestCooldown = () => lastTestSendAt.clear();

const isAvailable = () => isWhatsAppEvolutionEnabled() && isWhatsAppEvolutionConfigured();

const recipientView = async (userId: string) => {
  const resolution = await resolveCrmUserRecipient(userId);
  return resolution.ok ? { ok: true as const } : { ok: false as const, reason: resolution.reason, message: WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES[resolution.reason] };
};

const findActiveSeller = (sellerId: string) =>
  prisma.user.findFirst({ where: { id: sellerId, role: Role.vendedor, isActive: true }, select: { id: true, name: true } });

whatsappDailySummaryRoutes.get("/daily-summary", authorize(Role.diretor, Role.gerente), async (_req, res) => {
  const now = new Date();
  const clock = brazilClock(now);
  const config = await loadDailySummaryConfig();
  const [senderUsers, sellerUsers] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: [...DAILY_SUMMARY_SENDER_ROLES] }, isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { role: Role.vendedor, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  ]);
  const connections = await prisma.whatsAppConnection.findMany({
    where: { userId: { in: senderUsers.map((user) => user.id) } },
    select: { userId: true, status: true, connectedPhone: true }
  });
  const connected = new Set(connections.filter((row) => row.status === WhatsAppConnectionStatus.CONNECTED && row.connectedPhone).map((row) => row.userId));
  const store = appConfigDailySummaryStore();
  const [days, lastRun] = await Promise.all([store.getSellerDays(clock.dayKey, sellerUsers.map((user) => user.id)), store.getRunState()]);
  const sellers = [];
  for (const user of sellerUsers) {
    sellers.push({ userId: user.id, name: user.name, recipient: await recipientView(user.id), today: days.get(user.id) ?? null });
  }
  const sender = config.senderUserId ? senderUsers.find((user) => user.id === config.senderUserId) : undefined;
  return res.json({
    whatsappEnabled: isAvailable(),
    crmLinkConfigured: Boolean(env.frontendUrl),
    config,
    senders: senderUsers.map((user) => ({ userId: user.id, name: user.name, role: user.role, connected: connected.has(user.id) })),
    senderStatus: !config.senderUserId
      ? { ok: false, code: "sender_not_configured", message: DAILY_SUMMARY_SENDER_MESSAGES.sender_not_configured }
      : !sender
        ? { ok: false, code: "sender_not_allowed", message: DAILY_SUMMARY_SENDER_MESSAGES.sender_not_allowed }
        : !connected.has(sender.id)
          ? { ok: false, code: "sender_not_connected", message: DAILY_SUMMARY_SENDER_MESSAGES.sender_not_connected }
          : { ok: true },
    today: { dayKey: clock.dayKey, isBusinessDay: clock.weekday !== 0 && clock.weekday !== 6, run: lastRun?.dayKey === clock.dayKey ? lastRun : null },
    lastRun,
    sellers
  });
});

whatsappDailySummaryRoutes.put("/daily-summary/config", authorize(Role.diretor), validateBody(whatsappDailySummaryConfigSchema), async (req, res) => {
  const config = whatsappDailySummaryConfigSchema.parse(req.body);
  if (config.senderUserId) {
    const sender = await prisma.user.findFirst({ where: { id: config.senderUserId, role: { in: [...DAILY_SUMMARY_SENDER_ROLES] }, isActive: true }, select: { id: true } });
    if (!sender) return res.status(400).json({ message: DAILY_SUMMARY_SENDER_MESSAGES.sender_not_allowed, code: "sender_not_allowed" });
  }
  return res.json(await saveDailySummaryConfig(config));
});

whatsappDailySummaryRoutes.post("/daily-summary/preview", authorize(Role.diretor, Role.gerente), validateBody(whatsappDailySummarySellerSchema), async (req, res) => {
  const { sellerId } = whatsappDailySummarySellerSchema.parse(req.body);
  const seller = await findActiveSeller(sellerId);
  if (!seller) return res.status(404).json({ message: "Vendedor ativo não encontrado.", code: "seller_not_found" });
  const config = await loadDailySummaryConfig();
  const text = await buildDailySummaryText(seller, config.sections, new Date());
  return res.json({ text, empty: text === null, recipient: await recipientView(seller.id) });
});

const testText = (sellerName: string, text: string | null) =>
  `[Teste] ${text ?? `Resumo diário: nada a enviar hoje para ${sellerName.split(" ")[0] || "este vendedor"} (vendedor sem itens não recebe mensagem).`}`;

whatsappDailySummaryRoutes.post("/daily-summary/test-send", authorize(Role.diretor, Role.gerente), validateBody(whatsappDailySummarySellerSchema), async (req: Request, res: Response) => {
  if (!isAvailable()) return res.status(409).json({ message: "Integração de WhatsApp desativada.", code: "whatsapp_disabled" });
  const userId = req.user!.id;
  const last = lastTestSendAt.get(userId);
  if (last !== undefined && Date.now() - last < TEST_SEND_COOLDOWN_MS) {
    return res.status(429).json({ message: "Aguarde um minuto antes de enviar outro teste.", code: "test_send_cooldown" });
  }
  const { sellerId } = whatsappDailySummarySellerSchema.parse(req.body);
  const seller = await findActiveSeller(sellerId);
  if (!seller) return res.status(404).json({ message: "Vendedor ativo não encontrado.", code: "seller_not_found" });
  const config = await loadDailySummaryConfig();
  const sender = await checkDailySummarySender(config.senderUserId);
  if (!sender.ok) return res.status(409).json({ message: DAILY_SUMMARY_SENDER_MESSAGES[sender.code], code: sender.code });
  const recipient = await resolveCrmUserRecipient(userId);
  if (!recipient.ok) {
    return res.status(409).json({ message: `Seu cadastro não pode receber o teste: ${WHATSAPP_CRM_RECIPIENT_REFUSAL_MESSAGES[recipient.reason]}`, code: recipient.reason });
  }
  lastTestSendAt.set(userId, Date.now());
  const text = await buildDailySummaryText(seller, config.sections, new Date());
  const result = await sendDailySummaryText(sender.instanceName, recipient.recipient, testText(seller.name, text));
  const code = result.kind === "sent" ? null : result.code;
  logApiEvent(result.kind === "sent" ? "INFO" : "WARN", "[whatsapp daily summary] test send", { result: result.kind, code });
  return res.json({ result: result.kind, code });
});
