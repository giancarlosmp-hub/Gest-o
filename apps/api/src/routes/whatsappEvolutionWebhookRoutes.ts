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
// - corpo cru de até 4 MiB, lido como JSON só depois do segredo. O Evolution v2.3.7 converte os campos binários
//   da mensagem (miniatura, chaves, hashes) em Uint8Array, que vira {"0":12,"1":34,...} no JSON: cada byte ocupa
//   ~10 bytes. Uma miniatura de 60 KB já passa de 600 KiB; uma resposta a uma imagem traz a miniatura da citada.
//   Acima do limite: 200 e um log só com o tamanho (sem conteúdo). Com 413 o Evolution repete o mesmo corpo
//   até 10 vezes (só não repete 400/401/403/404/422), sem chance de passar.
// Rate limit próprio (todos os eventos vêm do mesmo container). O corpo (apikey da instância, número,
// texto, nome) nunca vai para log: o handler de erro troca o corpo por "[raw-body-redacted]" em
// /webhooks/communications/*, e o log de mensagem traz só códigos e contagens. Falha ao gravar mensagem:
// 503 sem detalhes, para o Evolution tentar de novo.
export const whatsappEvolutionWebhookRoutes = createAsyncRouter();

export const EVOLUTION_WEBHOOK_BODY_LIMIT = "4mb";

/** Corpos recusados pelo tamanho desde a subida do processo (vai no log de cada recusa). */
let droppedTooLarge = 0;

const declaredLength = (req: express.Request) => {
  const value = Number(req.get("content-length"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/**
 * Corpo acima do limite: o body-parser já descartou o corpo. Responde 200 (o Evolution desiste) e registra
 * só o motivo e os números. Qualquer outro erro segue para o handler padrão.
 */
const handleBodyTooLarge: express.ErrorRequestHandler = (error: unknown, req, res, next) => {
  if ((error as { type?: unknown } | null)?.type !== "entity.too.large") return next(error);
  droppedTooLarge += 1;
  const limitBytes = Number((error as { limit?: unknown }).limit);
  logApiEvent("WARN", "[whatsapp] webhook body too large", {
    reason: "body_too_large",
    bytes: declaredLength(req),
    limitBytes: Number.isFinite(limitBytes) ? limitBytes : null,
    droppedSinceBoot: droppedTooLarge
  });
  return res.status(200).json({ status: "too_large" });
};

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

// Depois da rota: o erro do body-parser chega aqui antes do handler padrão do app.
whatsappEvolutionWebhookRoutes.use(handleBodyTooLarge);
