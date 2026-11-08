import type { WhatsAppCrmRecipientRefusal } from "@salesforce-pro/shared";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { normalizeMobilePhone } from "./phoneMatch.js";

// Único destino aceito pelo envio do EvolutionClient: o celular (User.phone) de um usuário ATIVO do CRM, lido
// do banco na hora do envio. O destino é um objeto emitido só por resolveCrmUserRecipient (registrado num
// WeakSet deste módulo), válido por pouco tempo: um objeto montado à mão, mesmo com cast de tipo, é recusado.
// O celular também não pode estar no índice de telefones de cliente (ClientPhoneIndex): se estiver, recusa.
// Nunca grava log: número e nome não saem daqui.

export type CrmUserRecipient = { readonly userId: string; readonly phone: string };
export type CrmUserRecipientResolution = { ok: true; recipient: CrmUserRecipient } | { ok: false; reason: WhatsAppCrmRecipientRefusal };

/** Validade do destino emitido: a checagem é sempre recente. */
export const CRM_USER_RECIPIENT_TTL_MS = 2 * 60_000;

const issuedAt = new WeakMap<object, number>();

type RecipientDb = {
  user: { findUnique(args: unknown): Promise<{ id: string; isActive: boolean; phone: string | null } | null> };
  clientPhoneIndex: { count(args: unknown): Promise<number> };
};

export async function resolveCrmUserRecipient(
  userId: string,
  db: RecipientDb = defaultPrisma as unknown as RecipientDb,
  now = Date.now
): Promise<CrmUserRecipientResolution> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, phone: true } });
  if (!user) return { ok: false, reason: "user_not_found" };
  if (!user.isActive) return { ok: false, reason: "user_inactive" };
  if (!user.phone?.trim()) return { ok: false, reason: "no_phone" };
  const phone = normalizeMobilePhone(user.phone);
  if (!phone) return { ok: false, reason: "invalid_phone" };
  // Cliente arquivado também conta: o número não pode ser de cliente nenhum.
  if ((await db.clientPhoneIndex.count({ where: { phone } })) > 0) return { ok: false, reason: "phone_matches_client" };
  const recipient: CrmUserRecipient = Object.freeze({ userId: user.id, phone });
  issuedAt.set(recipient, now());
  return { ok: true, recipient };
}

/** Destino emitido por resolveCrmUserRecipient há menos de CRM_USER_RECIPIENT_TTL_MS. */
export function isCrmUserRecipient(value: unknown, now = Date.now()): value is CrmUserRecipient {
  if (typeof value !== "object" || value === null) return false;
  const at = issuedAt.get(value);
  return at !== undefined && now - at <= CRM_USER_RECIPIENT_TTL_MS;
}
