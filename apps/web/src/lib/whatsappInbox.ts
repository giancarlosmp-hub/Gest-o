import type { WhatsAppMessageItem } from "./whatsappMessages";

// WhatsApp Fase C (C2): caixa de conversas e envio pelo CRM em /whatsapp, lidos de /whatsapp/inbox... (API do C1).
// Regras ficam na API: a tela só mostra o que ela devolve e repassa as mensagens de erro como vieram.

export const INBOX_POLL_MS = 20_000;
export const CONVERSATION_POLL_MS = 5_000;
export const CRM_SEND_TEXT_MAX = 4_000;

export type InboxStatus = {
  available: boolean;
  enabled: boolean;
  sendEnabled: boolean;
  connected: boolean;
  canEditConfig: boolean;
  limits: { perMinute: number; perDay: number; firstContactsPerDay: number; maxTextLength: number };
  today: { total: number; firstContacts: number } | null;
  unreadTotal: number;
};

export type InboxConversation = {
  id: string;
  client: { id: string; name: string } | null;
  /** Número do contato mascarado. */
  contactDisplay: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  numberOwner: { id: string; name: string } | null;
  own: boolean;
  canReply: boolean;
};

export type InboxListItem = InboxConversation & {
  lastMessage: { direction: "inbound" | "outbound"; type: string; text: string; viaCrm: boolean } | null;
};

export type InboxPage = { items: InboxListItem[]; nextCursor: string | null };

export type InboxMessagesPage = { conversation: InboxConversation; items: WhatsAppMessageItem[]; nextBefore: string | null; serverTime: string };

export type ClientPhoneTarget = {
  ref: string;
  /** "(DD) 9NNNN-NNNN", mesmo formato do telefone do ERP na tela do cliente. */
  display: string | null;
  kind: "mobile" | "landline" | null;
  source: string;
  conversationId: string | null;
  unreadCount: number;
};

export type ClientTargets = { client: { id: string; name: string }; connected: boolean; phones: ClientPhoneTarget[] };

export type InboxScope = "mine" | "team";

/** Envio incerto: a API responde 202 com este código; para a tela não é sucesso. */
export const UNCERTAIN_SEND_MESSAGE = "Pode ter sido enviada. Confira no celular antes de reenviar.";

export type SendOutcome =
  | { ok: true; conversationId: string; message: WhatsAppMessageItem }
  | { ok: false; uncertain: boolean; message: string };

/** Resposta do POST /whatsapp/inbox/send (201, ou 202 incerto) em resultado para a tela. */
export function sendOutcomeFromResponse(data: unknown): SendOutcome {
  const body = (data && typeof data === "object" ? data : {}) as { conversationId?: unknown; message?: unknown; code?: unknown };
  if (typeof body.conversationId === "string" && body.message && typeof body.message === "object") {
    return { ok: true, conversationId: body.conversationId, message: body.message as WhatsAppMessageItem };
  }
  if (body.code === "uncertain") return { ok: false, uncertain: true, message: typeof body.message === "string" ? body.message : UNCERTAIN_SEND_MESSAGE };
  return { ok: false, uncertain: true, message: UNCERTAIN_SEND_MESSAGE };
}

/**
 * Erro do envio: a mensagem da API como veio. Sem resposta (tempo esgotado, rede): o texto pode ter saído,
 * então o aviso é o mesmo do incerto.
 */
export function sendOutcomeFromError(error: unknown): SendOutcome {
  const response = (error as { response?: { status?: number; data?: { message?: unknown; code?: unknown } } })?.response;
  if (!response) return { ok: false, uncertain: true, message: UNCERTAIN_SEND_MESSAGE };
  const message = typeof response.data?.message === "string" && response.data.message ? response.data.message : "Não foi possível enviar.";
  return { ok: false, uncertain: response.data?.code === "uncertain", message };
}

/** Mensagem de erro da API, ou o texto padrão. */
export const inboxApiMessage = (error: unknown, fallback: string) => {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === "string" && message ? message : fallback;
};

