import { BRAZIL_TIME_ZONE } from "./brazilDate";

// WhatsApp Fase B2: conversas gravadas do número comercial (Evolution), lidas pela API. O envio pelo CRM
// (Fase C) grava a mensagem com origem "crm" ("via CRM").

/** Cartão "WhatsApp · dd/mm": uma conversa (número do vendedor + contato) num dia de Brasília. */
export type WhatsAppDayCardItem = {
  day: string;
  conversationId: string;
  total: number;
  inbound: number;
  outbound: number;
  firstAt: string;
  lastAt: string;
  /** Número do contato mascarado, "(DD) ****-NNNN". */
  contactDisplay: string | null;
  numberOwner: { id: string; name: string } | null;
};

export type WhatsAppDayCardsPage = {
  items: WhatsAppDayCardItem[];
  nextBefore: string | null;
  clientId?: string;
  since?: string;
  canOpenClient?: boolean;
};

export type WhatsAppMessageItem = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  text: string;
  at: string | null;
  /** Enviada pelo app do celular, pelo CRM (Fase C) ou recebida. */
  origin: "app" | "crm" | "received";
  edited: boolean;
  /** Edição cifrada no WhatsApp: o texto mostrado é o original, o novo não é legível. */
  editedTextUnavailable: boolean;
  deletedInWhatsApp: boolean;
  /** Só em áudio com a transcrição pedida; o texto vem quando pronta. */
  transcription?: WhatsAppTranscription | null;
};

export type WhatsAppTranscription = {
  status: "pending" | "done" | "failed" | "skipped";
  text?: string;
  reason?: string;
};

/** "[áudio 0:42]" → "🎤 0:42"; outro texto fica igual. */
export const whatsappAudioLabel = (text: string) => {
  const match = text.match(/^\[áudio(?: (\d+:\d{2}))?\]$/);
  if (!match) return text;
  return match[1] ? `🎤 ${match[1]}` : "🎤";
};

/** Aviso do áudio sem texto transcrito (pendente, pulado ou falhou); pronto: null. */
export const whatsappTranscriptionNote = (transcription: WhatsAppTranscription) => {
  if (transcription.status === "done") return null;
  if (transcription.status === "pending") return "transcrevendo…";
  if (transcription.reason === "too_long") return "longo demais para transcrever";
  if (transcription.reason === "daily_cap") return "limite diário de transcrição atingido";
  return "não foi possível transcrever";
};

/** Transcrição longa começa cortada, com "ver mais". */
export const TRANSCRIPT_PREVIEW_CHARS = 400;

export type WhatsAppUnlinkedItem = {
  id: string;
  /** Número completo: só o dono do número recebe a própria fila. */
  phone: string | null;
  pushName: string | null;
  status: "unlinked" | "ambiguous";
  lastMessage: { text: string; direction: "inbound" | "outbound"; at: string | null } | null;
  lastMessageAt: string | null;
  expiresAt: string | null;
  daysToExpire: number | null;
};

export type WhatsAppUnlinkedPage = { items: WhatsAppUnlinkedItem[]; nextCursor: string | null; total: number };

export type WhatsAppMessagesSummary = { recording: { enabled: boolean; since: string | null }; unlinkedCount: number };

/** "AAAA-MM-DD" → "dd/mm". */
export const formatWhatsAppDay = (day: string) => {
  const [, month, date] = day.split("-");
  return month && date ? `${date}/${month}` : day;
};

/** "dd/mm" de um instante, em Brasília. */
export const formatBrazilDayMonth = (iso: string | null | undefined) => {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return value.toLocaleDateString("pt-BR", { timeZone: BRAZIL_TIME_ZONE, day: "2-digit", month: "2-digit" });
};

/** "hh:mm" em Brasília. */
export const formatWhatsAppTime = (iso: string | null | undefined) => {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleTimeString("pt-BR", { timeZone: BRAZIL_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
};

export const whatsappOriginLabel = (message: Pick<WhatsAppMessageItem, "origin">) =>
  message.origin === "app" ? "via app" : message.origin === "crm" ? "via CRM" : "recebida";

export const whatsappExpiryLabel = (days: number | null) => {
  if (days === null) return null;
  if (days <= 0) return "expira hoje";
  return days === 1 ? "expira em 1 dia" : `expira em ${days} dias`;
};

export type TimelineEntry<E> = { kind: "event"; at: number; event: E } | { kind: "whatsapp"; at: number; card: WhatsAppDayCardItem };

/**
 * Intercala eventos e cartões do WhatsApp por data (mais recente primeiro). As duas listas são paginadas:
 * enquanto uma delas tem mais páginas, nada mais antigo que o item mais antigo já carregado dela aparece,
 * para a ordem não "pular" quando a próxima página chegar.
 */
export function mergeTimeline<E extends { createdAt: string }>(input: {
  events: E[];
  eventsHasMore: boolean;
  cards: WhatsAppDayCardItem[];
  cardsHasMore: boolean;
}): TimelineEntry<E>[] {
  const events = input.events.map((event) => ({ kind: "event" as const, at: Date.parse(event.createdAt), event }));
  const cards = input.cards.map((card) => ({ kind: "whatsapp" as const, at: Date.parse(card.lastAt), card }));
  const boundaries: number[] = [];
  if (input.eventsHasMore && events.length) boundaries.push(Math.min(...events.map((entry) => entry.at)));
  if (input.cardsHasMore && cards.length) boundaries.push(Math.min(...cards.map((entry) => entry.at)));
  const boundary = boundaries.length ? Math.max(...boundaries) : Number.NEGATIVE_INFINITY;
  return [...events, ...cards].filter((entry) => !(entry.at < boundary)).sort((a, b) => b.at - a.at);
}
