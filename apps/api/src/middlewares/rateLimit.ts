import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

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

      res.status(429).json({ message: "Muitas requisições. Tente novamente em instantes." });
    },
  });

export const authLoginRateLimit = createRateLimiter("auth-login", 40, 500);
export const authRefreshRateLimit = createRateLimiter("auth-refresh", 60, 1_000);
export const appUsageRateLimit = createRateLimiter("app-usage", 2_000, 10_000);
