import { env } from "../config/env.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

type UltraFv3EnvVar = "ULTRAFV3_BASE_URL" | "ULTRAFV3_USERNAME" | "ULTRAFV3_PASSWORD";
type UltraFv3AuthenticationStatus = "missing_config" | "authenticated" | "not_authenticated";

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

export class UltraFv3IntegrationError extends Error {
  constructor(
    message: string,
    readonly code: "missing_credentials" | "unavailable" | "auth_failed" | "not_found" | "invalid_response" | "request_failed",
    readonly status?: number
  ) {
    super(message);
    this.name = "UltraFv3IntegrationError";
  }
}

class UltraFv3Client {
  private token: string | null = null;
  private tokenPromise: Promise<string> | null = null;
  private lastError: string | null = null;

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

  private ensureConfig() {
    const missing = this.getMissingConfig();
    if (missing.length > 0) {
      throw new UltraFv3IntegrationError(
        `Credenciais UltraFV3 não configuradas. Defina ${missing.join(", ")}.`,
        "missing_credentials"
      );
    }
  }

  getDiagnostics() {
    const missingConfig = this.getMissingConfig();
    const isConfigured = missingConfig.length === 0;
    const authenticationStatus: UltraFv3AuthenticationStatus = !isConfigured ? "missing_config" : this.token ? "authenticated" : "not_authenticated";
    return {
      baseUrl: this.baseUrl ? maskBaseUrl(this.baseUrl) : null,
      isConfigured,
      missingConfig,
      authenticationStatus,
      lastError: this.lastError,
    };
  }

  private async safeJson(response: Response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UltraFv3IntegrationError("UltraFV3 retornou uma resposta inválida (JSON malformado).", "invalid_response", response.status);
    }
  }

  private async login() {
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      this.ensureConfig();

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/auth/login`, {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            username: env.ultraFv3Username,
            password: env.ultraFv3Password,
          }),
        });
      } catch (error) {
        throw new UltraFv3IntegrationError(
          `UltraFV3 fora do ar ou inacessível durante autenticação: ${error instanceof Error ? error.message : String(error)}`,
          "unavailable"
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new UltraFv3IntegrationError("Erro de autenticação no UltraFV3. Verifique usuário e senha configurados.", "auth_failed", response.status);
      }

      if (response.status === 404) {
        throw new UltraFv3IntegrationError("Endpoint de autenticação do UltraFV3 inexistente: /auth/login.", "not_found", response.status);
      }

      if (!response.ok) {
        throw new UltraFv3IntegrationError(`UltraFV3 login falhou com status ${response.status}.`, "request_failed", response.status);
      }

      const payload = (await this.safeJson(response)) as { token?: string; accessToken?: string; access_token?: string } | null;
      const token = payload?.token || payload?.accessToken || payload?.access_token;

      if (!token) {
        throw new UltraFv3IntegrationError("UltraFV3 autenticou, mas não retornou token de acesso.", "invalid_response", response.status);
      }

      this.token = token;
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

  async request<T>(
    path: string,
    options?: { method?: "GET" | "POST" | "PUT"; body?: unknown; headers?: Record<string, string> }
  ): Promise<T> {
    this.ensureConfig();

    if (!this.token) {
      await this.login();
    }

    const method = options?.method || "GET";
    const execute = async () => {
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
        return await fetch(`${this.baseUrl}${path}`, { ...requestInit });
      } catch (error) {
        throw new UltraFv3IntegrationError(
          `UltraFV3 fora do ar ou inacessível ao consultar ${path}: ${error instanceof Error ? error.message : String(error)}`,
          "unavailable"
        );
      }
    };

    let response = await execute();

    if (response.status === 401) {
      this.token = null;
      await this.login();
      response = await execute();
    }

    if (response.status === 401 || response.status === 403) {
      const error = new UltraFv3IntegrationError(`Erro de autenticação no UltraFV3 ao consultar ${path}.`, "auth_failed", response.status);
      this.lastError = error.message;
      throw error;
    }

    if (response.status === 404) {
      const error = new UltraFv3IntegrationError(`Endpoint UltraFV3 inexistente: ${path}.`, "not_found", response.status);
      this.lastError = error.message;
      throw error;
    }

    if (!response.ok) {
      const error = new UltraFv3IntegrationError(`UltraFV3 retornou status ${response.status} ao consultar ${path}.`, "request_failed", response.status);
      this.lastError = error.message;
      throw error;
    }

    const payload = (await this.safeJson(response)) as T;
    this.lastError = null;
    return payload;
  }
}

export const ultraFv3Client = new UltraFv3Client();
