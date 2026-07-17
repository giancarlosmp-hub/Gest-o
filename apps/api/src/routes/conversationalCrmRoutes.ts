import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { conversationalCrmService } from "../services/conversationalCrmService.js";
import { logApiEvent } from "../utils/logger.js";

const router = Router();
router.use(authMiddleware);
router.use(appUsageRateLimit);

router.post("/crm-assistant/query", async (req, res) => {
  try {
    const response = await conversationalCrmService.query(req.body, req.user!);
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
      message: status === 500 ? "Não consegui responder agora. Tente novamente em instantes." : error instanceof Error ? error.message : "Pergunta inválida.",
      warnings: status === 500 ? ["Falha controlada sem expor detalhes internos."] : undefined
    });
  }
});

export default router;
