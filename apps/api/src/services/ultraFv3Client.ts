import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logApiEvent } from "../utils/logger.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

const ULTRAFV3_REQUEST_TIMEOUT_MS = 15_000;
export const ULTRAFV3_ORDER_REQUEST_TIMEOUT_MS = 10_000;
const ULTRAFV3_GET_RETRY_DELAY_MS = 500;
const RETRIABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type UltraFv3EnvVar =
  | "ULTRAFV3_BASE_URL"
  | "ULTRAFV3_USERNAME"
  | "ULTRAFV3_PASSWORD";
type UltraFv3AuthenticationStatus =
  | "missing_config"
  | "authenticated"
  | "not_authenticated";

export type UltraFv3Credentials = { username: string; password: string };
export type UltraFv3TokenPayload = {
  salesman: string | null;
  operator: string | null;
  branch: string | null;
  name: string | null;
  partner: string | null;
  exp: number | null;
};
export type UltraFv3LoginDiagnostic = {
  status: number;
  message: string;
  ultraResponse: unknown;
  correlationId: string;
};
export type UltraFv3RequestDiagnostic = {
  status: number;
  endpoint: string;
  method: string;
  message: string;
  ultraResponse: unknown;
  correlationId: string;
};

type UltraFv3AuthPayload = {
  token?: string;
  accessToken?: string;
  access_token?: string;
  expiresAt?: string;
  expires_at?: string;
  expiresIn?: number;
  expires_in?: number;
  operador?: unknown;
  operator?: unknown;
  vendedor?: unknown;
  salesman?: unknown;
};


const ULTRAFV3_APP_VERSION = "1.15.13";

const toNullableString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const formatUltraDocument = (rawValue: string) => {
  const trimmed = rawValue.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!trimmed) return "";
  if (/[.\-/]/.test(trimmed)) return trimmed;
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return trimmed;
};

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const sanitizeUltraTokenPayload = (token: string): UltraFv3TokenPayload => {
  const payload = decodeJwtPayload(token) ?? {};
  const first = (...keys: string[]) => keys.map((key) => payload[key]).find((value) => value !== undefined);
  const expRaw = first("exp");
  return {
    name: toNullableString(first("name", "nome")),
    salesman: toNullableString(first("salesman", "vendedor")),
    operator: toNullableString(first("operator", "operador")),
    branch: toNullableString(first("branch", "filial")),
    partner: toNullableString(first("partner", "parceiro")),
    exp: typeof expRaw === "number" && Number.isFinite(expRaw) ? expRaw : null,
  };
};

const maskBaseUrl = (value: string) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    if (url.search) url.search = "?***";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://***:***@");
  }
};

const maskCpfCnpjLogin = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "***";
  if (digits.length <= 4) return `${digits[0] ?? "*"}***`;
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
};

const extractUltraMessage = (payload: unknown, status: number) => {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== "object") return `UltraFV3 login falhou com status ${status}.`;
  const candidate = payload as Record<string, unknown>;
  const fields = [candidate.message, candidate.error, candidate.erro, candidate.Message, candidate.Retorno, candidate.details];
  for (const field of fields) {
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return `UltraFV3 login falhou com status ${status}.`;
};

export class UltraFv3IntegrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_credentials"
      | "unavailable"
      | "auth_failed"
      | "not_found"
      | "invalid_response"
      | "request_failed"
      | "timeout",
    readonly status?: number,
    readonly diagnostics?: UltraFv3LoginDiagnostic | UltraFv3RequestDiagnostic,
  ) {
    super(message);
    this.name = "UltraFv3IntegrationError";
  }
}

class UltraFv3Client {
  private token: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private erpOperator: unknown = null;
  private erpSalesman: unknown = null;
  private lastLoginAt: Date | null = null;
  private tokenPromise: Promise<string> | null = null;
  private lastError: string | null = null;
  private credentialTokenCache = new Map<string, { token: string; expiresAt: Date | null; tokenPayload: UltraFv3TokenPayload }>();

