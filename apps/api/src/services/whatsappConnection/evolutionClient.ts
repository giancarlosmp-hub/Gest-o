import { env } from "../../config/env.js";
import { EVOLUTION_MESSAGE_WEBHOOK_EVENTS, EVOLUTION_WEBHOOK_SECRET_HEADER, EVOLUTION_WEBHOOK_URL, evolutionWebhookEvents } from "./config.js";
import { isCrmUserRecipient, type CrmUserRecipient } from "./crmUserRecipient.js";
import { isClientRecipient, type ClientRecipient } from "../whatsappConversations/clientRecipient.js";

// Cliente mínimo da Evolution API v2.3.7: criar instância (com QR), consultar estado, ler o número
// conectado, apagar a instância, (Fase B) ajustar os eventos do webhook da instância e baixar o áudio a
// transcrever e enviar texto. Há só dois envios, cada um com o próprio tipo de destino, emitido por um
// único módulo e recusado pelo outro método:
// - sendTextToCrmUser (Fase D, resumo diário): só o celular de um usuário ativo do CRM (crmUserRecipient.ts);
// - sendTextToClient (Fase C, conversa pelo CRM): só o telefone de um cliente, pelo número do próprio
//   remetente (whatsappConversations/clientRecipient.ts).
// Nunca um número solto. Nada aqui grava log: QR, chave, número, texto e mídia nunca passam pelo logger.

export class EvolutionUnavailableError extends Error {
  /** A conexão nem chegou a ser aberta (recusada, nome não resolvido): a requisição não saiu. */
  readonly connectRefused: boolean;

  constructor(readonly reason: string, options: { connectRefused?: boolean } = {}) {
    super(`Evolution API indisponível (${reason})`);
    this.name = "EvolutionUnavailableError";
    this.connectRefused = options.connectRefused ?? false;
  }
}

/**
 * Resultado de um envio:
 * - sent: o Evolution aceitou (2xx com id da mensagem);
 * - not_sent: certeza de que não saiu (retryable só quando a conexão nem abriu);
 * - uncertain: timeout, erro do servidor ou resposta desconhecida — pode ter saído; só o código é registrado.
 */
export type EvolutionSendResult =
  | { kind: "sent" }
  | { kind: "not_sent"; code: string; retryable: boolean }
  | { kind: "uncertain"; code: string };

/** Envio ao cliente (Fase C): o id devolvido pelo Evolution (key.id) casa a mensagem com o eco do webhook. */
export type EvolutionClientSendResult =
  | { kind: "sent"; messageId: string }
  | { kind: "not_sent"; code: string; retryable: boolean }
  | { kind: "uncertain"; code: string };

/** Limite do texto enviado (o resumo fica bem abaixo disso). */
export const MAX_SEND_TEXT_LENGTH = 8_000;

/** Envio ao cliente (Fase C): termina antes do timeout da requisição da API (15 s) para nunca responder 408 com o envio em curso. */
export const CLIENT_SEND_TIMEOUT_MS = 10_000;

const CONNECT_REFUSED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export type EvolutionConnectResult = { kind: "open" } | { kind: "qr"; qrDataUrl: string | null } | { kind: "not_found" };
export type EvolutionState = "open" | "connecting" | "close" | "not_found" | "unknown";

type EvolutionClientOptions = {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  timeoutMs?: number;
  /** Envio de texto: o Evolution espera o "digitando" (delay) antes de mandar. */
  sendTimeoutMs?: number;
  /** Envio ao cliente (Fase C): abaixo do timeout da requisição da API (15 s), para nunca responder antes do Evolution. */
  clientSendTimeoutMs?: number;
  /** A criação espera o QR (cerca de 5 s no Evolution). */
  createTimeoutMs?: number;
  /** Download de mídia (o Evolution tenta de novo depois de 5 s). */
  mediaTimeoutMs?: number;
};

const QR_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_QR_LENGTH = 60_000;

/** Só repassa um PNG em data URL de tamanho razoável; qualquer outra coisa vira null. */
export function pickQrDataUrl(value: unknown): string | null {
  const base64 = (value as { base64?: unknown } | null | undefined)?.base64;
  return typeof base64 === "string" && base64.length <= MAX_QR_LENGTH && QR_DATA_URL.test(base64) ? base64 : null;
}

const ALLOWED_WEBHOOK_EVENTS = new Set<string>(EVOLUTION_MESSAGE_WEBHOOK_EVENTS);

/**
 * Lista de eventos que pode ir ao Evolution: não vazia (vazia com "enabled" assina todos os eventos), sem
 * repetição e só com eventos conhecidos do CRM.
 */
