import dotenv from "dotenv";

dotenv.config();

function toBoolean(value: string | undefined, defaultValue = false) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: (process.env.NODE_ENV || "development") === "production",
  port: Number(process.env.PORT || 4000),
  appVersion: process.env.APP_VERSION || process.env.npm_package_version || "1.0.0",
  corsAllowedOrigins:
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    ((process.env.NODE_ENV || "development") === "production" ? "" : "http://localhost:5173"),
  apiRequestTimeoutMs: Number(process.env.API_REQUEST_TIMEOUT_MS || 15_000),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "access-secret",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "refresh-secret",
  frontendUrl:
    process.env.FRONTEND_URL || ((process.env.NODE_ENV || "development") === "production" ? "" : "http://localhost:5173"),
  seedOnBootstrap: toBoolean(process.env.SEED_ON_BOOTSTRAP, false),
  enableSmokeBootstrap: toBoolean(process.env.ENABLE_SMOKE_BOOTSTRAP, false),
  smokeDirectorEmail: process.env.SMOKE_DIRECTOR_EMAIL || "diretor@empresa.com",
  smokeDirectorPassword: process.env.SMOKE_DIRECTOR_PASSWORD || "123456",
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/salesforce_pro?schema=public",
  smokeSellerEmail: process.env.SMOKE_SELLER_EMAIL || "vendedor-smoke@empresa.com"
};