  private get baseUrl() {
    return env.ultraFv3BaseUrl.replace(/\/+$/, "");
  }

  private getMissingConfig(): UltraFv3EnvVar[] {
    const missing: UltraFv3EnvVar[] = [];
    if (!this.baseUrl) missing.push("ULTRAFV3_BASE_URL");
    if (!env.ultraFv3Username) missing.push("ULTRAFV3_USERNAME");
    if (!env.ultraFv3Password) missing.push("ULTRAFV3_PASSWORD");
    return missing;
  }

  hasGlobalCredentials() {
    return this.getMissingConfig().length === 0;
  }

  private ensureConfig() {
    const missing = this.getMissingConfig();
    if (missing.length > 0) {
      throw new UltraFv3IntegrationError(
        `Credenciais UltraFV3 não configuradas. Defina ${missing.join(", ")}.`,
        "missing_credentials",
      );
    }
  }

  getDiagnostics() {
    const missingConfig = this.getMissingConfig();
    const isConfigured = missingConfig.length === 0;
    const authenticationStatus: UltraFv3AuthenticationStatus = !isConfigured
      ? "missing_config"
      : this.token
        ? "authenticated"
        : "not_authenticated";
    return {
      baseUrl: this.baseUrl ? maskBaseUrl(this.baseUrl) : null,
      isConfigured,
      missingConfig,
      authenticationStatus,
      lastError: this.lastError,
      tokenExpiresAt: this.tokenExpiresAt?.toISOString() ?? null,
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
      tokenExpired: this.isTokenExpired(),
      erpOperator: this.erpOperator,
      erpSalesman: this.erpSalesman,
    };
  }

