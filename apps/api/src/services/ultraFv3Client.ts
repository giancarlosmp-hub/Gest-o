import { env } from "../config/env.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

class UltraFv3Client {
  private token: string | null = null;
  private tokenPromise: Promise<string> | null = null;

  private get baseUrl() {
    return env.ultraFv3BaseUrl.replace(/\/+$/, "");
  }

  private ensureConfig() {
    if (!this.baseUrl || !env.ultraFv3Username || !env.ultraFv3Password) {
      throw new Error("UltraFV3 credentials are not configured");
    }
  }

  private async login() {
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
    this.ensureConfig();

    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        username: env.ultraFv3Username,
        password: env.ultraFv3Password,
      }),
    });

    if (!response.ok) {
      throw new Error(`UltraFV3 login failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { token?: string; accessToken?: string; access_token?: string };
    const token = payload.token || payload.accessToken || payload.access_token;

    if (!token) {
      throw new Error("UltraFV3 login did not return an access token");
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

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...requestInit,
      });

      return response;
    };

    let response = await execute();

    if (response.status === 401) {
      await this.login();
      response = await execute();
    }

    if (!response.ok) {
      throw new Error(`UltraFV3 request failed (${path}) with status ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

export const ultraFv3Client = new UltraFv3Client();
