import { env } from "../../config/env.js";

// WhatsApp Fase A: conexão do número de cada usuário por QR, via Evolution API (docker-compose.whatsapp.yml).

/** Header com o segredo que o Evolution manda em cada evento do webhook interno. */
export const EVOLUTION_WEBHOOK_SECRET_HEADER = "x-crm-webhook-secret";

/**
 * Alias interno da API na rede gest-o_default (docker-compose.production.yml). O Evolution avisa a API por
 * esse nome, dentro da rede Docker; nunca pelo domínio público.
 */
export const CRM_API_INTERNAL_ALIAS = "crm-api-internal";
export const EVOLUTION_WEBHOOK_PATH = "/webhooks/communications/evolution";
export const EVOLUTION_WEBHOOK_URL = `http://${CRM_API_INTERNAL_ALIAS}:4000${EVOLUTION_WEBHOOK_PATH}`;

/** Só os eventos de conexão chegam ao CRM: nenhuma mensagem, contato ou chat. */
export const EVOLUTION_WEBHOOK_EVENTS = ["CONNECTION_UPDATE"] as const;

export const isWhatsAppEvolutionEnabled = () => env.communicationsEnabled && env.whatsappEvolutionEnabled;

export const isWhatsAppEvolutionConfigured = () =>
  Boolean(env.whatsappEvolutionBaseUrl && env.whatsappEvolutionApiKey && env.whatsappEvolutionWebhookSecret);
