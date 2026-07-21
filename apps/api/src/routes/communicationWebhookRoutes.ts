import express from "express";
import { env } from "../config/env.js";
import { communicationIntegrationService } from "../services/communications/communicationIntegrationService.js";
import { communicationsWebhookRateLimit } from "../middlewares/rateLimit.js";

export const communicationWebhookRoutes = express.Router();

communicationWebhookRoutes.get("/meta-whatsapp", communicationsWebhookRateLimit, (req, res) => {
  const result = communicationIntegrationService.getProvider().verifyChallenge(req.query, env.whatsappWebhookVerifyToken);
  if (!result.ok) return res.status(result.status).json({ message: result.reason });
  return res.status(200).type("text/plain").send(result.challenge);
});

communicationWebhookRoutes.post(
  "/meta-whatsapp",
  communicationsWebhookRateLimit,
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res, next) => {
    try {
      if (!req.is("application/json")) return res.status(415).json({ message: "Unsupported media type" });
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: "Invalid raw body" });
      const result = await communicationIntegrationService.processMetaWhatsAppWebhook(req.body, req.get("x-hub-signature-256"), req.requestId);
      if (result.status === "disabled") return res.status(200).json(result);
      if (result.status === "misconfigured") return res.status(503).json({ message: "Integration misconfigured" });
      if (result.status === "invalid_signature") return res.status(401).json({ message: "Invalid signature" });
      if (result.status === "invalid_json") return res.status(400).json({ message: "Invalid JSON" });
      return res.status(200).json(result);
    } catch (error) { next(error); }
  }
);
