import { BRAZIL_TIME_ZONE } from "./brazilDate";

// WhatsApp Fase B2: conversas gravadas do número comercial (Evolution), lidas pela API. Não existe envio.

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
  origin: "app" | "received";
  edited: boolean;
  /** Edição cifrada no WhatsApp: o texto mostrado é o original, o novo não é legível. */
  editedTextUnavailable: boolean;
  deletedInWhatsApp: boolean;
};

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

export const whatsappOriginLabel = (message: Pick<WhatsAppMessageItem, "origin">) => (message.origin === "app" ? "via app" : "recebida");

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
