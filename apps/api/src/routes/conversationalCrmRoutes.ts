import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { conversationalCrmService } from "../services/conversationalCrmService.js";
import { opportunityDraftService } from "../services/opportunityDraftService.js";
import { resolveUniqueActiveTenantForUser } from "../services/ultraFv3SyncService.js";
import { runAiFlow } from "../services/ai/aiTimeBudget.js";
import { sellerWhere } from "../utils/access.js";
import { logApiEvent } from "../utils/logger.js";

const router = Router();
router.use(authMiddleware);
router.use(appUsageRateLimit);

router.post("/crm-assistant/query", async (req, res) => {
  try {
    const response = await runAiFlow("crm-assistant", () => conversationalCrmService.query(req.body, req.user!), (value) => value.source);
    return res.status(200).json(response);
  } catch (error) {
    const status = typeof (error as any)?.statusCode === "number" ? (error as any).statusCode : error instanceof z.ZodError ? 400 : 500;
    logApiEvent(status >= 500 ? "ERROR" : "WARN", status >= 500 ? "[crm-assistant] failed" : "[crm-assistant] rejected", {
      viewerRole: req.user?.role,
      elapsedMs: 0,
      filterCount: 0,
      error: error instanceof z.ZodError ? "validation" : error instanceof Error ? error.name : "unknown"
    });
    return res.status(status).json({
      message: status === 500 ? "Não foi possível responder agora. Tente de novo." : error instanceof Error ? error.message : "Pergunta inválida."
    });
  }
});

// Rascunho de oportunidade a partir da frase ditada: só interpreta e devolve candidatos, preços e avisos; não grava.
router.post("/crm-assistant/opportunity-draft/parse", async (req, res) => {
  try {
    const tenantId = await resolveUniqueActiveTenantForUser(req.user!.id).catch((error) => {
      if ((error as { status?: number })?.status === 403) return null;
      throw error;
    });
    if (!tenantId) return res.status(403).json({ message: "Contexto de tenant ausente ou ambíguo." });
    const viewer = { id: req.user!.id, role: req.user!.role };
    const draft = await runAiFlow("opportunity-draft", () => opportunityDraftService.parse(req.body, viewer, { tenantId, clientScope: sellerWhere(req) }), (value) => value.source);
    return res.status(200).json(draft);
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    logApiEvent(status >= 500 ? "ERROR" : "WARN", status >= 500 ? "[opportunity-draft] failed" : "[opportunity-draft] rejected", {
      viewerRole: req.user?.role,
      error: error instanceof z.ZodError ? "validation" : error instanceof Error ? error.name : "unknown"
    });
    return res.status(status).json({ message: status === 500 ? "Não foi possível interpretar agora. Tente de novo." : "Frase inválida: envie o texto com 3 a 1000 caracteres." });
  }
});

export default router;
