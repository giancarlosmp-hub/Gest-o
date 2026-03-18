const CNPJ_LENGTH = 14;

export const normalizeCnpjDigits = (value?: string | null) => String(value ?? "").replace(/\D/g, "");

export const formatCnpj = (value?: string | null) => {
  const digits = normalizeCnpjDigits(value);
  if (digits.length !== CNPJ_LENGTH) return digits;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

export const isValidCnpj = (value?: string | null) => {
  const digits = normalizeCnpjDigits(value);
  if (digits.length !== CNPJ_LENGTH) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  let length = CNPJ_LENGTH - 2;
  let numbers = digits.substring(0, length);
  const verifiers = digits.substring(length);
  let sum = 0;
  let position = length - 7;

  for (let index = length; index >= 1; index -= 1) {
    sum += Number(numbers.charAt(length - index)) * position;
    position = position === 2 ? 9 : position - 1;
  }

  let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== Number(verifiers.charAt(0))) return false;

  length += 1;
  numbers = digits.substring(0, length);
  sum = 0;
  position = length - 7;

  for (let index = length; index >= 1; index -= 1) {
    sum += Number(numbers.charAt(length - index)) * position;
    position = position === 2 ? 9 : position - 1;
  }

  result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  return result === Number(verifiers.charAt(1));
};

export const parseCnpj = (value?: string | null) => {
  const digits = normalizeCnpjDigits(value);

  if (!digits) {
    return { ok: false as const, reason: "empty", digits };
  }

  if (digits.length !== CNPJ_LENGTH) {
    return { ok: false as const, reason: "length", digits };
  }

  if (!isValidCnpj(digits)) {
    return { ok: false as const, reason: "invalid", digits };
  }

  return {
    ok: true as const,
    digits,
    formatted: formatCnpj(digits),
  };
};
