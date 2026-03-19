import { env } from "../config/env.js";
import { formatCnpj, normalizeCnpjDigits } from "../utils/cnpj.js";

const ensureTrailingSlash = (value: string) => (value.endsWith("/") ? value : `${value}/`);
const maskCnpjForLogs = (value: string) => `***${value.slice(-4)}`;

type UnknownRecord = Record<string, unknown>;

type CnpjLookupSource = "brasilapi" | "receitaws";

type CnpjLookupErrorCode =
  | "CNPJ_LOOKUP_DISABLED"
  | "CNPJ_LOOKUP_MISCONFIGURED"
  | "CNPJ_LOOKUP_UNSUPPORTED_PROVIDER"
  | "CNPJ_LOOKUP_NOT_FOUND"
  | "CNPJ_LOOKUP_PROVIDER_UNAVAILABLE"
  | "CNPJ_LOOKUP_PROVIDER_ERROR";

export type CnpjLookupPayload = {
  name: string | null;
  tradeName: string | null;
  city: string | null;
  state: string | null;
  status: string | null;
  source: CnpjLookupSource | null;
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
  provider: string;
};

type CnpjLookupProvider = {
  lookup: (cnpj: string) => Promise<CnpjLookupProviderResult>;
};

const DEFAULT_PROVIDER = "generic";
const BRASIL_API_PROVIDER = "brasilapi";
const RECEITA_WS_PROVIDER = "receitaws";
const CNPJ_LOOKUP_PROVIDER_TIMEOUT_MS = 3_000;

export class CnpjLookupError extends Error {
  constructor(
    message: string,
    readonly code: CnpjLookupErrorCode,
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
  if (!isRecord(payload)) {
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      return trimmed || null;
    }
    return null;
  }

  return getFirstScalarString(payload, [
    ["message"],
    ["error"],
    ["errors", "0", "message"],
    ["detail"],
    ["descricao"],
    ["status", "text"],
    ["status"],
  ]);
};

const isNotFoundMessage = (value: string | null) => {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(
    normalized &&
      (normalized.includes("não encontrada") ||
        normalized.includes("nao encontrada") ||
        normalized.includes("não encontrado") ||
        normalized.includes("nao encontrado") ||
        normalized.includes("not found") ||
        normalized.includes("não localizado") ||
        normalized.includes("nao localizado"))
  );
};

const isReceitaWsDeclaredError = (payload: UnknownRecord) => {
  const providerStatus = getFirstScalarString(payload, [["status"]]);
  return providerStatus?.trim().toUpperCase() === "ERROR";
};

const buildStandardPayload = (
  cnpj: string,
  payload: UnknownRecord,
  source: CnpjLookupSource | null = null
): CnpjLookupPayload => {
  const normalizedCnpj = normalizeCnpjDigits(
    getFirstScalarString(payload, [["cnpj"], ["documento"], ["document"], ["taxId"], ["company", "document"]]) || cnpj
  );

  const razaoSocial = getFirstScalarString(payload, [["razao_social"], ["razaoSocial"], ["nome"], ["name"], ["company", "name"]]);
  const nome = getFirstScalarString(payload, [["nome"], ["name"], ["razao_social"], ["razaoSocial"], ["company", "name"]]);
  const nomeFantasia = getFirstScalarString(payload, [
    ["nome_fantasia"],
    ["nomeFantasia"],
    ["fantasia"],
    ["tradeName"],
    ["company", "tradeName"],
  ]);
  const cidade = getFirstScalarString(payload, [["cidade"], ["municipio"], ["city"], ["address", "city"], ["address", "municipio"]]);
  const uf = getFirstScalarString(payload, [["uf"], ["estado"], ["state"], ["address", "state"], ["address", "uf"]]);
  const situacao = getFirstScalarString(payload, [["situacao"], ["descricao_situacao_cadastral"], ["status"], ["company", "status"]]);

  return {
    name: razaoSocial || nome,
    tradeName: nomeFantasia,
    city: cidade,
    state: uf,
    status: situacao,
    source,
    cnpj: formatCnpj(normalizedCnpj || cnpj),
    razaoSocial,
    nome,
    nomeFantasia,
    logradouro: getFirstScalarString(payload, [["logradouro"], ["street"], ["address", "street"], ["address", "logradouro"]]),
    numero: getFirstScalarString(payload, [["numero"], ["addressNumber"], ["address", "number"], ["address", "numero"]]),
    complemento: getFirstScalarString(payload, [["complemento"], ["address", "details"], ["address", "complemento"]]),
    bairro: getFirstScalarString(payload, [["bairro"], ["district"], ["address", "district"], ["address", "bairro"]]),
    cidade,
    uf,
    cep: getFirstScalarString(payload, [["cep"], ["postalCode"], ["address", "zip"], ["address", "cep"]]),
    telefone: getFirstJoinedString(payload, [
      ["telefone"],
      ["phone"],
      ["phones"],
      ["ddd_telefone_1"],
      ["ddd_telefone_2"],
      ["contato", "telefone"],
      ["contact", "phone"],
    ]),
    email: getFirstJoinedString(payload, [["email"], ["emails"], ["contato", "email"], ["contact", "email"]]),
    situacao,
    inscricaoEstadual: getFirstJoinedString(payload, [
      ["inscricao_estadual"],
      ["inscricaoEstadual"],
      ["ie"],
      ["stateRegistration"],
      ["stateRegistrations"],
    ]),
  };
};

