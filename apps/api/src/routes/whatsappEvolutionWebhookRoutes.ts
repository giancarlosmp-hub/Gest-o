import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { env } from "../config/env.js";
import { whatsappEvolutionWebhookRateLimit } from "../middlewares/rateLimit.js";
import { logApiEvent } from "../utils/logger.js";
import { EVOLUTION_WEBHOOK_SECRET_HEADER, isWhatsAppEvolutionEnabled } from "../services/whatsappConnection/config.js";
import { EvolutionUnavailableError } from "../services/whatsappConnection/evolutionClient.js";
import { whatsappConnectionService } from "../services/whatsappConnection/whatsappConnectionService.js";
import { isEvolutionMessageEvent } from "../services/whatsappMessages/evolutionMessageParser.js";
import { whatsappMessageIngestion } from "../services/whatsappMessages/whatsappMessageIngestion.js";

// Webhook interno do Evolution: eventos de conexão (Fase A) e, com a Fase B ligada, de mensagem (nova,
// editada, apagada). O Evolution chama a API pelo alias interno na rede Docker, sem passar pelo nginx.
// Proteções, nesta ordem:
// - flag desligada: 404;
// - requisição que passou pelo proxy (X-Forwarded-For, X-Real-IP ou Forwarded): 404;
// - segredo do header comparado em tempo constante: 401;
// - corpo cru de até 512 KiB (mensagens trazem miniatura e mensagem citada), lido como JSON só depois do
//   segredo.
// Rate limit próprio (todos os eventos vêm do mesmo container). O corpo (apikey da instância, número,
// texto, nome) nunca vai para log: o handler de erro troca o corpo por "[raw-body-redacted]" em
// /webhooks/communications/*, e o log de mensagem traz só códigos e contagens. Falha ao gravar mensagem:
// 503 sem detalhes, para o Evolution tentar de novo.
export const whatsappEvolutionWebhookRoutes = createAsyncRouter();

export const EVOLUTION_WEBHOOK_BODY_LIMIT = "512kb";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function isValidWebhookSecret(provided: string | undefined, expected: string) {
  if (!expected || typeof provided !== "string" || !provided || provided.length > 512) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

const cameThroughProxy = (req: express.Request) => Boolean(req.get("x-forwarded-for") || req.get("x-real-ip") || req.get("forwarded"));

/** Nome e código do erro, nunca a mensagem (erros do Prisma podem trazer valores gravados). */
const safeErrorFields = (error: unknown) => ({
  error: error instanceof Error ? error.name : "unknown",
  ...(error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? { code: (error as { code: string }).code } : {})
});

whatsappEvolutionWebhookRoutes.post(
  "/",
  whatsappEvolutionWebhookRateLimit,
  (req, res, next) => {
    // Antes de ler o corpo: nada de fora da rede interna chega ao parser.
    if (!isWhatsAppEvolutionEnabled() || cameThroughProxy(req)) return res.status(404).json({ message: "Not found" });
    if (!isValidWebhookSecret(req.get(EVOLUTION_WEBHOOK_SECRET_HEADER), env.whatsappEvolutionWebhookSecret)) {
      return res.status(401).json({ message: "Invalid secret" });
    }
    next();
  },
  express.raw({ type: () => true, limit: EVOLUTION_WEBHOOK_BODY_LIMIT }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: "Invalid body" });
    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ message: "Invalid JSON" });
    }

    const eventName = (payload as { event?: unknown } | null)?.event;
    if (isEvolutionMessageEvent(eventName)) {
      const started = Date.now();
      try {
        const result = await whatsappMessageIngestion.handle(payload);
        logApiEvent("INFO", "[whatsapp] message event", { ...result, durationMs: Date.now() - started });
        return res.status(result.status === "unknown_instance" ? 202 : 200).json({ status: result.status });
      } catch (error) {
        logApiEvent("WARN", "[whatsapp] message event failed", { ...safeErrorFields(error), durationMs: Date.now() - started });
        return res.status(503).json({ message: "Temporarily unavailable" });
      }
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
