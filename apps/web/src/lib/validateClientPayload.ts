export type ClientPayloadInput = {
  name?: unknown;
  city?: unknown;
  state?: unknown;
  region?: unknown;
  potentialHa?: unknown;
  farmSizeHa?: unknown;
  clientType?: unknown;
  cnpj?: unknown;
  segment?: unknown;
  ownerSellerId?: unknown;
};

export type ClientValidationOptions = {
  isSeller: boolean;
  canChooseOwnerSeller: boolean;
  sellerId?: string;
};

export type ClientValidationResult = {
  sanitizedPayload: Record<string, unknown>;
  fieldErrors: Partial<Record<keyof ClientPayloadInput, string>>;
};

const toTrimmedString = (value: unknown) => String(value ?? "").trim();

const normalizeOptionalString = (value: unknown) => {
  const normalized = toTrimmedString(value);
  return normalized || undefined;
};

const normalizeOptionalNumber = (value: unknown): number | undefined | "invalid" => {
  if (value === null || value === undefined || value === "") return undefined;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "invalid";
  }

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : "invalid";
};

export function validateClientPayload(payload: ClientPayloadInput, options: ClientValidationOptions): ClientValidationResult {
  const fieldErrors: Partial<Record<keyof ClientPayloadInput, string>> = {};

  const name = toTrimmedString(payload.name);
  const city = toTrimmedString(payload.city);
  const state = toTrimmedString(payload.state).toUpperCase();
  const clientTypeRaw = toTrimmedString(payload.clientType);
  const clientType = clientTypeRaw.toUpperCase();
  const region = normalizeOptionalString(payload.region);
  const segment = normalizeOptionalString(payload.segment);
  const ownerSellerIdInput = normalizeOptionalString(payload.ownerSellerId);

  const potentialHa = normalizeOptionalNumber(payload.potentialHa);
  const farmSizeHa = normalizeOptionalNumber(payload.farmSizeHa);

  const cnpjDigits = toTrimmedString(payload.cnpj).replace(/\D/g, "");
  const cnpj = cnpjDigits || undefined;

  const resolvedOwnerSellerId = options.isSeller
    ? (options.sellerId ? options.sellerId.trim() : "")
    : ownerSellerIdInput;

  if (!name) fieldErrors.name = "Nome é obrigatório.";
  if (!city) fieldErrors.city = "Cidade é obrigatória.";

  if (!state) {
    fieldErrors.state = "UF é obrigatória.";
  } else if (state.length !== 2) {
    fieldErrors.state = "UF deve conter exatamente 2 caracteres.";
  }

  if (!clientType) {
    fieldErrors.clientType = "Tipo de cliente é obrigatório.";
  } else if (!["PJ", "PF"].includes(clientType)) {
    fieldErrors.clientType = "Tipo de cliente deve ser PJ ou PF.";
  }

  if (potentialHa === "invalid") {
    fieldErrors.potentialHa = "Potencial (ha) deve ser um número válido.";
  } else if (typeof potentialHa === "number" && potentialHa < 0) {
    fieldErrors.potentialHa = "Potencial (ha) deve ser maior ou igual a 0.";
  }

  if (farmSizeHa === "invalid") {
    fieldErrors.farmSizeHa = "Área total (ha) deve ser um número válido.";
  } else if (typeof farmSizeHa === "number" && farmSizeHa < 0) {
    fieldErrors.farmSizeHa = "Área total (ha) deve ser maior ou igual a 0.";
  }

  if (!options.isSeller && options.canChooseOwnerSeller && !resolvedOwnerSellerId) {
    fieldErrors.ownerSellerId = "Vendedor responsável é obrigatório.";
  }

  if (options.isSeller && !resolvedOwnerSellerId) {
    fieldErrors.ownerSellerId = "Não foi possível identificar o vendedor responsável.";
  }

  const sanitizedPayload: Record<string, unknown> = {
    name,
    city,
    state,
    clientType,
    region,
    potentialHa: potentialHa === "invalid" ? undefined : potentialHa,
    farmSizeHa: farmSizeHa === "invalid" ? undefined : farmSizeHa,
    cnpj,
    segment,
    ownerSellerId: resolvedOwnerSellerId || undefined
  };

  return { sanitizedPayload, fieldErrors };
}
