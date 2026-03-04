import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import authRoutes from "./routes/authRoutes.js";
import crudRoutes from "./routes/crudRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { env } from "./config/env.js";

export const app = express();

let _tcCache: { data: object; expiresAt: number } | null = null;

app.use(helmet());

const allowedOrigins = env.frontendUrl
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
const isProduction = process.env.NODE_ENV === "production";

const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 200 : 5_000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  handler: (req, res) => {
    const details = req.rateLimit;
    const userId = req.user?.id ?? "anonymous";

    if (!isProduction) {
      console.warn("[rate-limit] 429", {
        route: req.originalUrl,
        ip: req.ip,
        userId,
        current: details?.used,
        limit: details?.limit,
        remaining: details?.remaining,
      });
    } else {
      console.error("[rate-limit] 429", {
        route: req.originalUrl,
        ip: req.ip,
        userId,
        current: details?.used,
        limit: details?.limit,
        remaining: details?.remaining,
      });
    }

    res.status(429).json({ message: "Muitas requisições. Tente novamente em instantes." });
  },
});

app.use(apiRateLimit);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
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
    console.error("[technical-cultures]", err);
    return res.status(200).json({ data: [], source: "fallback" });
  }
});
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/", crudRoutes);

// Compatibilidade retroativa para ambientes que passaram a consumir a API com prefixo /api.
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api", crudRoutes);

app.use((err: any, _req: any, res: any, next: any) => {
  console.error("[express error]", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