export function explicitWebhookEvents(events: readonly string[]): string[] {
  const list = [...events];
  if (list.length === 0) throw new Error("webhook_events_empty");
  if (new Set(list).size !== list.length || list.some((event) => !ALLOWED_WEBHOOK_EVENTS.has(event))) {
    throw new Error("webhook_events_invalid");
  }
  return list;
}

const webhookConfig = (webhookSecret: string, events: readonly string[]) => ({
  enabled: true,
  url: EVOLUTION_WEBHOOK_URL,
  byEvents: false,
  base64: false,
  headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: webhookSecret },
  events: explicitWebhookEvents(events)
});

const isMissingInstance = (status: number, json: unknown) =>
  status === 404 || (status === 400 && /does not exist/i.test(JSON.stringify(json ?? "")));

/** 400 do envio para número sem WhatsApp: response.message = [{ exists: false, ... }]. */
const isNumberNotOnWhatsApp = (status: number, json: any) =>
  status === 400 && Array.isArray(json?.response?.message) && json.response.message.some((item: any) => item && typeof item === "object" && item.exists === false);

export class EvolutionClient {
  private readonly baseUrl: string;

  constructor(private readonly options: EvolutionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = this.options.timeoutMs ?? 8_000) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { apikey: this.options.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new EvolutionUnavailableError("timeout");
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      throw new EvolutionUnavailableError("network", { connectRefused: typeof code === "string" && CONNECT_REFUSED_CODES.has(code) });
    }
    const text = await response.text().catch(() => "");
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 401 || response.status === 403) throw new EvolutionUnavailableError("unauthorized");
    if (response.status >= 500) throw new EvolutionUnavailableError(`http_${response.status}`);
    return { status: response.status, json };
  }

  /**
   * Cria a instância já com QR. O webhook (alias interno da API, segredo no header) recebe os eventos da
   * lista atual (conexão; mais mensagens com a Fase B ligada). Histórico, grupos, presença e leitura ficam
   * desligados.
   */
  async createInstance(instanceName: string): Promise<{ qrDataUrl: string | null }> {
    const { status, json } = await this.request(
      "POST",
      "/instance/create",
      {
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        syncFullHistory: false,
        groupsIgnore: true,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        rejectCall: false,
        webhook: webhookConfig(this.options.webhookSecret, evolutionWebhookEvents())
      },
      this.options.createTimeoutMs ?? 12_000
    );
    if (status >= 400) throw new EvolutionUnavailableError(`create_http_${status}`);
    return { qrDataUrl: pickQrDataUrl(json?.qrcode) };
  }

  /** Estado da conexão; quando ainda aguarda leitura, devolve o QR atual. */
  async connect(instanceName: string): Promise<EvolutionConnectResult> {
    const { status, json } = await this.request("GET", `/instance/connect/${encodeURIComponent(instanceName)}`);
    if (isMissingInstance(status, json)) return { kind: "not_found" };
    if (status >= 400) throw new EvolutionUnavailableError(`connect_http_${status}`);
    if (json?.instance?.state === "open") return { kind: "open" };
    return { kind: "qr", qrDataUrl: pickQrDataUrl(json) };
  }

  async connectionState(instanceName: string): Promise<EvolutionState> {
    const { status, json } = await this.request("GET", `/instance/connectionState/${encodeURIComponent(instanceName)}`);
    if (isMissingInstance(status, json)) return "not_found";
    if (status >= 400) throw new EvolutionUnavailableError(`state_http_${status}`);
    const state = json?.instance?.state;
    return state === "open" || state === "connecting" || state === "close" ? state : "unknown";
  }

  /** JID da conta conectada (ownerJid), ou null. */
  async ownerJid(instanceName: string): Promise<string | null> {
    const { status, json } = await this.request("GET", `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
    if (isMissingInstance(status, json)) return null;
    if (status >= 400) throw new EvolutionUnavailableError(`fetch_http_${status}`);
    const first = Array.isArray(json) ? json[0] : null;
    return typeof first?.ownerJid === "string" ? first.ownerJid : null;
  }

  /**
   * Troca os eventos do webhook de uma instância já conectada, sem novo QR (POST /webhook/set, que faz
   * upsert por instância). A lista é sempre explícita. Instância inexistente: "not_found".
   */
  async setWebhook(instanceName: string, events: readonly string[]): Promise<"ok" | "not_found"> {
    const { status, json } = await this.request("POST", `/webhook/set/${encodeURIComponent(instanceName)}`, {
      webhook: webhookConfig(this.options.webhookSecret, events)
    });
    if (isMissingInstance(status, json)) return "not_found";
    if (status >= 400) throw new EvolutionUnavailableError(`webhook_set_http_${status}`);
    return "ok";
  }

  /**
   * Baixa e decifra a mídia de uma mensagem (POST /chat/getBase64FromMediaMessage). O Evolution do CRM não
   * grava mensagens, então a busca só pela chave não acha nada: vai a mensagem inteira (key + message), que
   * chega no webhook e fica só em memória. O Evolution espera 5 s antes de tentar de novo: timeout maior.
   * Resposta sem base64, ou maior que o limite, é recusada. Nunca grava log.
   */
  async getMediaBase64(
    instanceName: string,
    message: { key: Record<string, unknown>; message: Record<string, unknown> },
    maxBase64Length: number
  ): Promise<{ base64: string; mimetype: string | null }> {
    const { status, json } = await this.request(
      "POST",
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`,
      { message, convertToMp4: false },
      this.options.mediaTimeoutMs ?? 30_000
    );
    if (status >= 400) throw new EvolutionUnavailableError(`media_http_${status}`);
    const base64 = json?.base64;
    if (typeof base64 !== "string" || !base64) throw new EvolutionUnavailableError("media_empty");
    if (base64.length > maxBase64Length) throw new EvolutionUnavailableError("media_too_large");
    return { base64, mimetype: typeof json?.mimetype === "string" ? json.mimetype : null };
  }

  /**
   * Fase D: envia um texto (POST /message/sendText) ao celular de um usuário ativo do CRM. O destino tem de
   * ser o objeto emitido por resolveCrmUserRecipient; qualquer outra coisa é recusada antes da rede. Sem
   * pré-visualização de link; "digitando" curto antes de mandar. Nunca grava log.
   */
  async sendTextToCrmUser(instanceName: string, recipient: CrmUserRecipient, text: string): Promise<EvolutionSendResult> {
    if (!isCrmUserRecipient(recipient)) throw new Error("whatsapp_recipient_not_crm_user");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_SEND_TEXT_LENGTH) throw new Error("whatsapp_text_invalid");
    const result = await this.#postSendText(instanceName, recipient.phone, text, this.options.sendTimeoutMs ?? 20_000);
    return result.kind === "sent" ? { kind: "sent" } : result;
  }

  /**
   * Fase C: envia um texto ao telefone de um cliente, pela instância do próprio remetente. O destino (com a
   * instância) tem de ser o objeto emitido por resolveClientRecipient; qualquer outra coisa, inclusive o
   * destino do resumo diário, é recusada antes da rede. Devolve o id da mensagem. Nunca grava log.
   */
  async sendTextToClient(recipient: ClientRecipient, text: string): Promise<EvolutionClientSendResult> {
    if (!isClientRecipient(recipient)) throw new Error("whatsapp_recipient_not_client");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_SEND_TEXT_LENGTH) throw new Error("whatsapp_text_invalid");
    return this.#postSendText(recipient.instanceName, recipient.phone, text, this.options.clientSendTimeoutMs ?? CLIENT_SEND_TIMEOUT_MS);
  }

  /** POST /message/sendText: privado de verdade (fora da classe não existe), chamado só pelos dois envios acima. */
  async #postSendText(instanceName: string, phone: string, text: string, timeoutMs: number): Promise<EvolutionClientSendResult> {
    let response: { status: number; json: any };
    try {
      response = await this.request("POST", `/message/sendText/${encodeURIComponent(instanceName)}`, { number: phone, text, delay: 1_200, linkPreview: false }, timeoutMs);
    } catch (error) {
      if (!(error instanceof EvolutionUnavailableError)) throw error;
      if (error.connectRefused) return { kind: "not_sent", code: "connection_refused", retryable: true };
      if (error.reason === "unauthorized") return { kind: "not_sent", code: "unauthorized", retryable: false };
      return { kind: "uncertain", code: error.reason };
    }
    const { status, json } = response;
    if (status >= 200 && status < 300) {
      const messageId = json?.key?.id;
      return typeof messageId === "string" && messageId ? { kind: "sent", messageId } : { kind: "uncertain", code: "no_message_id" };
    }
    if (isMissingInstance(status, json)) return { kind: "not_sent", code: "instance_not_found", retryable: false };
    if (isNumberNotOnWhatsApp(status, json)) return { kind: "not_sent", code: "number_not_on_whatsapp", retryable: false };
    return { kind: "uncertain", code: `http_${status}` };
  }

  /** Desconecta (logout) e apaga a instância e a sessão. Instância inexistente já é o resultado esperado. */
  async deleteInstance(instanceName: string): Promise<void> {
    const { status, json } = await this.request("DELETE", `/instance/delete/${encodeURIComponent(instanceName)}`);
    if (status < 400 || isMissingInstance(status, json)) return;
    throw new EvolutionUnavailableError(`delete_http_${status}`);
  }
}

export const createEvolutionClient = () =>
  new EvolutionClient({
    baseUrl: env.whatsappEvolutionBaseUrl,
    apiKey: env.whatsappEvolutionApiKey,
    webhookSecret: env.whatsappEvolutionWebhookSecret
  });
