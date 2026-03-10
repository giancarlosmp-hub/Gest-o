import { NextFunction, Request, Response } from "express";
import { createRequestId, getLogLevelFromStatus, logApiEvent } from "../utils/logger.js";

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = createRequestId();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const level = getLogLevelFromStatus(statusCode);

    logApiEvent(level, `[API] ${requestId} ${req.method} ${req.originalUrl} ${statusCode} (${Math.round(durationMs)}ms)`, {
      requestId,
      method: req.method,
      endpoint: req.originalUrl,
      statusCode,
      responseTimeMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
};
