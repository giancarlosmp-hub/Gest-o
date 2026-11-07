import { CommunicationDirection, type Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { EVOLUTION_PROVIDER } from "./whatsappMessageStore.js";
import { transcriptionOf, type TranscriptionReason, type TranscriptionStatus } from "./whatsappTranscriptionQueue.js";

// WhatsApp Fase B2: leitura das conversas gravadas para a linha do tempo do cliente e da oportunidade.
// - Cartão = uma conversa (número comercial + contato) num dia de Brasília: "WhatsApp · dd/mm".
// - Dias paginados de trás para frente (`before` = dia AAAA-MM-DD exclusivo). A varredura lê só data,
//   direção e conversa de até SCAN_LIMIT mensagens; o dia mais antigo de uma varredura cortada não volta
//   (incompleto) e é lido na página seguinte.
// - Mensagens de um cartão: paginadas por id, em ordem de envio.
// Nada daqui devolve número completo, id externo ou nome do contato no WhatsApp.

export const BRAZIL_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DAYS_PAGE_DEFAULT = 20;
export const DAYS_PAGE_MAX = 60;
export const SCAN_LIMIT = 3_000;
export const MESSAGES_PAGE = 300;

/** Dia de Brasília (AAAA-MM-DD) de um instante. Brasil sem horário de verão: UTC-3 fixo. */
export const brazilDayKey = (instant: Date) => new Date(instant.getTime() - BRAZIL_UTC_OFFSET_MS).toISOString().slice(0, 10);

/** Início (00:00 de Brasília) de um dia AAAA-MM-DD; null se o texto não for um dia válido. */
export const brazilDayStart = (day: unknown): Date | null => {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) return null;
  return new Date(start.getTime() + BRAZIL_UTC_OFFSET_MS);
};

export type DayScanRow = { conversationId: string; direction: CommunicationDirection; providerTimestamp: Date | null };

export type DayCardCounts = {
  day: string;
  conversationId: string;
  total: number;
  inbound: number;
  outbound: number;
  firstAt: Date;
  lastAt: Date;
};

/**
 * Agrupa a varredura (mais recente primeiro) em cartões por dia e conversa. Função pura.
 * `truncated`: havia mais mensagens além da varredura; o dia mais antigo dela pode estar incompleto.
 */
export function groupDayCards(rows: DayScanRow[], take: number, truncated: boolean) {
  const days: string[] = [];
  const cards = new Map<string, DayCardCounts>();
  for (const row of rows) {
    if (!row.providerTimestamp) continue;
    const day = brazilDayKey(row.providerTimestamp);
    if (days[days.length - 1] !== day) days.push(day);
    const key = `${day}|${row.conversationId}`;
    const card = cards.get(key) ?? { day, conversationId: row.conversationId, total: 0, inbound: 0, outbound: 0, firstAt: row.providerTimestamp, lastAt: row.providerTimestamp };
    card.total++;
    if (row.direction === CommunicationDirection.OUTBOUND) card.outbound++;
    else card.inbound++;
    if (row.providerTimestamp < card.firstAt) card.firstAt = row.providerTimestamp;
    if (row.providerTimestamp > card.lastAt) card.lastAt = row.providerTimestamp;
    cards.set(key, card);
  }
  // Varredura cortada: o dia mais antigo só volta na próxima página (a não ser que seja o único).
  const complete = truncated && days.length > 1 ? days.slice(0, -1) : days;
  const returned = complete.slice(0, take);
  const hasMore = truncated || complete.length > take;
  const wanted = new Set(returned);
  const items = [...cards.values()]
    .filter((card) => wanted.has(card.day))
    .sort((a, b) => (a.day === b.day ? b.lastAt.getTime() - a.lastAt.getTime() : a.day < b.day ? 1 : -1));
  return { items, nextBefore: hasMore && returned.length ? returned[returned.length - 1] : null };
}

type ReadsDb = Pick<PrismaClient, "communicationMessage" | "communicationConversation">;

export type DayCardView = DayCardCounts & {
  contactDisplay: string | null;
  numberOwner: { id: string; name: string } | null;
};

