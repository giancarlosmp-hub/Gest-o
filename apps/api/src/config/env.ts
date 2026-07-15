import dotenv from "dotenv";

export const PRODUCTION_ENV_FILE_PATH = "/root/demetra-env/.env";

// Load the production file first so it is the preferred source when present.
// dotenv does not override already-loaded keys by default, preserving shell-provided
// variables and keeping local .env compatibility when the external file is absent.
dotenv.config({ path: PRODUCTION_ENV_FILE_PATH });
dotenv.config();

function cleanEnvString(value: string | undefined, defaultValue = "") {
  if (value == null) return defaultValue;
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

function toBoolean(value: string | undefined, defaultValue = false) {
  const normalizedValue = cleanEnvString(value).toLowerCase();
  if (!normalizedValue) return defaultValue;
  return ["1", "true", "yes", "on"].includes(normalizedValue);
}

function toNumber(value: string | undefined, defaultValue: number) {
  const parsed = Number(cleanEnvString(value));
  return Number.isFinite(parsed) ? parsed : defaultValue;
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
  apiRequestTimeoutMs: toNumber(process.env.API_REQUEST_TIMEOUT_MS, 15_000),
  erpOrderRequestTimeoutMs: toNumber(process.env.ERP_ORDER_REQUEST_TIMEOUT_MS, 50_000),
  jwtSecret: cleanEnvString(process.env.JWT_SECRET),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || "access-secret",
  jwtAccessExpiresIn: cleanEnvString(process.env.JWT_ACCESS_EXPIRES_IN, "12h"),
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "refresh-secret",
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
  aiProvider: cleanEnvString(process.env.AI_PROVIDER),
  aiChatEnabled: toBoolean(process.env.AI_CHAT_ENABLED, false),
  aiBaseUrl: cleanEnvString(process.env.AI_BASE_URL),
  aiApiKey: cleanEnvString(process.env.AI_API_KEY),
  aiModel: cleanEnvString(process.env.AI_MODEL),
  aiTimeoutMs: toNumber(process.env.AI_TIMEOUT_MS, 30_000),
  aiMaxOutputTokens: toNumber(process.env.AI_MAX_OUTPUT_TOKENS, 512),
  aiTemperature: toNumber(process.env.AI_TEMPERATURE, 0.4),
  ollamaBaseUrl: cleanEnvString(process.env.OLLAMA_BASE_URL, "http://localhost:11434"),
  ollamaModel: cleanEnvString(process.env.OLLAMA_MODEL, "qwen2.5:3b"),
  ultraFv3BaseUrl: cleanEnvString(process.env.ULTRAFV3_BASE_URL),
  ultraFv3Username: cleanEnvString(process.env.ULTRAFV3_USERNAME),
  ultraFv3Password: cleanEnvString(process.env.ULTRAFV3_PASSWORD),
  erpCredentialEncryptionKey: cleanEnvString(process.env.ERP_CREDENTIAL_ENCRYPTION_KEY),
  erpSyncSchedulerEnabled: toBoolean(process.env.ERP_SYNC_SCHEDULER_ENABLED, (process.env.NODE_ENV || "development") === "production"),
  erpSyncProductsIntervalMs: toNumber(process.env.ERP_SYNC_PRODUCTS_INTERVAL_MS, 6 * 60 * 60 * 1000),
  erpSyncPartnersIntervalMs: toNumber(process.env.ERP_SYNC_PARTNERS_INTERVAL_MS, 6 * 60 * 60 * 1000),
  erpSyncOrderStatusIntervalMs: toNumber(process.env.ERP_SYNC_ORDER_STATUS_INTERVAL_MS, 15 * 60 * 1000),
  erpSyncHealthcheckIntervalMs: toNumber(process.env.ERP_SYNC_HEALTHCHECK_INTERVAL_MS, 5 * 60 * 1000),
  ultraFv3ProtocolInvestigationEnabled: toBoolean(process.env.ULTRAFV3_PROTOCOL_INVESTIGATION_ENABLED, false),
  ultraFv3ProtocolInvestigationBodyMaxChars: toNumber(process.env.ULTRAFV3_PROTOCOL_INVESTIGATION_BODY_MAX_CHARS, 200_000)
};