  private async safeJson(response: Response, allowPlainText = false) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (allowPlainText) return text;
      throw new UltraFv3IntegrationError(
        "UltraFV3 retornou uma resposta inválida (JSON malformado).",
        "invalid_response",
        response.status,
      );
    }
  }

  private buildTimeoutSignal(timeoutMs = ULTRAFV3_REQUEST_TIMEOUT_MS) {
    return AbortSignal.timeout(timeoutMs);
  }

  private isTokenExpired(expiresAt = this.tokenExpiresAt) {
    return Boolean(
      expiresAt &&
      expiresAt.getTime() <= Date.now() + 30_000,
    );
  }

  private getCredentialCacheKey(credentials: UltraFv3Credentials) {
    return createHash("sha256").update(credentials.username).digest("hex");
  }

  private resolveTokenExpiration(payload: UltraFv3AuthPayload) {
    const explicitExpiration = payload.expiresAt || payload.expires_at;
    if (explicitExpiration) {
      const parsed = new Date(explicitExpiration);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    const expiresInSeconds = Number(
      payload.expiresIn ?? payload.expires_in ?? 0,
    );
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
      return new Date(Date.now() + expiresInSeconds * 1000);
    }

    return null;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    context: { method: string; path: string; attempt: number; correlationId: string; timeoutMs?: number },
  ) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        ...init,
        signal: this.buildTimeoutSignal(context.timeoutMs),
      });
      logApiEvent(
        response.ok ? "INFO" : "WARN",
        "[ultrafv3 http] request completed",
        {
          method: context.method,
          path: context.path,
          attempt: context.attempt,
          correlationId: context.correlationId,
          status: response.status,
          durationMs: Date.now() - startedAt,
          timeoutMs: context.timeoutMs ?? ULTRAFV3_REQUEST_TIMEOUT_MS,
        },
      );
      return response;
    } catch (error) {
      const isTimeout = error instanceof Error && /abort|timeout|timed out/i.test(`${error.name} ${error.message}`);
      logApiEvent("ERROR", isTimeout ? "[ultrafv3 timeout] request timed out" : "[ultrafv3 http] request failed", {
        method: context.method,
        path: context.path,
        attempt: context.attempt,
        correlationId: context.correlationId,
        durationMs: Date.now() - startedAt,
        timeoutMs: context.timeoutMs ?? ULTRAFV3_REQUEST_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async login() {
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      this.ensureConfig();

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${this.baseUrl}/auth/login`,
          {
            method: "POST",
            headers: DEFAULT_HEADERS,
            body: JSON.stringify({
              username: env.ultraFv3Username,
              password: env.ultraFv3Password,
            }),
          },
          { method: "POST", path: "/auth/login", attempt: 1, correlationId: randomUUID() },
        );
      } catch (error) {
        throw new UltraFv3IntegrationError(
          `UltraFV3 fora do ar ou inacessível durante autenticação: ${error instanceof Error ? error.message : String(error)}`,
          "unavailable",
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new UltraFv3IntegrationError(
          "Erro de autenticação no UltraFV3. Verifique usuário e senha configurados.",
          "auth_failed",
          response.status,
        );
      }

      if (response.status === 404) {
        throw new UltraFv3IntegrationError(
          "Endpoint de autenticação do UltraFV3 inexistente: /auth/login.",
          "not_found",
          response.status,
        );
      }

      if (!response.ok) {
        throw new UltraFv3IntegrationError(
          `UltraFV3 login falhou com status ${response.status}.`,
          "request_failed",
          response.status,
        );
      }

      const payload = (await this.safeJson(
        response,
      )) as UltraFv3AuthPayload | null;
      const token =
        payload?.token || payload?.accessToken || payload?.access_token;

      if (!token) {
        throw new UltraFv3IntegrationError(
          "UltraFV3 autenticou, mas não retornou token de acesso.",
          "invalid_response",
          response.status,
        );
      }

      this.token = token;
      this.tokenExpiresAt = payload
        ? this.resolveTokenExpiration(payload)
        : null;
      this.erpOperator = payload?.operador ?? payload?.operator ?? null;
      this.erpSalesman = payload?.vendedor ?? payload?.salesman ?? null;
      this.lastLoginAt = new Date();
      logApiEvent("INFO", "[ultrafv3 auth] login succeeded", {
        lastLoginAt: this.lastLoginAt.toISOString(),
        tokenExpiresAt: this.tokenExpiresAt?.toISOString() ?? null,
      });
      return token;
    })();

    try {
      const token = await this.tokenPromise;
      this.lastError = null;
      return token;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async loginWithCredentials(credentials: UltraFv3Credentials) {
    if (!this.baseUrl) {
      throw new UltraFv3IntegrationError(
        "URL base UltraFV3 não configurada. Defina ULTRAFV3_BASE_URL.",
        "missing_credentials",
      );
    }
    const formattedDocument = formatUltraDocument(credentials.username);
    if (!formattedDocument || !credentials.password.trim()) {
      throw new UltraFv3IntegrationError(
        "Credenciais UltraFV3 do usuário incompletas.",
        "missing_credentials",
      );
    }

    const correlationId = randomUUID();
    const maskedLogin = maskCpfCnpjLogin(formattedDocument);
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.baseUrl}/auth/login`,
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({ document: formattedDocument, password: credentials.password, appVersion: ULTRAFV3_APP_VERSION }),
        },
        { method: "POST", path: "/auth/login", attempt: 1, correlationId },
      );
    } catch (error) {
      throw new UltraFv3IntegrationError(
        `UltraFV3 fora do ar ou inacessível durante autenticação de usuário ERP: ${error instanceof Error ? error.message : String(error)}`,
        "unavailable",
      );
    }

    const ultraResponse = await this.safeJson(response);
    const ultraMessage = extractUltraMessage(ultraResponse, response.status);
    const diagnostics: UltraFv3LoginDiagnostic = { status: response.status, message: ultraMessage, ultraResponse, correlationId };
    logApiEvent(response.ok ? "INFO" : "WARN", "[ultrafv3 auth seller] login response", {
      correlationId,
      authMode: "seller",
      maskedLogin,
      status: response.status,
      message: ultraMessage,
      ultraResponse,
    });

    if (response.status === 401 || response.status === 403) {
      throw new UltraFv3IntegrationError(`Erro de autenticação no UltraFV3 para credencial do usuário: ${ultraMessage}`, "auth_failed", response.status, diagnostics);
    }
    if (response.status === 404) {
      throw new UltraFv3IntegrationError(
        `Endpoint de autenticação do UltraFV3 inexistente: /auth/login. Detalhe: ${ultraMessage}`,
        "not_found",
        response.status,
        diagnostics,
      );
    }
    if (!response.ok) {
      throw new UltraFv3IntegrationError(`UltraFV3 login de usuário falhou (status ${response.status}): ${ultraMessage}`, "request_failed", response.status, diagnostics);
    }

    const payload = ultraResponse as UltraFv3AuthPayload | null;
    const token = payload?.token || payload?.accessToken || payload?.access_token;
    if (!token) {
      throw new UltraFv3IntegrationError(
        "UltraFV3 autenticou usuário, mas não retornou token de acesso.",
        "invalid_response",
        response.status,
      );
    }
    return { token, expiresAt: payload ? this.resolveTokenExpiration(payload) : null, tokenPayload: sanitizeUltraTokenPayload(token) };
  }

  async testLogin(credentials: UltraFv3Credentials) {
    const authenticated = await this.loginWithCredentials(credentials);
    return {
      ok: true,
      tokenExpiresAt: authenticated.expiresAt?.toISOString() ?? null,
      maskedDocument: formatUltraDocument(credentials.username),
      tokenPayload: authenticated.tokenPayload,
    };
  }


  async authenticateWithCredentials(credentials: UltraFv3Credentials) {
    const cacheKey = this.getCredentialCacheKey(credentials);
    let cached = this.credentialTokenCache.get(cacheKey);
    if (!cached || this.isTokenExpired(cached.expiresAt)) {
      cached = await this.loginWithCredentials(credentials);
      this.credentialTokenCache.set(cacheKey, cached);
    }
    return { tokenPayload: cached.tokenPayload, tokenExpiresAt: cached.expiresAt?.toISOString() ?? null };
  }

  async requestWithCredentials<T>(
    path: string,
    credentials: UltraFv3Credentials,
    options?: { method?: "GET" | "POST" | "PUT"; body?: unknown; headers?: Record<string, string>; correlationId?: string; timeoutMs?: number },
  ): Promise<T> {
    const cacheKey = this.getCredentialCacheKey(credentials);
    let cached = this.credentialTokenCache.get(cacheKey);
    if (!cached || this.isTokenExpired(cached.expiresAt)) {
      cached = await this.loginWithCredentials(credentials);
      this.credentialTokenCache.set(cacheKey, cached);
    }

    const method = options?.method || "GET";
    const correlationId = options?.correlationId || randomUUID();
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.baseUrl}${path}`,
        {
          method,
          headers: { ...DEFAULT_HEADERS, ...(options?.headers || {}), Authorization: `Bearer ${cached.token}` },
          ...(method !== "GET" && options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        },
        { method, path, attempt: 1, correlationId, timeoutMs: options?.timeoutMs },
      );
    } catch (error) {
      const timeoutMs = options?.timeoutMs ?? ULTRAFV3_REQUEST_TIMEOUT_MS;
      const isTimeout = error instanceof Error && /abort|timeout|timed out/i.test(`${error.name} ${error.message}`);
      const message = isTimeout
        ? `UltraFV3 excedeu o timeout de ${timeoutMs}ms ao processar ${method} ${path}.`
        : `UltraFV3 fora do ar ou inacessível ao processar ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`;
      throw new UltraFv3IntegrationError(message, isTimeout ? "timeout" : "unavailable", isTimeout ? 504 : 502, {
        status: isTimeout ? 504 : 502,
        endpoint: path,
        method,
        message,
        ultraResponse: null,
        correlationId,
      });
    }

    const ultraResponse = await this.safeJson(response, !response.ok);
    const ultraMessage = extractUltraMessage(ultraResponse, response.status);
    const diagnostics: UltraFv3RequestDiagnostic = { status: response.status, endpoint: path, method, message: ultraMessage, ultraResponse, correlationId };

    if (response.status === 401 || response.status === 403) {
      this.credentialTokenCache.delete(cacheKey);
      throw new UltraFv3IntegrationError(`Erro de autenticação no UltraFV3 ao consultar ${path} com credencial de usuário: ${ultraMessage}`, "auth_failed", response.status, diagnostics);
    }
    if (response.status === 404) throw new UltraFv3IntegrationError(`Endpoint UltraFV3 inexistente: ${path}. Detalhe: ${ultraMessage}`, "not_found", response.status, diagnostics);
    if (!response.ok) throw new UltraFv3IntegrationError(`UltraFV3 retornou status ${response.status} ao consultar ${path}: ${ultraMessage}`, "request_failed", response.status, diagnostics);
    return ultraResponse as T;
  }

  async request<T>(
    path: string,
    options?: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      headers?: Record<string, string>;
      correlationId?: string;
    },
  ): Promise<T> {
    this.ensureConfig();

    if (!this.token || this.isTokenExpired()) {
      this.token = null;
      await this.login();
    }

    const method = options?.method || "GET";
    const correlationId = options?.correlationId || randomUUID();
    const execute = async (attempt: number) => {
      const headers = {
        ...DEFAULT_HEADERS,
        ...(options?.headers || {}),
        Authorization: `Bearer ${this.token}`,
      };
      const requestInit: RequestInit = { method, headers };
      if (method !== "GET" && options?.body !== undefined) {
        requestInit.body = JSON.stringify(options.body);
      }

      try {
        return await this.fetchWithTimeout(
          `${this.baseUrl}${path}`,
          requestInit,
          { method, path, attempt, correlationId },
        );
      } catch (error) {
        throw new UltraFv3IntegrationError(
          `UltraFV3 fora do ar ou inacessível ao consultar ${path}: ${error instanceof Error ? error.message : String(error)}`,
          "unavailable",
        );
      }
    };

    let response: Response;
    try {
      response = await execute(1);
    } catch (error) {
      if (method !== "GET") throw error;
      logApiEvent("WARN", "[ultrafv3 http] retrying unavailable GET failure", {
        method,
        path,
        correlationId,
        retryDelayMs: ULTRAFV3_GET_RETRY_DELAY_MS,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(ULTRAFV3_GET_RETRY_DELAY_MS);
      response = await execute(2);
    }

    if (method === "GET" && RETRIABLE_STATUS_CODES.has(response.status)) {
      logApiEvent("WARN", "[ultrafv3 http] retrying transient GET failure", {
        method,
        path,
        correlationId,
        status: response.status,
        retryDelayMs: ULTRAFV3_GET_RETRY_DELAY_MS,
      });
      await sleep(ULTRAFV3_GET_RETRY_DELAY_MS);
      response = await execute(2);
    }

    if (response.status === 401 && method === "GET") {
      this.token = null;
      await this.login();
      response = await execute(
        RETRIABLE_STATUS_CODES.has(response.status) ? 3 : 2,
      );
    }

    if (response.status === 401 && method !== "GET") {
      this.token = null;
    }

    if (response.status === 401 || response.status === 403) {
      const error = new UltraFv3IntegrationError(
        `Erro de autenticação no UltraFV3 ao consultar ${path}.`,
        "auth_failed",
        response.status,
      );
      this.lastError = error.message;
      throw error;
    }

    if (response.status === 404) {
      const error = new UltraFv3IntegrationError(
        `Endpoint UltraFV3 inexistente: ${path}.`,
        "not_found",
        response.status,
      );
      this.lastError = error.message;
      throw error;
    }

    if (!response.ok) {
      const error = new UltraFv3IntegrationError(
        `UltraFV3 retornou status ${response.status} ao consultar ${path}.`,
        "request_failed",
        response.status,
      );
      this.lastError = error.message;
      throw error;
    }

    const payload = (await this.safeJson(response)) as T;
    this.lastError = null;
    return payload;
  }
}

export const ultraFv3Client = new UltraFv3Client();
