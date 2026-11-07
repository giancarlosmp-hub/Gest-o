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

/** Fase A: só os eventos de conexão chegam ao CRM. */
export const EVOLUTION_WEBHOOK_EVENTS = ["CONNECTION_UPDATE"] as const;

/**
 * Fase B: conexão e mensagens (nova, editada, apagada). Fora de propósito: MESSAGES_UPDATE (entrega e
 * leitura), MESSAGES_SET (histórico), contatos, chats, grupos e presença.
 */
export const EVOLUTION_MESSAGE_WEBHOOK_EVENTS = ["CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_EDITED", "MESSAGES_DELETE"] as const;

export const isWhatsAppEvolutionEnabled = () => env.communicationsEnabled && env.whatsappEvolutionEnabled;

/** Gravação das conversas: exige a Fase A ligada e a flag própria. */
export const isWhatsAppMessagesEnabled = () => isWhatsAppEvolutionEnabled() && env.whatsappEvolutionMessagesEnabled;

/**
 * Lista de eventos do webhook de cada instância, conforme as flags. Sempre explícita e nunca vazia: no
 * Evolution, "enabled" com lista vazia assina todos os eventos.
 */
export const evolutionWebhookEvents = (): readonly string[] =>
  isWhatsAppMessagesEnabled() ? EVOLUTION_MESSAGE_WEBHOOK_EVENTS : EVOLUTION_WEBHOOK_EVENTS;

/** Transcrição dos áudios: exige a gravação das conversas ligada, a flag própria e a chave do provedor. */
export const isWhatsAppTranscriptionEnabled = () =>
  isWhatsAppMessagesEnabled() && env.whatsappTranscriptionEnabled && Boolean(env.whatsappTranscriptionApiKey && env.whatsappTranscriptionBaseUrl);

export const isWhatsAppEvolutionConfigured = () =>
  Boolean(env.whatsappEvolutionBaseUrl && env.whatsappEvolutionApiKey && env.whatsappEvolutionWebhookSecret);
