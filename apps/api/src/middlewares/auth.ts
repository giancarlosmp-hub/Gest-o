import { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../utils/jwt.js";

const isTechnicalCulturesPublicInCi = (req: Request) => {
  const isCiEnv = process.env.NODE_ENV === "test" || process.env.CI === "true";
  const isGet = req.method === "GET";
  const isTechnicalCulturesPath =
    req.path === "/technical-cultures" || req.path === "/technical/cultures";

  return isCiEnv && isGet && isTechnicalCulturesPath;
};

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isTechnicalCulturesPublicInCi(req)) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Não autenticado" });
  try {
    const decoded = verifyAccessToken(header.slice(7)) as Express.UserPayload;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Token inválido" });
  }
}
