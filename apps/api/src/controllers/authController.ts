import { Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { verifyPassword } from "../utils/password.js";
import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

const cookieConfig = { httpOnly: true, sameSite: "lax" as const, secure: env.isProduction, maxAge: 7 * 24 * 60 * 60 * 1000 };
const LOGIN_TIMEOUT = 3000;

function withTimeout<T>(promise: Promise<T>, timeoutError: string, timeoutMs = LOGIN_TIMEOUT): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    }),
  ]);
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  let timedOut = false;

  try {
    console.log("LOGIN START");
    console.log("LOGIN_EMAIL:", email);
    logApiEvent("INFO", "LOGIN_START", { email });

    const loginLogic = async () => {
      console.log("BEFORE DB QUERY");
      logApiEvent("INFO", "BEFORE_DB", { email });
      const user = await withTimeout(prisma.user.findUnique({ where: { email } }), "LOGIN_DB_TIMEOUT");
      logApiEvent("INFO", "AFTER_DB", { email, userFound: Boolean(user) });
      console.log("USER FOUND:", user);

      if (timedOut || res.headersSent) return;
      if (!user) {
        console.log("USER NOT FOUND");
        return res.status(401).json({ message: "Credenciais inválidas" });
      }
      if (!user.isActive) return res.status(403).json({ message: "Usuário inativo" });

      logApiEvent("INFO", "BEFORE_BCRYPT", { email, userId: user.id });
      console.log("BEFORE PASSWORD CHECK");
      const isValid = await withTimeout(verifyPassword(password, user.passwordHash), "LOGIN_BCRYPT_TIMEOUT");
      console.log("PASSWORD VALID:", isValid);

      if (timedOut || res.headersSent) return;
      if (!isValid) return res.status(401).json({ message: "Credenciais inválidas" });

      const payload = { id: user.id, email: user.email, role: user.role, region: user.region };
      const accessToken = signAccessToken(payload);
      const refreshToken = signRefreshToken(payload);
      res.cookie("refreshToken", refreshToken, cookieConfig);
      logApiEvent("INFO", "SUCCESS", { email, userId: user.id });
      return res.json({ accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, region: user.region } });
    };

    await Promise.race([
      loginLogic(),
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("LOGIN_TIMEOUT"));
        }, LOGIN_TIMEOUT),
      ),
    ]);
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    logApiEvent("ERROR", "LOGIN_RUNTIME_ERROR", {
      email,
      error: error instanceof Error ? error.message : "UNKNOWN_LOGIN_ERROR",
    });

    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : "UNKNOWN_LOGIN_ERROR";
      return res.status(500).json({ error: message });
    }
  }
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
