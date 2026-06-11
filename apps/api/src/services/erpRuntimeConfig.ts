import { existsSync } from "node:fs";
import { env, PRODUCTION_ENV_FILE_PATH } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

export const ERP_PRODUCTION_ENV_FILE_PATH = PRODUCTION_ENV_FILE_PATH;

export const ERP_REQUIRED_ENV_VARS = [
  "ULTRAFV3_BASE_URL",
  "ERP_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export const ERP_DIAGNOSTIC_ENV_VARS = [
  "ULTRAFV3_BASE_URL",
  "ERP_CREDENTIAL_ENCRYPTION_KEY",
  "JWT_SECRET",
  "JWT_ACCESS_SECRET",
  "ACCESS_TOKEN_SECRET",
  "JWT_REFRESH_SECRET",
  "REFRESH_TOKEN_SECRET",
  "DATABASE_URL",
] as const;

export type ErpRequiredEnvVar = (typeof ERP_REQUIRED_ENV_VARS)[number];
export type ErpDiagnosticEnvVar = (typeof ERP_DIAGNOSTIC_ENV_VARS)[number];

export type ErpRuntimeEnvironmentDiagnostics = {
  externalEnvFile: {
    path: string;
    exists: boolean;
  };
  receivedEnv: Record<ErpDiagnosticEnvVar, boolean>;
  jwtSecretConfigured: boolean;
  missingDiagnosticConfig: ErpDiagnosticEnvVar[];
};

const hasReceivedEnvValue = (value: string | undefined) => Boolean(value?.trim());

export function getMissingErpRuntimeConfig(): ErpRequiredEnvVar[] {
  const missing: ErpRequiredEnvVar[] = [];
  if (!env.ultraFv3BaseUrl) missing.push("ULTRAFV3_BASE_URL");
  if (!env.erpCredentialEncryptionKey) missing.push("ERP_CREDENTIAL_ENCRYPTION_KEY");
  return missing;
}

export function getErpRuntimeEnvironmentDiagnostics(): ErpRuntimeEnvironmentDiagnostics {
  const jwtSecretConfigured = [
    process.env.JWT_SECRET,
    process.env.JWT_ACCESS_SECRET,
    process.env.ACCESS_TOKEN_SECRET,
    process.env.JWT_REFRESH_SECRET,
    process.env.REFRESH_TOKEN_SECRET,
  ].some(hasReceivedEnvValue);
  const receivedEnv: Record<ErpDiagnosticEnvVar, boolean> = {
    ULTRAFV3_BASE_URL: hasReceivedEnvValue(process.env.ULTRAFV3_BASE_URL),
    ERP_CREDENTIAL_ENCRYPTION_KEY: hasReceivedEnvValue(process.env.ERP_CREDENTIAL_ENCRYPTION_KEY),
    JWT_SECRET: jwtSecretConfigured,
    JWT_ACCESS_SECRET: hasReceivedEnvValue(process.env.JWT_ACCESS_SECRET),
    ACCESS_TOKEN_SECRET: hasReceivedEnvValue(process.env.ACCESS_TOKEN_SECRET),
    JWT_REFRESH_SECRET: hasReceivedEnvValue(process.env.JWT_REFRESH_SECRET),
    REFRESH_TOKEN_SECRET: hasReceivedEnvValue(process.env.REFRESH_TOKEN_SECRET),
    DATABASE_URL: hasReceivedEnvValue(process.env.DATABASE_URL),
  };

  return {
    externalEnvFile: {
      path: ERP_PRODUCTION_ENV_FILE_PATH,
      exists: existsSync(ERP_PRODUCTION_ENV_FILE_PATH),
    },
    receivedEnv,
    jwtSecretConfigured,
    missingDiagnosticConfig: ERP_DIAGNOSTIC_ENV_VARS.filter((key) => {
      if (key === "JWT_SECRET") return !jwtSecretConfigured;
      if (["JWT_ACCESS_SECRET", "ACCESS_TOKEN_SECRET", "JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"].includes(key)) return false;
      return !receivedEnv[key];
    }),
  };
}

export function validateErpRuntimeConfigOnStartup() {
  const missingConfig = getMissingErpRuntimeConfig();
  const environment = getErpRuntimeEnvironmentDiagnostics();
  if (!missingConfig.length) {
    logApiEvent("INFO", "[erp config] Configuração preventiva ERP validada", {
      requiredConfig: ERP_REQUIRED_ENV_VARS,
      externalEnvFile: environment.externalEnvFile,
      receivedEnv: environment.receivedEnv,
    });
    return { ok: true, missingConfig, environment };
  }

  logApiEvent("ERROR", "[erp config] Variáveis obrigatórias ausentes; envios ERP bloqueados", {
    missingConfig,
    externalEnvFile: environment.externalEnvFile,
    receivedEnv: environment.receivedEnv,
    message: `Configure ${missingConfig.join(", ")} no ambiente da API e reinicie o serviço.`,
  });
  return { ok: false, missingConfig, environment };
}

export function assertErpRuntimeConfigForOrderSubmission() {
  const missingConfig = getMissingErpRuntimeConfig();
  if (!env.isProduction && !missingConfig.length) return;
  if (!env.isProduction || !missingConfig.length) return;

  throw Object.assign(
    new Error(
      `Envio de pedidos ERP bloqueado por configuração de produção ausente: ${missingConfig.join(", ")}.`,
    ),
    {
      status: 503,
      missingConfig,
      code: "erp_missing_runtime_config",
    },
  );
}
