import { prisma as defaultPrisma } from "../../config/prisma.js";
import { isWhatsAppEvolutionConfigured, isWhatsAppMessagesEnabled } from "../whatsappConnection/config.js";

// WhatsApp Fase C: envio pelo CRM ligado ou desligado, no AppConfig (sem migration, sem variável de ambiente).
// Desligado por padrão; só o diretor muda (rota). Também exige a gravação das conversas ligada (Fase B) e o
// Evolution configurado: sem isso, o envio fica indisponível mesmo com a chave ligada.

export const CRM_SEND_CONFIG_KEY = "whatsappCrmSend.config";

export type CrmSendConfig = { enabled: boolean };
export const DEFAULT_CRM_SEND_CONFIG: CrmSendConfig = { enabled: false };

export function parseCrmSendConfig(value: string | null | undefined): CrmSendConfig {
  if (!value) return DEFAULT_CRM_SEND_CONFIG;
  try {
    const parsed = JSON.parse(value);
    return { enabled: parsed?.enabled === true };
  } catch {
    return DEFAULT_CRM_SEND_CONFIG;
  }
}

type ConfigDb = Pick<typeof defaultPrisma, "appConfig">;

export async function loadCrmSendConfig(db: ConfigDb = defaultPrisma): Promise<CrmSendConfig> {
  const row = await db.appConfig.findUnique({ where: { key: CRM_SEND_CONFIG_KEY }, select: { value: true } });
  return parseCrmSendConfig(row?.value);
}

export async function saveCrmSendConfig(config: CrmSendConfig, db: ConfigDb = defaultPrisma): Promise<CrmSendConfig> {
  const value = JSON.stringify({ enabled: config.enabled === true });
  const row = await db.appConfig.upsert({ where: { key: CRM_SEND_CONFIG_KEY }, update: { value }, create: { key: CRM_SEND_CONFIG_KEY, value }, select: { value: true } });
  return parseCrmSendConfig(row.value);
}

/** Infraestrutura pronta para enviar: gravação das conversas ligada e Evolution configurado. */
export const isCrmSendAvailable = () => isWhatsAppMessagesEnabled() && isWhatsAppEvolutionConfigured();
