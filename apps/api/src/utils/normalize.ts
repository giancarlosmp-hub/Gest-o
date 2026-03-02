export const normalizeCnpj = (value?: string | null) => String(value ?? "").replace(/\D/g, "");

export const normalizeText = (value?: string | null) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export const normalizeState = (value?: string | null) => String(value ?? "").trim().toUpperCase();
