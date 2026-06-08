import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

export const ERP_REQUIRED_ENV_VARS = [
  "ULTRAFV3_BASE_URL",
  "ERP_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export type ErpRequiredEnvVar = (typeof ERP_REQUIRED_ENV_VARS)[number];

export function getMissingErpRuntimeConfig(): ErpRequiredEnvVar[] {
  const missing: ErpRequiredEnvVar[] = [];
  if (!env.ultraFv3BaseUrl) missing.push("ULTRAFV3_BASE_URL");
  if (!env.erpCredentialEncryptionKey) missing.push("ERP_CREDENTIAL_ENCRYPTION_KEY");
  return missing;
}

export function validateErpRuntimeConfigOnStartup() {
  const missingConfig = getMissingErpRuntimeConfig();
  if (!missingConfig.length) {
    logApiEvent("INFO", "[erp config] Configuração preventiva ERP validada", {
      requiredConfig: ERP_REQUIRED_ENV_VARS,
    });
    return { ok: true, missingConfig };
  }

  logApiEvent("ERROR", "[erp config] Variáveis obrigatórias ausentes; envios ERP bloqueados", {
    missingConfig,
    message: `Configure ${missingConfig.join(", ")} no ambiente da API e reinicie o serviço.`,
  });
  return { ok: false, missingConfig };
}

export function assertErpRuntimeConfigForOrderSubmission() {
  const missingConfig = getMissingErpRuntimeConfig();
  if (!missingConfig.length) return;

  throw Object.assign(
    new Error(
      `Envio de pedidos ERP bloqueado por configuração ausente: ${missingConfig.join(", ")}.`,
    ),
    {
      status: 503,
      missingConfig,
      code: "erp_missing_runtime_config",
    },
  );
}