/** Cartões das conversas vinculadas a um cliente; `since` limita (oportunidade: desde a criação). */
export async function readClientDayCards(
  input: { clientId: string; before?: string | null; since?: Date | null; take?: number },
  db: ReadsDb = defaultPrisma
): Promise<{ items: DayCardView[]; nextBefore: string | null }> {
  const take = Math.min(Math.max(Math.trunc(input.take ?? DAYS_PAGE_DEFAULT), 1), DAYS_PAGE_MAX);
  const upper = input.before ? brazilDayStart(input.before) : null;
  const timestamp: Prisma.DateTimeNullableFilter = { not: null };
  if (upper) timestamp.lt = upper;
  if (input.since) timestamp.gte = input.since;
  const rows = await db.communicationMessage.findMany({
    where: { provider: EVOLUTION_PROVIDER, providerTimestamp: timestamp, conversation: { clientId: input.clientId, provider: EVOLUTION_PROVIDER } },
    orderBy: [{ providerTimestamp: "desc" }, { id: "desc" }],
    take: SCAN_LIMIT + 1,
    select: { conversationId: true, direction: true, providerTimestamp: true }
  });
  const grouped = groupDayCards(rows.slice(0, SCAN_LIMIT), take, rows.length > SCAN_LIMIT);
  const ids = [...new Set(grouped.items.map((item) => item.conversationId))];
  const conversations = ids.length
    ? await db.communicationConversation.findMany({
        where: { id: { in: ids } },
        select: { id: true, contactDisplay: true, numberOwner: { select: { id: true, name: true } } }
      })
    : [];
  const byId = new Map(conversations.map((row) => [row.id, row]));
  return {
    items: grouped.items.map((item) => ({
      ...item,
      contactDisplay: byId.get(item.conversationId)?.contactDisplay ?? null,
      numberOwner: byId.get(item.conversationId)?.numberOwner ?? null
    })),
    nextBefore: grouped.nextBefore
  };
}

export type MessageView = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  text: string;
  at: Date | null;
  /** Enviada pelo app do celular ("via app") ou recebida. */
  origin: "app" | "received";
  edited: boolean;
  /** Edição cifrada no WhatsApp: o texto mostrado é o original, o novo não é legível. */
  editedTextUnavailable: boolean;
  deletedInWhatsApp: boolean;
  /** Só em áudio com a transcrição já pedida: estado e, quando pronta, o texto. */
  transcription: TranscriptionView | null;
};

export type TranscriptionView = { status: TranscriptionStatus; text?: string; reason?: TranscriptionReason };

/** Estado da transcrição para a tela: o texto só quando pronta; tentativas, data e modelo ficam de fora. */
export const toTranscriptionView = (mediaMetadata: Prisma.JsonValue | null | undefined): TranscriptionView | null => {
  const state = transcriptionOf(mediaMetadata);
  if (!state || !["pending", "done", "failed", "skipped"].includes(state.status)) return null;
  return {
    status: state.status,
    ...(state.status === "done" ? { text: typeof state.text === "string" ? state.text : "" } : {}),
    ...(state.status !== "done" && typeof state.reason === "string" ? { reason: state.reason } : {})
  };
};

const metadataOf = (value: Prisma.JsonValue | null) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const toMessageView = (row: {
  id: string;
  direction: CommunicationDirection;
  type: string;
  textContent: string | null;
  providerTimestamp: Date | null;
  metadata: Prisma.JsonValue | null;
  mediaMetadata?: Prisma.JsonValue | null;
}): MessageView => {
  const metadata = metadataOf(row.metadata);
  const outbound = row.direction === CommunicationDirection.OUTBOUND;
  return {
    id: row.id,
    direction: outbound ? "outbound" : "inbound",
    type: row.type,
    text: row.textContent ?? "",
    at: row.providerTimestamp,
    origin: outbound ? "app" : "received",
    edited: Boolean(metadata.editedAt),
    editedTextUnavailable: Boolean(metadata.editedInWhatsAppAt),
    deletedInWhatsApp: Boolean(metadata.deletedInWhatsAppAt),
    transcription: row.type === "AUDIO" ? toTranscriptionView(row.mediaMetadata) : null
  };
};

/** Mensagens de uma conversa num dia de Brasília (a partir de `since`, se for depois do início do dia). */
export async function readConversationDayMessages(
  input: { conversationId: string; day: string; since?: Date | null; cursor?: string | null },
  db: Pick<PrismaClient, "communicationMessage"> = defaultPrisma
): Promise<{ items: MessageView[]; nextCursor: string | null }> {
  const start = brazilDayStart(input.day);
  if (!start) throw new Error("whatsapp_day_invalid");
  const lower = input.since && input.since > start ? input.since : start;
  const rows = await db.communicationMessage.findMany({
    where: {
      conversationId: input.conversationId,
      provider: EVOLUTION_PROVIDER,
      providerTimestamp: { gte: lower, lt: new Date(start.getTime() + DAY_MS) }
    },
    orderBy: [{ providerTimestamp: "asc" }, { id: "asc" }],
    take: MESSAGES_PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: { id: true, direction: true, type: true, textContent: true, providerTimestamp: true, metadata: true, mediaMetadata: true }
  });
  const page = rows.slice(0, MESSAGES_PAGE);
  return { items: page.map(toMessageView), nextCursor: rows.length > MESSAGES_PAGE ? page[page.length - 1].id : null };
}
