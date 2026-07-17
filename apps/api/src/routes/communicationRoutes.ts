import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { communicationIntegrationService } from "../services/communications/communicationIntegrationService.js";
import { logApiEvent } from "../utils/logger.js";

export const communicationWebhookRouter = Router();
export const communicationAdminRouter = Router();

communicationWebhookRouter.get("/webhooks/communications/meta-whatsapp", appUsageRateLimit, (req, res) => {
  const result = communicationIntegrationService.verifyMetaWhatsappChallenge(req.query);
  logApiEvent(result.valid ? "INFO" : "WARN", result.valid ? "[communications/meta-whatsapp] verification-success" : "[communications/meta-whatsapp] verification-failed", { channelType: "WHATSAPP", providerType: "META_WHATSAPP_CLOUD" });
  if (!result.valid) return res.status(403).send("Forbidden");
  return res.status(200).send(result.challenge || "");
});

communicationWebhookRouter.post("/webhooks/communications/meta-whatsapp", appUsageRateLimit, express.raw({ type: "application/json", limit: "512kb" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(rawBody.toString("utf8")); } catch { return res.status(400).json({ message: "invalid_json" }); }
  const result = await communicationIntegrationService.processMetaWhatsappWebhook({ rawBody, parsedBody, headers: req.headers });
  if (!result.accepted) return res.status(result.status || 400).json({ message: result.error || "webhook_rejected" });
  return res.status(200).json({ ok: true, processed: result.processed, duplicates: result.duplicates, disabled: result.disabled });
});

communicationAdminRouter.get("/communications/integrations/meta-whatsapp/status", authMiddleware, appUsageRateLimit, async (req, res) => {
  if (!req.user || !["diretor", "gerente"].includes(req.user.role)) return res.status(403).json({ message: "Acesso negado" });
  return res.json(await communicationIntegrationService.getIntegrationStatus());
});

export const statusRouteResponseSchema = z.object({ enabled: z.boolean(), channel: z.literal("WHATSAPP"), provider: z.literal("META_WHATSAPP_CLOUD"), configured: z.boolean() });
