import { CommunicationMessageType } from "@prisma/client";
import { contactPhoneFromWhatsAppJid } from "../whatsappConnection/phoneMatch.js";

// WhatsApp Fase B: lê os eventos de mensagem do Evolution v2.3.7 (webhook interno) e devolve só o que o
// CRM grava. Função pura: sem rede, banco ou log.
//
// - messages.upsert: data = { key: { remoteJid, fromMe, id, remoteJidAlt? }, pushName, message,
//   messageType, messageTimestamp (segundos) }. Com endereçamento LID o Evolution já troca remoteJid
//   pelo remoteJidAlt antes de enviar; se ainda vier LID, não há número e a mensagem é ignorada.
// - messages.edited: data = protocolMessage { key (da mensagem original), editedMessage }.
// - messages.delete: data = { ...key, status: "DELETED" }.
// Grupo, status (stories), lista de transmissão e canal são ignorados. Mídia: só tipo e legenda; URL,
// chave, miniatura, coordenadas, vCard e nome de arquivo nunca saem daqui.

export type ParsedMessageContent = {
  type: CommunicationMessageType;
  /** Texto exibido: o texto, ou o rótulo da mídia com a legenda ("[imagem] legenda", "[áudio 0:42]"). */
  text: string;
  /** Só o tipo e a duração; nunca URL, chave, miniatura ou nome de arquivo. */
  media: { kind: string; seconds?: number } | null;
};

export type ParsedEvolutionEvent =
  | {
      kind: "upsert";
      instance: string;
      externalMessageId: string;
      fromMe: boolean;
      contactPhone: string;
      pushName: string | null;
      timestamp: Date | null;
      content: ParsedMessageContent;
    }
  | { kind: "edit"; instance: string; targetMessageId: string; content: ParsedMessageContent }
  | { kind: "delete"; instance: string; targetMessageId: string }
  | { kind: "ignored"; reason: IgnoredReason };

export type IgnoredReason =
  | "not_message_event"
  | "invalid_payload"
  | "group"
  | "status"
  | "broadcast"
  | "newsletter"
  | "lid_unresolved"
  | "unsupported_number"
  | "reaction"
  | "protocol"
  | "empty";

const MESSAGE_EVENTS: Record<string, "upsert" | "edit" | "delete"> = {
  "messages.upsert": "upsert",
  "messages.edited": "edit",
  "messages.delete": "delete"
};

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const asText = (value: unknown) => (typeof value === "string" ? value.replace(/\s+$/g, "").replace(/^\s+/g, "") : "");

/** Nome do evento como o Evolution manda ("messages.upsert" ou "MESSAGES_UPSERT") em minúsculas com ponto. */
export const normalizeEvolutionEventName = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, ".") : "";

export const isEvolutionMessageEvent = (value: unknown) => normalizeEvolutionEventName(value) in MESSAGE_EVENTS;

/** Classifica o destino da conversa pelo JID; "contact" quando há um número de pessoa. */
export function classifyRemoteJid(jid: unknown):
  | { kind: "contact"; phone: string }
  | { kind: "ignored"; reason: "group" | "status" | "broadcast" | "newsletter" | "lid_unresolved" | "unsupported_number" | "invalid_payload" } {
  if (typeof jid !== "string" || !jid.includes("@")) return { kind: "ignored", reason: "invalid_payload" };
  const value = jid.trim().toLowerCase();
  if (value === "status@broadcast") return { kind: "ignored", reason: "status" };
  if (value.endsWith("@g.us")) return { kind: "ignored", reason: "group" };
  if (value.endsWith("@broadcast")) return { kind: "ignored", reason: "broadcast" };
  if (value.endsWith("@newsletter")) return { kind: "ignored", reason: "newsletter" };
  if (value.endsWith("@lid")) return { kind: "ignored", reason: "lid_unresolved" };
  const phone = contactPhoneFromWhatsAppJid(value);
  return phone ? { kind: "contact", phone } : { kind: "ignored", reason: "unsupported_number" };
}

/** "0:42", "12:05". */
export const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const withCaption = (label: string, caption: string) => (caption ? `${label} ${caption}` : label);

const toSeconds = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 86_400 ? Math.round(parsed) : undefined;
};

// Invólucros que só embrulham outra mensagem.
const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage"];

function unwrap(message: Json): Json {
  let current = message;
  for (let depth = 0; depth < 4; depth++) {
    const wrapper = WRAPPERS.map((key) => asRecord(asRecord(current[key])?.message)).find(Boolean);
    if (!wrapper) return current;
    current = wrapper;
  }
  return current;
}

/**
 * Conteúdo exibível da mensagem. "reaction" e "protocol" são ignorados pelo chamador; "empty" quando não
 * há conteúdo conhecido nem desconhecido.
 */
