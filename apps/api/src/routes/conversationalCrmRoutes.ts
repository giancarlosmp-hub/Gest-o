import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.js";
import { appUsageRateLimit } from "../middlewares/rateLimit.js";
import { conversationalCrmService } from "../services/conversationalCrmService.js";
import { runAiFlow } from "../services/ai/aiTimeBudget.js";
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

export default router;
