import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { env } from "../config/env.js";
import { communicationsWebhookRateLimit } from "../middlewares/rateLimit.js";
import { EVOLUTION_WEBHOOK_SECRET_HEADER, isWhatsAppEvolutionEnabled } from "../services/whatsappConnection/config.js";
import { EvolutionUnavailableError } from "../services/whatsappConnection/evolutionClient.js";
import { whatsappConnectionService } from "../services/whatsappConnection/whatsappConnectionService.js";

// Webhook interno do Evolution (WhatsApp Fase A): só eventos de conexão. O Evolution chama a API pelo
// alias interno na rede Docker, sem passar pelo nginx. Proteções, nesta ordem:
// - flag desligada: 404;
// - requisição que passou pelo proxy (X-Forwarded-For, X-Real-IP ou Forwarded): 404;
// - segredo do header comparado em tempo constante: 401;
// - corpo cru de até 64 KiB, lido como JSON só depois do segredo.
// O corpo (que traz o apikey da instância e o número) nunca vai para log; o handler de erro da API já
// troca o corpo por "[raw-body-redacted]" em /webhooks/communications/*.
export const whatsappEvolutionWebhookRoutes = createAsyncRouter();

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function isValidWebhookSecret(provided: string | undefined, expected: string) {
  if (!expected || typeof provided !== "string" || !provided || provided.length > 512) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

const cameThroughProxy = (req: express.Request) => Boolean(req.get("x-forwarded-for") || req.get("x-real-ip") || req.get("forwarded"));

whatsappEvolutionWebhookRoutes.post(
  "/",
  communicationsWebhookRateLimit,
  (req, res, next) => {
    // Antes de ler o corpo: nada de fora da rede interna chega ao parser.
    if (!isWhatsAppEvolutionEnabled() || cameThroughProxy(req)) return res.status(404).json({ message: "Not found" });
    if (!isValidWebhookSecret(req.get(EVOLUTION_WEBHOOK_SECRET_HEADER), env.whatsappEvolutionWebhookSecret)) {
      return res.status(401).json({ message: "Invalid secret" });
    }
    next();
  },
  express.raw({ type: () => true, limit: "64kb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: "Invalid body" });
    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ message: "Invalid JSON" });
    }
    try {
      const result = await whatsappConnectionService.applyConnectionEvent(payload);
      return res.status(result === "unknown_instance" ? 202 : 200).json({ status: result });
    } catch (error) {
      // Evolution fora do ar ao confirmar o número: 503 para o Evolution tentar de novo.
      if (error instanceof EvolutionUnavailableError) return res.status(503).json({ message: "Temporarily unavailable" });
      throw error;
    }
  }
);