export function parseMessageContent(rawMessage: unknown): ParsedMessageContent | "reaction" | "protocol" | "empty" {
  const outer = asRecord(rawMessage);
  if (!outer) return "empty";
  const message = unwrap(outer);
  if (message.reactionMessage) return "reaction";
  if (message.protocolMessage) return "protocol";

  if (typeof message.conversation === "string") {
    const text = asText(message.conversation);
    return text ? { type: CommunicationMessageType.TEXT, text, media: null } : "empty";
  }
  const extended = asRecord(message.extendedTextMessage);
  if (extended) {
    const text = asText(extended.text);
    return text ? { type: CommunicationMessageType.TEXT, text, media: null } : "empty";
  }
  const image = asRecord(message.imageMessage);
  if (image) return { type: CommunicationMessageType.IMAGE, text: withCaption("[imagem]", asText(image.caption)), media: { kind: "image" } };
  const video = asRecord(message.videoMessage) ?? asRecord(message.ptvMessage);
  if (video) {
    const seconds = toSeconds(video.seconds);
    return { type: CommunicationMessageType.VIDEO, text: withCaption("[vídeo]", asText(video.caption)), media: { kind: "video", ...(seconds !== undefined ? { seconds } : {}) } };
  }
  const audio = asRecord(message.audioMessage);
  if (audio) {
    const seconds = toSeconds(audio.seconds);
    return { type: CommunicationMessageType.AUDIO, text: seconds !== undefined ? `[áudio ${formatDuration(seconds)}]` : "[áudio]", media: { kind: "audio", ...(seconds !== undefined ? { seconds } : {}) } };
  }
  const document = asRecord(message.documentMessage);
  if (document) return { type: CommunicationMessageType.DOCUMENT, text: withCaption("[documento]", asText(document.caption)), media: { kind: "document" } };
  if (message.stickerMessage) return { type: CommunicationMessageType.STICKER, text: "[figurinha]", media: { kind: "sticker" } };
  if (message.locationMessage || message.liveLocationMessage) return { type: CommunicationMessageType.LOCATION, text: "[localização]", media: null };
  if (message.contactMessage || message.contactsArrayMessage) return { type: CommunicationMessageType.CONTACT, text: "[contato]", media: null };
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    return { type: CommunicationMessageType.UNKNOWN, text: "[enquete]", media: null };
  }
  const keys = Object.keys(message).filter((key) => key !== "messageContextInfo");
  return keys.length ? { type: CommunicationMessageType.UNKNOWN, text: "[mensagem não suportada]", media: null } : "empty";
}

/** messageTimestamp em segundos (número, texto ou Long { low, high }). */
export function parseMessageTimestamp(value: unknown): Date | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) seconds = Number(value);
  else {
    const long = asRecord(value);
    if (!long || typeof long.low !== "number") return null;
    seconds = (typeof long.high === "number" ? long.high : 0) * 2 ** 32 + (long.low >>> 0);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Aceita também milissegundos.
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

const messageId = (value: unknown) => (typeof value === "string" && value.trim() && value.length <= 128 ? value.trim() : null);

export function parseEvolutionMessageEvent(payload: unknown): ParsedEvolutionEvent {
  const body = asRecord(payload);
  const kind = MESSAGE_EVENTS[normalizeEvolutionEventName(body?.event)];
  if (!body || !kind) return { kind: "ignored", reason: "not_message_event" };
  const instance = typeof body.instance === "string" ? body.instance.trim() : "";
  const data = asRecord(body.data);
  if (!instance || !data) return { kind: "ignored", reason: "invalid_payload" };

  if (kind === "upsert") {
    const key = asRecord(data.key);
    const id = messageId(key?.id);
    if (!key || !id) return { kind: "ignored", reason: "invalid_payload" };
    const destination = classifyRemoteJid(key.remoteJid);
    if (destination.kind === "ignored") return { kind: "ignored", reason: destination.reason };
    const content = parseMessageContent(data.message);
    if (content === "reaction" || content === "protocol" || content === "empty") return { kind: "ignored", reason: content };
    const fromMe = key.fromMe === true;
    const pushName = !fromMe ? asText(data.pushName).slice(0, 120) || null : null;
    return {
      kind: "upsert",
      instance,
      externalMessageId: id,
      fromMe,
      contactPhone: destination.phone,
      pushName,
      timestamp: parseMessageTimestamp(data.messageTimestamp),
      content
    };
  }

  if (kind === "edit") {
    const protocol = asRecord(data.protocolMessage) ?? data;
    const targetId = messageId(asRecord(protocol.key)?.id);
    if (!targetId) return { kind: "ignored", reason: "invalid_payload" };
    const content = parseMessageContent(protocol.editedMessage);
    if (content === "reaction" || content === "protocol" || content === "empty") return { kind: "ignored", reason: "empty" };
    return { kind: "edit", instance, targetMessageId: targetId, content };
  }

  const key = asRecord(data.key) ?? data;
  const targetId = messageId(key.id);
  if (!targetId) return { kind: "ignored", reason: "invalid_payload" };
  return { kind: "delete", instance, targetMessageId: targetId };
}
