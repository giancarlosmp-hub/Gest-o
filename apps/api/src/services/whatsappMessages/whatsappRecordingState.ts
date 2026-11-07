import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { isWhatsAppMessagesEnabled } from "../whatsappConnection/config.js";

// WhatsApp Fase B2: desde quando a gravação das conversas está ligada ou desligada, para o cartão "Meu
// número". A flag vem do ambiente e só muda com a API reiniciando: na subida, se o estado gravado em
// AppConfig for diferente da flag atual, grava o novo estado com a data da subida. Sem migration (a tabela
// AppConfig já existe). O primeiro registro marca a data em que o acompanhamento começou.

export const RECORDING_STATE_KEY = "whatsapp_messages_recording_state";

export type RecordingState = { enabled: boolean; since: string };

type StateDb = Pick<PrismaClient, "appConfig">;

export const parseRecordingState = (value: string | null | undefined): RecordingState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RecordingState>;
    if (typeof parsed.enabled !== "boolean" || typeof parsed.since !== "string" || Number.isNaN(Date.parse(parsed.since))) return null;
    return { enabled: parsed.enabled, since: parsed.since };
  } catch {
    return null;
  }
};

export async function readRecordingState(db: StateDb = defaultPrisma) {
  const row = await db.appConfig.findUnique({ where: { key: RECORDING_STATE_KEY }, select: { value: true } });
  return parseRecordingState(row?.value);
}

/** Na subida da API: grava o estado só quando ele mudou (ou ainda não existe). */
export async function syncRecordingState(enabled = isWhatsAppMessagesEnabled(), now = new Date(), db: StateDb = defaultPrisma) {
  const current = await readRecordingState(db);
  if (current && current.enabled === enabled) return { changed: false, state: current };
  const state: RecordingState = { enabled, since: now.toISOString() };
  const value = JSON.stringify(state);
  await db.appConfig.upsert({ where: { key: RECORDING_STATE_KEY }, create: { key: RECORDING_STATE_KEY, value }, update: { value } });
  return { changed: true, state };
}

/**
 * Data do "ligada/desligada desde" para um usuário: com a gravação ligada e o número conectado depois da
 * ligação, vale a data da conexão (antes dela nada do número era gravado). Estado gravado diferente da flag
 * (a sincronização da subida falhou): sem data.
 */
export function recordingSinceFor(input: { enabled: boolean; state: RecordingState | null; connectedAt: Date | null }): Date | null {
  const since = input.state && input.state.enabled === input.enabled ? new Date(input.state.since) : null;
  if (input.enabled && input.connectedAt && (!since || input.connectedAt > since)) return input.connectedAt;
  return since;
}
