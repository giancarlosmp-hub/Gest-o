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

const isDev = process.env.NODE_ENV !== "production";

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isDev ? 5000 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Muitas requisições. Tente novamente em alguns minutos." }
});

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isDev ? 200 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Muitas tentativas de login. Aguarde e tente novamente." }
});

app.use(helmet());
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(generalLimiter);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

app.get("/", (_req, res) => res.status(200).json({ status: "ok", service: "salesforce-pro-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth/login", authLoginLimiter);
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/", crudRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Erro interno" });
});
