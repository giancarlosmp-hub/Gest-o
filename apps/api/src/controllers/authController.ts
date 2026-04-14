import { Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { verifyPassword } from "../utils/password.js";
import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

const cookieConfig = { httpOnly: true, sameSite: "lax" as const, secure: env.isProduction, maxAge: 7 * 24 * 60 * 60 * 1000 };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`LOGIN_DB_TIMEOUT after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;
  const requestId = req.requestId ?? "unknown";

  logApiEvent("INFO", "[auth/login] request start", {
    requestId,
    endpoint: req.originalUrl,
    email
  });

  try {
    console.log("LOGIN: before db query");
    logApiEvent("INFO", "[auth/login] before db query", { requestId, email });
    const user = await withTimeout(prisma.user.findUnique({ where: { email } }), 3000);
    console.log("LOGIN: after db query");
    logApiEvent("INFO", "[auth/login] after db query", {
      requestId,
      userFound: Boolean(user),
      userId: user?.id ?? null
    });

    if (!user) {
      logApiEvent("WARN", "[auth/login] invalid credentials: user not found", { requestId, email });
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    if (!user.isActive) {
      logApiEvent("WARN", "[auth/login] inactive user", { requestId, userId: user.id, email: user.email });
      return res.status(403).json({ message: "Usuário inativo" });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      logApiEvent("WARN", "[auth/login] invalid credentials: password mismatch", { requestId, userId: user.id });
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    logApiEvent("INFO", "[auth/login] before token generation", { requestId, userId: user.id });
    const payload = { id: user.id, email: user.email, role: user.role, region: user.region };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.cookie("refreshToken", refreshToken, cookieConfig);

    logApiEvent("INFO", "[auth/login] response success", {
      requestId,
      userId: user.id,
      email: user.email,
      role: user.role
    });

    return res.json({ accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, region: user.region } });
  } catch (error) {
    logApiEvent("ERROR", "[auth/login] failed", {
      requestId,
      endpoint: req.originalUrl,
      email,
      stack: error instanceof Error ? error.stack : String(error)
    });

    const isDbTimeout = error instanceof Error && error.message.includes("LOGIN_DB_TIMEOUT");

    return res.status(503).json({
      message: isDbTimeout ? "Timeout ao consultar banco no login" : "Falha ao processar login no momento",
      code: isDbTimeout ? "LOGIN_DB_TIMEOUT" : "LOGIN_RUNTIME_ERROR"
    });
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
