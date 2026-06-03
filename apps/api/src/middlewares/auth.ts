import { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../utils/jwt.js";
import { buildControlledErpOrderFailurePayload, isErpOrderEndpointPath } from "../utils/erpOrderFailureResponse.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const erpOrderRequest = isErpOrderEndpointPath(req.method, req.path);
  if (!header?.startsWith("Bearer ")) {
    if (erpOrderRequest) {
      req.erpOrderFailureStage = "auth";
      return res.status(401).json(buildControlledErpOrderFailurePayload({
        status: 401,
        etapa: "auth",
        message: "Não autenticado",
        correlationId: req.correlationId,
      }));
    }
    return res.status(401).json({
      message: "Não autenticado",
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
  }
  try {
    const decoded = verifyAccessToken(header.slice(7)) as Express.UserPayload;
    req.user = decoded;
    next();
  } catch {
    if (erpOrderRequest) {
      req.erpOrderFailureStage = "auth";
      return res.status(401).json(buildControlledErpOrderFailurePayload({
        status: 401,
        etapa: "auth",
        message: "Token inválido",
        correlationId: req.correlationId,
      }));
    }
    return res.status(401).json({
      message: "Token inválido",
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
  }
}