const resolveRequestUrl = (baseUrl: string, cnpj: string) => {
  const trimmedBaseUrl = baseUrl.trim();
  if (!trimmedBaseUrl) {
    throw new CnpjLookupError(
      "Integração de consulta de CNPJ incompleta. Configure CNPJ_LOOKUP_BASE_URL no backend.",
      "CNPJ_LOOKUP_MISCONFIGURED",
      503
    );
  }

  if (trimmedBaseUrl.includes("{{cnpj}}")) {
    return trimmedBaseUrl.split("{{cnpj}}").join(encodeURIComponent(cnpj));
  }

  if (trimmedBaseUrl.includes("{cnpj}")) {
    return trimmedBaseUrl.split("{cnpj}").join(encodeURIComponent(cnpj));
  }

  return new URL(cnpj, ensureTrailingSlash(trimmedBaseUrl)).toString();
};

const createProviderErrorFromResponse = (
  providerName: string,
  providerStatus: number,
  raw: unknown,
  cnpj: string
) => {
  const message = extractErrorMessage(raw);

  if (providerStatus === 404 || isNotFoundMessage(message)) {
    return new CnpjLookupError("Empresa não encontrada para o CNPJ informado.", "CNPJ_LOOKUP_NOT_FOUND", 404, {
      provider: providerName,
      providerStatus,
      cnpj: maskCnpjForLogs(cnpj),
    });
  }

  if (providerStatus === 429 || providerStatus >= 500) {
    return new CnpjLookupError(
      "O provedor de CNPJ está indisponível no momento. Tente novamente em instantes.",
      "CNPJ_LOOKUP_PROVIDER_UNAVAILABLE",
      502,
      {
        provider: providerName,
        providerStatus,
        cnpj: maskCnpjForLogs(cnpj),
      }
    );
  }

  return new CnpjLookupError(
    message || "A consulta de CNPJ falhou no provedor externo.",
    "CNPJ_LOOKUP_PROVIDER_ERROR",
    502,
    {
      provider: providerName,
      providerStatus,
      cnpj: maskCnpjForLogs(cnpj),
    }
  );
};

