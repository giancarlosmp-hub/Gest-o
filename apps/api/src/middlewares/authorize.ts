import { NextFunction, Request, Response } from "express";
import { Role } from "@salesforce-pro/shared";

export const authorize = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ message: "Não autenticado" });
  if (!roles.includes(req.user.role as Role)) return res.status(403).json({ message: "Sem permissão" });
  next();
};
