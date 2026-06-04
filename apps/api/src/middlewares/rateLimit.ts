import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";
import { buildControlledErpOrderFailurePayload, isErpOrderEndpointPath } from "../utils/erpOrderFailureResponse.js";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const isProduction = env.isProduction;

const createRateLimiter = (name: string, productionLimit: number, developmentLimit = 5_000) =>
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: isProduction ? productionLimit : developmentLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const details = req.rateLimit;
      const userId = req.user?.id ?? "anonymous";

      logApiEvent("WARN", "[rate-limit] 429", {
        requestId: req.requestId,
        limiter: name,
        route: req.originalUrl,
        ip: req.ip,
        userId,
        current: details?.used,
        limit: details?.limit,
        remaining: details?.remaining,
      });

      if (isErpOrderEndpointPath(req.method, req.path)) {
        req.erpOrderFailureStage = "rate-limit";
        res.status(429).json(buildControlledErpOrderFailurePayload({
          status: 429,
          etapa: "rate-limit",
          message: "Muitas requisições. Tente novamente em instantes.",
          correlationId: req.correlationId,
        }));
        return;
      }

      res.status(429).json({
        message: "Muitas requisições. Tente novamente em instantes.",
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
    },
  });

export const authLoginRateLimit = createRateLimiter("auth-login", 40, 500);
export const authRefreshRateLimit = createRateLimiter("auth-refresh", 60, 1_000);
export const appUsageRateLimit = createRateLimiter("app-usage", 2_000, 10_000);
