import { env } from "../config/env.js";
import { formatCnpj, normalizeCnpjDigits } from "../utils/cnpj.js";

const ensureTrailingSlash = (value: string) => (value.endsWith("/") ? value : `${value}/`);

type UnknownRecord = Record<string, unknown>;

export type CnpjLookupPayload = {
  cnpj: string;
  razaoSocial: string | null;
  nome: string | null;
  nomeFantasia: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  email: string | null;
  situacao: string | null;
  inscricaoEstadual: string | null;
};

type CnpjLookupProviderResult = {
  payload: CnpjLookupPayload;
  raw: unknown;
};

type CnpjLookupProvider = {
  lookup: (cnpj: string) => Promise<CnpjLookupProviderResult>;
};

const DEFAULT_PROVIDER = "generic";

export class CnpjLookupError extends Error {
  constructor(
    message: string,
    readonly code: "CNPJ_LOOKUP_DISABLED" | "CNPJ_LOOKUP_UNSUPPORTED_PROVIDER" | "CNPJ_LOOKUP_PROVIDER_ERROR",
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CnpjLookupError";
  }
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const getNestedValue = (payload: UnknownRecord, path: string[]) => {
  let current: unknown = payload;

  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }

    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }

  return current;
};

const getFirstScalarString = (payload: UnknownRecord, paths: string[][]) => {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === "number") return String(value);
  }

  return null;
};

const getFirstJoinedString = (payload: UnknownRecord, paths: string[][]) => {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (Array.isArray(value)) {
      const joined = value
        .flatMap((item) => {
          if (typeof item === "string") return item.trim();
          if (typeof item === "number") return String(item);
          return [];
        })
        .filter(Boolean)
        .join(" / ");
      if (joined) return joined;
    }
  }

  return null;
};

const extractErrorMessage = (payload: unknown) => {
  if (!isRecord(payload)) return null;

  return getFirstScalarString(payload, [
    ["message"],
    ["error"],
    ["errors", "0", "message"],
    ["detail"],
    ["descricao"],
    ["status", "text"],
  ]);
};

const buildStandardPayload = (cnpj: string, payload: UnknownRecord): CnpjLookupPayload => {
  const normalizedCnpj = normalizeCnpjDigits(
    getFirstScalarString(payload, [["cnpj"], ["documento"], ["document"], ["taxId"], ["company", "document"]]) || cnpj
  );

  return {
    cnpj: formatCnpj(normalizedCnpj || cnpj),
    razaoSocial: getFirstScalarString(payload, [["razao_social"], ["razaoSocial"], ["nome"], ["name"], ["company", "name"]]),
    nome: getFirstScalarString(payload, [["nome"], ["name"], ["razao_social"], ["razaoSocial"], ["company", "name"]]),
    nomeFantasia: getFirstScalarString(payload, [
      ["nome_fantasia"],
      ["nomeFantasia"],
      ["fantasia"],
      ["tradeName"],
      ["company", "tradeName"],
    ]),
    logradouro: getFirstScalarString(payload, [["logradouro"], ["street"], ["address", "street"], ["address", "logradouro"]]),
    numero: getFirstScalarString(payload, [["numero"], ["addressNumber"], ["address", "number"], ["address", "numero"]]),
    complemento: getFirstScalarString(payload, [["complemento"], ["address", "details"], ["address", "complemento"]]),
    bairro: getFirstScalarString(payload, [["bairro"], ["district"], ["address", "district"], ["address", "bairro"]]),
    cidade: getFirstScalarString(payload, [["cidade"], ["municipio"], ["city"], ["address", "city"], ["address", "municipio"]]),
    uf: getFirstScalarString(payload, [["uf"], ["estado"], ["state"], ["address", "state"], ["address", "uf"]]),
    cep: getFirstScalarString(payload, [["cep"], ["postalCode"], ["address", "zip"], ["address", "cep"]]),
    telefone: getFirstJoinedString(payload, [
      ["telefone"],
      ["phone"],
      ["phones"],
      ["contato", "telefone"],
      ["contact", "phone"],
    ]),
    email: getFirstJoinedString(payload, [["email"], ["emails"], ["contato", "email"], ["contact", "email"]]),
    situacao: getFirstScalarString(payload, [["situacao"], ["status"], ["company", "status"]]),
    inscricaoEstadual: getFirstJoinedString(payload, [
      ["inscricao_estadual"],
      ["inscricaoEstadual"],
      ["ie"],
      ["stateRegistration"],
      ["stateRegistrations"],
    ]),
  };
};

const createGenericProvider = (): CnpjLookupProvider => ({
  async lookup(cnpj: string) {
    const requestUrl = new URL(cnpj, ensureTrailingSlash(env.cnpjLookupBaseUrl));

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${env.cnpjLookupApiKey}`,
          "X-API-Key": env.cnpjLookupApiKey,
        },
        signal: AbortSignal.timeout(env.apiRequestTimeoutMs),
      });
    } catch (error) {
      throw new CnpjLookupError("Não foi possível consultar o provedor de CNPJ no momento.", "CNPJ_LOOKUP_PROVIDER_ERROR", 502, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
      throw new CnpjLookupError(
        extractErrorMessage(raw) || "A consulta de CNPJ falhou no provedor externo.",
        "CNPJ_LOOKUP_PROVIDER_ERROR",
        502,
        { providerStatus: response.status }
      );
    }

    if (!isRecord(raw)) {
      throw new CnpjLookupError(
        "O provedor de CNPJ retornou um formato inesperado.",
        "CNPJ_LOOKUP_PROVIDER_ERROR",
        502
      );
    }

    return {
      payload: buildStandardPayload(cnpj, raw),
      raw,
    };
  },
});

const providerFactories: Record<string, () => CnpjLookupProvider> = {
  [DEFAULT_PROVIDER]: createGenericProvider,
};

const getProvider = () => {
  if (!env.cnpjLookupEnabled) {
    throw new CnpjLookupError(
      "Integração de consulta de CNPJ não está habilitada. Configure as variáveis CNPJ_LOOKUP_PROVIDER, CNPJ_LOOKUP_BASE_URL e CNPJ_LOOKUP_API_KEY.",
      "CNPJ_LOOKUP_DISABLED",
      503
    );
  }

  const providerName = env.cnpjLookupProvider.toLowerCase();
  const providerFactory = providerFactories[providerName];

  if (!providerFactory) {
    throw new CnpjLookupError(
      `Provedor de consulta de CNPJ não suportado: ${env.cnpjLookupProvider}.`,
      "CNPJ_LOOKUP_UNSUPPORTED_PROVIDER",
      503,
      { supportedProviders: Object.keys(providerFactories) }
    );
  }

  return providerFactory();
};

export const cnpjLookupService = {
  async lookup(cnpj: string) {
    const provider = getProvider();
    return provider.lookup(cnpj);
  },
};
