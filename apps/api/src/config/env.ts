import dotenv from "dotenv";

dotenv.config();

function toBoolean(value: string | undefined, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalizedValue = value.trim().toLowerCase().replace(/^['\"]|['\"]$/g, "");
  return ["1", "true", "yes", "on"].includes(normalizedValue);
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
  enablePreviewSeed: toBoolean(process.env.ENABLE_PREVIEW_SEED, false),
  enableSmokeBootstrap: toBoolean(process.env.ENABLE_SMOKE_BOOTSTRAP, false),
  adminBootstrapEnabled: toBoolean(process.env.ADMIN_BOOTSTRAP_ENABLED, false),
  adminBootstrapName: process.env.ADMIN_BOOTSTRAP_NAME,
  adminBootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL,
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD,
  adminBootstrapRole: process.env.ADMIN_BOOTSTRAP_ROLE,
  adminBootstrapRegion: process.env.ADMIN_BOOTSTRAP_REGION,
  smokeDirectorEmail: process.env.SMOKE_DIRECTOR_EMAIL || "diretor@empresa.com",
  smokeDirectorPassword: process.env.SMOKE_DIRECTOR_PASSWORD || "123456",
  smokeSellerEmail: process.env.SMOKE_SELLER_EMAIL || "vendedor-smoke@empresa.com",
  cnpjLookupProvider: process.env.CNPJ_LOOKUP_PROVIDER || "",
  cnpjLookupBaseUrl: process.env.CNPJ_LOOKUP_BASE_URL || "",
  cnpjLookupApiKey: process.env.CNPJ_LOOKUP_API_KEY || "",
  openAiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openAiEnabled: toBoolean(process.env.OPENAI_ENABLED, false)
};
