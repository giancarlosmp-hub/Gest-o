import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/authRoutes.js";
import clientLookupRoutes from "./routes/clientLookupRoutes.js";
import crudRoutes from "./routes/crudRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { env } from "./config/env.js";
import { requestContextMiddleware } from "./middlewares/requestLogging.js";
import { logApiEvent, sanitizePayload } from "./utils/logger.js";
import { appUsageRateLimit, authLoginRateLimit, authRefreshRateLimit } from "./middlewares/rateLimit.js";

export const app = express();

if (env.isProduction) {
  app.set("trust proxy", 1);
}

let _tcCache: { data: object; expiresAt: number } | null = null;

app.use(helmet());

const allowedOrigins = env.corsAllowedOrigins
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(requestContextMiddleware);
app.use((req, res, next) => {
  req.setTimeout(env.apiRequestTimeoutMs);
  res.setTimeout(env.apiRequestTimeoutMs, () => {
    if (!res.headersSent) {
      res.status(408).json({ message: "Request timeout" });
    }
  });
  next();
});

app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: env.appVersion,
  });
});

app.get("/debug", (_req, res) => {
  res.status(200).json({
    status: "ok",
    time: new Date(),
  });
});

app.get("/debug/admin", async (_req, res) => {
  const { prisma } = await import("./config/prisma.js");
  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const debugEmails = bootstrapEmail
    ? [bootstrapEmail, "admin@preview.local", "admin@preview.com"]
    : ["admin@preview.local", "admin@preview.com"];
  const admin = await prisma.user.findFirst({
    where: { email: { in: debugEmails } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, isActive: true, createdAt: true, passwordHash: true },
  });

  return res.status(200).json({
    id: admin?.id ?? null,
    email: admin?.email ?? null,
    role: admin?.role ?? null,
    isActive: admin?.isActive ?? null,
    createdAt: admin?.createdAt ?? null,
    passwordHashPrefix: admin?.passwordHash ? admin.passwordHash.slice(0, 12) : null,
  });
});

app.use(["/auth/login", "/api/auth/login"], authLoginRateLimit);
app.use(["/auth/refresh", "/api/auth/refresh"], authRefreshRateLimit);
app.use(["/auth/me", "/api/auth/me", "/auth/logout", "/api/auth/logout"], appUsageRateLimit);
app.use("/technical-cultures", appUsageRateLimit);

app.get("/technical-cultures", async (_req, res) => {
  try {
    if (_tcCache && _tcCache.expiresAt > Date.now()) {
      return res.status(200).json(_tcCache.data);
    }

    const { prisma } = await import("./config/prisma.js");
    const items = await prisma.cultureCatalog.findMany({
      where: { isActive: true },
      orderBy: [{ label: "asc" }],
      take: 50,
      select: { slug: true, label: true, category: true },
    });

    const payload = { data: items, source: "db" };
    _tcCache = { data: payload, expiresAt: Date.now() + 60_000 };

    return res.status(200).json(payload);
  } catch (err) {
    logApiEvent("ERROR", "[technical-cultures] fallback", {
      requestId: _req.requestId,
      endpoint: _req.originalUrl,
      user: _req.user ? { id: _req.user.id, email: _req.user.email, role: _req.user.role } : null,
      stack: err instanceof Error ? err.stack : String(err),
    });
    return res.status(200).json({ data: [], source: "fallback" });
  }
});
app.use("/auth", authRoutes);
app.use("/api/auth", authRoutes);


app.use("/dashboard", dashboardRoutes);
app.use("/", clientLookupRoutes);
app.use("/", crudRoutes);

// Compatibilidade retroativa para ambientes que passaram a consumir a API com prefixo /api.
app.use("/api/dashboard", dashboardRoutes);
app.use("/api", clientLookupRoutes);
app.use("/api", crudRoutes);

logApiEvent("INFO", "[boot] cnpj lookup route registered", {
  routes: ["/clients/cnpj-lookup/:cnpj", "/api/clients/cnpj-lookup/:cnpj"],
  source: "clientLookupRoutes"
});

app.use((err: any, req: any, res: any, next: any) => {
  logApiEvent("ERROR", "[express error] Internal server error", {
    requestId: req.requestId,
    endpoint: req.originalUrl,
    method: req.method,
    payload: sanitizePayload({ body: req.body, params: req.params, query: req.query }),
    user: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role } : null,
    stack: err instanceof Error ? err.stack : String(err),
  });

  if (res.headersSent) return next(err);
  res.status(500).json({ message: "Internal server error" });
});
