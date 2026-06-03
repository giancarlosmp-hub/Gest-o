import { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../utils/jwt.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({
    message: "Não autenticado",
    ...(req.correlationId ? { correlationId: req.correlationId } : {}),
  });
  try {
    const decoded = verifyAccessToken(header.slice(7)) as Express.UserPayload;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      message: "Token inválido",
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
  }
}
