import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";

const cookieConfig = { httpOnly: true, sameSite: "lax" as const, secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 };

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ message: "Credenciais inválidas" });
  if (!user.isActive) return res.status(403).json({ message: "Usuário inativo" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Credenciais inválidas" });
  const payload = { id: user.id, email: user.email, role: user.role, region: user.region };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  res.cookie("refreshToken", refreshToken, cookieConfig);
  return res.json({ accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, region: user.region } });
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: "Refresh token ausente" });
  try {
    const payload = verifyRefreshToken(token) as Express.UserPayload;
    const accessToken = signAccessToken(payload);
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ message: "Refresh token inválido" });
  }
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ message: "Não autenticado" });
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true, region: true, isActive: true } });
  return res.json(user);
}

export function logout(_req: Request, res: Response) {
  res.clearCookie("refreshToken");
  return res.json({ message: "Logout realizado" });
}
