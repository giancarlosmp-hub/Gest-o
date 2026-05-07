import { env } from "../config/env.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
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

  private get baseUrl() {
    return env.ultraFv3BaseUrl.replace(/\/+$/, "");
  }

  private ensureConfig() {
    if (!this.baseUrl || !env.ultraFv3Username || !env.ultraFv3Password) {
      throw new UltraFv3IntegrationError(
        "Credenciais UltraFV3 não configuradas. Defina ULTRAFV3_BASE_URL, ULTRAFV3_USERNAME e ULTRAFV3_PASSWORD.",
        "missing_credentials"
      );
    }
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
      return await this.tokenPromise;
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
      throw new UltraFv3IntegrationError(`Erro de autenticação no UltraFV3 ao consultar ${path}.`, "auth_failed", response.status);
    }

    if (response.status === 404) {
      throw new UltraFv3IntegrationError(`Endpoint UltraFV3 inexistente: ${path}.`, "not_found", response.status);
    }

    if (!response.ok) {
      throw new UltraFv3IntegrationError(`UltraFV3 retornou status ${response.status} ao consultar ${path}.`, "request_failed", response.status);
    }

    return (await this.safeJson(response)) as T;
  }
}

export const ultraFv3Client = new UltraFv3Client();
