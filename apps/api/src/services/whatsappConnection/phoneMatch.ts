import { normalizeBrazilPhone } from "@salesforce-pro/shared";

// O número lido no QR só é aceito se for o celular cadastrado no usuário (User.phone). Os dois lados passam
// pela mesma regra compartilhada: contas antigas do WhatsApp chegam sem o nono dígito e ganham o 9 aqui.

/** Celular brasileiro em 55 + DDD + número, ou null. */
export function normalizeMobilePhone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const phone = normalizeBrazilPhone(value);
  return phone.valid && phone.kind === "mobile" ? phone.e164 : null;
}

/**
 * Número de uma conta do WhatsApp ("5511900000000@s.whatsapp.net", às vezes com ":N" do aparelho).
 * Identificador sem número (LID, grupo) devolve null: sem número legível, a conexão é recusada.
 */
export function phoneFromWhatsAppJid(jid: unknown): string | null {
  if (typeof jid !== "string") return null;
  const [user, server, ...rest] = jid.trim().split("@");
  if (rest.length || server !== "s.whatsapp.net" || !user) return null;
  const digits = user.split(":")[0];
  if (!/^55\d{10,11}$/.test(digits)) return null;
  return normalizeMobilePhone(digits);
}

/**
 * Telefone brasileiro de um contato do WhatsApp em 55 + DDD + número: celular (com o nono dígito) ou fixo
 * (WhatsApp Business num número fixo). Mesma regra compartilhada; o resto vira null.
 */
export function normalizeWhatsAppContactPhone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const phone = normalizeBrazilPhone(value);
  return phone.valid ? phone.e164 : null;
}

/**
 * Número do contato de uma conversa ("55DDNNNNNNNN@s.whatsapp.net", com ou sem o nono dígito, às vezes com
 * ":N" do aparelho). Grupo, status, lista de transmissão, canal, LID e número de fora do Brasil: null.
 */
export function contactPhoneFromWhatsAppJid(jid: unknown): string | null {
  if (typeof jid !== "string") return null;
  const [user, server, ...rest] = jid.trim().split("@");
  if (rest.length || server !== "s.whatsapp.net" || !user) return null;
  const digits = user.split(":")[0];
  if (!/^55\d{10,11}$/.test(digits)) return null;
  return normalizeWhatsAppContactPhone(digits);
}

/** "(DD) 9****-NNNN": para listas vistas por outras pessoas. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164 || !/^55\d{11}$/.test(e164)) return null;
  return `(${e164.slice(2, 4)}) ${e164.slice(4, 5)}****-${e164.slice(-4)}`;
}

/** "(DD) 9NNNN-NNNN": o próprio número, só para o dono. */
export function displayPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const phone = normalizeBrazilPhone(e164);
  return phone.valid ? phone.display : null;
}
