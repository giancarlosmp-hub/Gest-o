import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/authRoutes.js";
import clientLookupRoutes from "./routes/clientLookupRoutes.js";
import crudRoutes from "./routes/crudRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { env } from "./config/env.js";
import { requestContextMiddleware } from "./middlewares/requestLogging.js";
import { logApiEvent, sanitizePayload } from "./utils/logger.js";

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
const isProduction = env.isProduction;

const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 200 : 5_000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  handler: (req, res) => {
    const details = req.rateLimit;
    const userId = req.user?.id ?? "anonymous";

    logApiEvent("WARN", "[rate-limit] 429", {
      requestId: req.requestId,
      route: req.originalUrl,
      ip: req.ip,
      userId,
      current: details?.used,
      limit: details?.limit,
      remaining: details?.remaining,
    });

    res.status(429).json({ message: "Muitas requisições. Tente novamente em instantes." });
  },
});

app.use(requestContextMiddleware);
app.use(apiRateLimit);
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
app.use("/dashboard", dashboardRoutes);
app.use("/", clientLookupRoutes);
app.use("/", crudRoutes);

// Compatibilidade retroativa para ambientes que passaram a consumir a API com prefixo /api.
app.use("/api/auth", authRoutes);
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