const fetchProviderPayload = async (
  providerName: string,
  requestUrl: string,
  cnpj: string,
  requestHeaders: Record<string, string> = {}
) => {
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...requestHeaders,
      },
      signal: AbortSignal.timeout(CNPJ_LOOKUP_PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CnpjLookupError(
      "Não foi possível consultar o provedor de CNPJ no momento.",
      "CNPJ_LOOKUP_PROVIDER_UNAVAILABLE",
      502,
      {
        provider: providerName,
        cnpj: maskCnpjForLogs(cnpj),
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const raw = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw createProviderErrorFromResponse(providerName, response.status, raw, cnpj);
  }

  if (!isRecord(raw)) {
    throw new CnpjLookupError(
      "O provedor de CNPJ retornou um formato inesperado.",
      "CNPJ_LOOKUP_PROVIDER_ERROR",
      502,
      {
        provider: providerName,
        cnpj: maskCnpjForLogs(cnpj),
      }
    );
  }

  if (providerName === RECEITA_WS_PROVIDER && isReceitaWsDeclaredError(raw)) {
    throw createProviderErrorFromResponse(
      providerName,
      isNotFoundMessage(extractErrorMessage(raw)) ? 404 : 502,
      raw,
      cnpj
    );
  }

  return raw;
};

const createGenericProvider = (): CnpjLookupProvider => ({
  async lookup(cnpj: string) {
    const requestUrl = resolveRequestUrl(env.cnpjLookupBaseUrl, cnpj);
    const headers: Record<string, string> = {};

    if (env.cnpjLookupApiKey) {
      headers.Authorization = `Bearer ${env.cnpjLookupApiKey}`;
      headers["X-API-Key"] = env.cnpjLookupApiKey;
    }

    const raw = await fetchProviderPayload(DEFAULT_PROVIDER, requestUrl, cnpj, headers);

    return {
      payload: buildStandardPayload(cnpj, raw),
      raw,
      provider: DEFAULT_PROVIDER,
    };
  },
});

const createBrasilApiProvider = (): CnpjLookupProvider => ({
  async lookup(cnpj: string) {
    const requestUrl = resolveRequestUrl(env.cnpjLookupBaseUrl || "https://brasilapi.com.br/api/cnpj/v1/{cnpj}", cnpj);
    const raw = await fetchProviderPayload(BRASIL_API_PROVIDER, requestUrl, cnpj);

    return {
      payload: buildStandardPayload(cnpj, raw, BRASIL_API_PROVIDER),
      raw,
      provider: BRASIL_API_PROVIDER,
    };
  },
});

const createReceitaWsProvider = (): CnpjLookupProvider => ({
  async lookup(cnpj: string) {
    const requestUrl = `https://www.receitaws.com.br/v1/cnpj/${encodeURIComponent(cnpj)}`;
    const raw = await fetchProviderPayload(RECEITA_WS_PROVIDER, requestUrl, cnpj);

    return {
      payload: buildStandardPayload(cnpj, raw, RECEITA_WS_PROVIDER),
      raw,
      provider: RECEITA_WS_PROVIDER,
    };
  },
});

const providerFactories: Record<string, () => CnpjLookupProvider> = {
  [DEFAULT_PROVIDER]: createGenericProvider,
  [BRASIL_API_PROVIDER]: createBrasilApiProvider,
  [RECEITA_WS_PROVIDER]: createReceitaWsProvider,
};

const getProvider = () => {
  const providerName = env.cnpjLookupProvider.trim().toLowerCase();

  if (!providerName) {
    throw new CnpjLookupError(
      "Integração de consulta de CNPJ não está habilitada. Configure CNPJ_LOOKUP_PROVIDER no backend.",
      "CNPJ_LOOKUP_DISABLED",
      503
    );
  }

  const providerFactory = providerFactories[providerName];

  if (!providerFactory) {
    throw new CnpjLookupError(
      `Provedor de consulta de CNPJ não suportado: ${env.cnpjLookupProvider}.`,
      "CNPJ_LOOKUP_UNSUPPORTED_PROVIDER",
      503,
      { supportedProviders: Object.keys(providerFactories) }
    );
  }

  if (providerName === DEFAULT_PROVIDER && !env.cnpjLookupBaseUrl.trim()) {
    throw new CnpjLookupError(
      "Integração de consulta de CNPJ incompleta. Configure CNPJ_LOOKUP_BASE_URL no backend.",
      "CNPJ_LOOKUP_MISCONFIGURED",
      503,
      { provider: providerName }
    );
  }

  return providerFactory();
};

const shouldFallbackFromBrasilApi = (error: CnpjLookupError) => {
  if (error.code === "CNPJ_LOOKUP_PROVIDER_UNAVAILABLE") return true;

  const providerStatus = typeof error.details?.providerStatus === "number" ? error.details.providerStatus : null;
  return providerStatus === 403 || providerStatus === 429;
};

export const cnpjLookupService = {
  async lookup(cnpj: string) {
    const providerName = env.cnpjLookupProvider.trim().toLowerCase();
    const provider = getProvider();

    if (providerName !== BRASIL_API_PROVIDER) {
      return provider.lookup(cnpj);
    }

    try {
      const result = await provider.lookup(cnpj);
      console.info("[cnpj-lookup] provider=brasilapi success", {
        cnpjSuffix: cnpj.slice(-4),
      });
      return result;
    } catch (error) {
      if (!(error instanceof CnpjLookupError) || !shouldFallbackFromBrasilApi(error)) {
        throw error;
      }

      const providerStatus = typeof error.details?.providerStatus === "number" ? error.details.providerStatus : null;
      console.warn(`[cnpj-lookup] provider=brasilapi failed ${providerStatus ?? "network"} → fallback=receitaws`, {
        cnpjSuffix: cnpj.slice(-4),
        code: error.code,
        details: error.details,
      });

      const fallbackProvider = createReceitaWsProvider();
      const fallbackResult = await fallbackProvider.lookup(cnpj);
      console.info("[cnpj-lookup] provider=receitaws success", {
        cnpjSuffix: cnpj.slice(-4),
      });
      return fallbackResult;
    }
  },
};
