import { createHash } from "node:crypto";

const VALID_BRAZIL_DDDS = new Set(["11","12","13","14","15","16","17","18","19","21","22","24","27","28","31","32","33","34","35","37","38","41","42","43","44","45","46","47","48","49","51","53","54","55","61","62","63","64","65","66","67","68","69","71","73","74","75","77","79","81","82","83","84","85","86","87","88","89","91","92","93","94","95","96","97","98","99"]);

export const hashContact = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export const hashPhoneForTenant = (tenantId: string, normalizedPhone: string) => createHash("sha256").update(`${tenantId}:${normalizedPhone}`).digest("hex");
export const maskContact = (value: string | undefined) => value ? `${value.slice(0, 3)}***${value.slice(-2)}` : undefined;

export function normalizeBrazilianPhone(input: string | undefined) {
  if (!input) return { status: "invalid" as const, reason: "missing_contact" };
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return { status: "invalid" as const, reason: "missing_digits" };

  let national = digits;
  if (digits.startsWith("55")) national = digits.slice(2);
  else if (hadPlus) return { status: "invalid" as const, reason: "unsupported_country_code", contactHash: hashContact(digits) };

  if (![10, 11].includes(national.length)) return { status: "invalid" as const, reason: "invalid_brazilian_length", contactHash: hashContact(digits) };
  const ddd = national.slice(0, 2);
  if (!VALID_BRAZIL_DDDS.has(ddd)) return { status: "invalid" as const, reason: "invalid_ddd", contactHash: hashContact(digits) };
  const subscriber = national.slice(2);
  if (subscriber.length === 9 && subscriber[0] !== "9") return { status: "ambiguous" as const, reason: "ambiguous_mobile_digit", contactHash: hashContact(digits) };

  const normalized = `+55${national}`;
  return { status: "valid" as const, normalized, display: `+55 ${ddd} ${subscriber}`, countryCode: "55", contactHash: hashContact(normalized) };
}