const messageTime = (message: WhatsAppMessageItem) => (message.at ? Date.parse(message.at) : Number.POSITIVE_INFINITY);

/** Junta mensagens novas ou alteradas (polling) às já carregadas: por id, a versão nova vence; ordem de envio. */
export function mergeMessages(current: WhatsAppMessageItem[], incoming: WhatsAppMessageItem[]) {
  if (!incoming.length) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => messageTime(a) - messageTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const digits = (value: string | null | undefined) => String(value ?? "").replace(/\D/g, "");

/** Telefone do ERP (como aparece na tela do cliente) → destino do envio pelo CRM com o mesmo número. */
export function findPhoneTarget(targets: ClientPhoneTarget[] | null | undefined, display: string | null | undefined) {
  const key = digits(display);
  if (!key || !targets) return null;
  return targets.find((target) => digits(target.display) === key) ?? null;
}

/** Endereço da conversa no CRM: a existente, ou uma nova (cliente + telefone), criada no primeiro envio. */
export function conversationPath(input: { clientId: string; target: Pick<ClientPhoneTarget, "ref" | "conversationId"> }) {
  if (input.target.conversationId) return `/whatsapp?conversationId=${encodeURIComponent(input.target.conversationId)}`;
  return `/whatsapp?clientId=${encodeURIComponent(input.clientId)}&phoneRef=${encodeURIComponent(input.target.ref)}`;
}

/** Trecho da última mensagem na lista. */
export function lastMessagePreview(item: Pick<InboxListItem, "lastMessage">) {
  const last = item.lastMessage;
  if (!last) return "";
  const text = last.text || (last.type !== "TEXT" ? "[mídia]" : "");
  if (last.direction === "inbound") return text;
  return `${last.viaCrm ? "Você (CRM)" : "Você"}: ${text}`;
}

/** Rótulo da mídia (o CRM não guarda o arquivo): o texto gravado ou o tipo. */
const MEDIA_LABELS: Record<string, string> = {
  IMAGE: "[imagem]",
  VIDEO: "[vídeo]",
  AUDIO: "[áudio]",
  DOCUMENT: "[documento]",
  STICKER: "[figurinha]",
  LOCATION: "[localização]",
  CONTACT: "[contato]"
};

export const messageBodyLabel = (message: Pick<WhatsAppMessageItem, "type" | "text">) =>
  message.text || MEDIA_LABELS[message.type] || (message.type !== "TEXT" ? "[mídia]" : "");

/** Restante do campo de resposta. */
export const remainingChars = (text: string, max = CRM_SEND_TEXT_MAX) => max - text.length;

/** Pode enviar: chave ligada, número conectado, conversa (ou destino novo) que aceita resposta, texto válido. */
export function canSendText(input: { status: Pick<InboxStatus, "sendEnabled" | "connected"> | null; canReply: boolean; text: string; sending: boolean; max?: number }) {
  const length = input.text.trim().length;
  return Boolean(input.status?.sendEnabled && input.status.connected && input.canReply && !input.sending && length > 0 && input.text.length <= (input.max ?? CRM_SEND_TEXT_MAX));
}

/** Por que o campo de resposta não aparece ou não envia. */
export function replyBlockedReason(input: { status: Pick<InboxStatus, "sendEnabled" | "connected" | "available" | "enabled"> | null; own: boolean; canReply: boolean }) {
  if (!input.own) return "Somente leitura: conversa do número de outro usuário.";
  if (!input.canReply) return "Esta conversa não aceita resposta pelo CRM (cliente arquivado ou fora da sua carteira).";
  if (!input.status) return null;
  if (!input.status.enabled) return "Envio pelo CRM desligado. Responda pelo celular.";
  if (!input.status.available) return "Envio pelo CRM indisponível no momento.";
  if (!input.status.connected) return "Seu WhatsApp não está conectado. Conecte no cartão \"Meu número\".";
  return null;
}
