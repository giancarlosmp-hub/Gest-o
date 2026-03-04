import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import authRoutes from "./routes/authRoutes.js";
import crudRoutes from "./routes/crudRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import cultureRoutes from "./routes/cultureRoutes.js";
import { env } from "./config/env.js";

export const app = express();

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

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/", cultureRoutes);
app.use("/", crudRoutes);

// Compatibilidade retroativa para ambientes que passaram a consumir a API com prefixo /api.
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api", cultureRoutes);
app.use("/api", crudRoutes);

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = typeof err === "object" && err !== null && "status" in err && Number.isInteger((err as { status?: number }).status)
    ? Math.max(400, Math.min(599, Number((err as { status?: number }).status)))
    : 500;

  const message =
    typeof err === "object" && err !== null && "message" in err && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "Erro interno";

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  } else {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  res.status(status).json({ message: status >= 500 ? "Erro interno" : message });
});
