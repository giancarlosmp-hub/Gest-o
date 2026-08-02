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
  const startedAt = Date.now();
  let timedOut = false;
  const sendLoginResponse = (status: number, body: Record<string, unknown>) => {
    return res.status(status).json(body);
  };

  const logLogin = (event: "auth_login_success" | "auth_login_failure", status: number, reason: "authenticated" | "invalid_credentials" | "internal_error") => {
    logApiEvent(status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO", event, {
      requestId: req.requestId,
      reason,
      status,
      durationMs: Date.now() - startedAt,
    });
  };

  try {
    const loginLogic = async () => {
      const user = await withTimeout(prisma.user.findUnique({ where: { email } }), "LOGIN_DB_TIMEOUT");

      if (timedOut || res.headersSent) return;
      if (!user || !user.isActive) {
        logLogin("auth_login_failure", 401, "invalid_credentials");
        return sendLoginResponse(401, { message: "Credenciais inválidas" });
      }

      const ok = await withTimeout(verifyPassword(password, user.passwordHash), "LOGIN_BCRYPT_TIMEOUT");

      if (timedOut || res.headersSent) return;
      if (!ok) {
        logLogin("auth_login_failure", 401, "invalid_credentials");
        return sendLoginResponse(401, { message: "Credenciais inválidas" });
      }

      const payload = { id: user.id, email: user.email, role: user.role, region: user.region };
      const accessToken = signAccessToken(payload);
      const refreshToken = signRefreshToken(payload);
      res.cookie("refreshToken", refreshToken, cookieConfig);
      logLogin("auth_login_success", 200, "authenticated");
      return sendLoginResponse(200, { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, region: user.region } });
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
    logLogin("auth_login_failure", 503, "internal_error");

    if (!res.headersSent) {
      return sendLoginResponse(503, { message: "LOGIN_RUNTIME_ERROR" });
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
