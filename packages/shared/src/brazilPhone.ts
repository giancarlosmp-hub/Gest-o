// Telefones brasileiros vindos do ERP ou digitados no CRM: normaliza para 55 + DDD + número e gera os links
// de ligação (tel:) e de WhatsApp (wa.me). Número sem DDD, com DDD inválido ou de tamanho estranho não ganha
// link: o DDD nunca é deduzido pela cidade.

const VALID_BRAZIL_DDDS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99"
]);

export type BrazilPhoneKind = "mobile" | "landline";

export type BrazilPhone =
  | {
      valid: true;
      kind: BrazilPhoneKind;
      /** 55 + DDD + número, só dígitos. */
      e164: string;
      /** "(DD) 9NNNN-NNNN" ou "(DD) NNNN-NNNN". */
      display: string;
      tel: string;
      whatsapp: string;
      /** Celular antigo de 8 dígitos que recebeu o nono dígito. */
      insertedNinthDigit: boolean;
    }
  | { valid: false; display: string; tel: null; whatsapp: null };

const invalid = (raw: string): BrazilPhone => ({ valid: false, display: raw.replace(/\s+/g, " ").trim(), tel: null, whatsapp: null });

export const normalizeBrazilPhone = (raw: string): BrazilPhone => {
  let digits = raw.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);

  const ddd = digits.slice(0, 2);
  let subscriber = digits.slice(2);
  if (!VALID_BRAZIL_DDDS.has(ddd)) return invalid(raw);

  let kind: BrazilPhoneKind;
  let insertedNinthDigit = false;
  if (subscriber.length === 8 && /^[2-5]/.test(subscriber)) {
    kind = "landline";
  } else if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    kind = "mobile";
    subscriber = `9${subscriber}`;
    insertedNinthDigit = true;
  } else if (subscriber.length === 9 && subscriber.startsWith("9")) {
    kind = "mobile";
  } else {
    return invalid(raw);
  }

  const e164 = `55${ddd}${subscriber}`;
  const display = `(${ddd}) ${subscriber.slice(0, -4)}-${subscriber.slice(-4)}`;
  return { valid: true, kind, e164, display, tel: `tel:+${e164}`, whatsapp: `https://wa.me/${e164}`, insertedNinthDigit };
};

// Separadores de vários números no mesmo campo. Espaço não separa: "DD 9 NNNN-NNNN" é um número só.
const PHONE_SEPARATOR = /\s*(?:[\/;,|\n\r]|\s+e\s+|\s+ou\s+)\s*/i;

export const splitPhoneField = (value: unknown): string[] =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
        .split(PHONE_SEPARATOR)
        .map((part) => part.trim())
        .filter((part) => /\d/.test(part))
    : [];
