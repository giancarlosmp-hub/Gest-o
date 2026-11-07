import { env } from "../../config/env.js";
import { EVOLUTION_MESSAGE_WEBHOOK_EVENTS, EVOLUTION_WEBHOOK_SECRET_HEADER, EVOLUTION_WEBHOOK_URL, evolutionWebhookEvents } from "./config.js";

// Cliente mínimo da Evolution API v2.3.7: criar instância (com QR), consultar estado, ler o número
// conectado, apagar a instância, (Fase B) ajustar os eventos do webhook da instância e baixar o áudio a
// transcrever. Não existe nenhum método de envio de mensagem.
// Nada aqui grava log: QR, chave, número e mídia nunca passam pelo logger.

export class EvolutionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Evolution API indisponível (${reason})`);
    this.name = "EvolutionUnavailableError";
  }
}

export type EvolutionConnectResult = { kind: "open" } | { kind: "qr"; qrDataUrl: string | null } | { kind: "not_found" };
export type EvolutionState = "open" | "connecting" | "close" | "not_found" | "unknown";

type EvolutionClientOptions = {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  timeoutMs?: number;
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
      throw new EvolutionUnavailableError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
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
