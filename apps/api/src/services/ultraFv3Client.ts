import { env } from "../config/env.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

class UltraFv3Client {
  private token: string | null = null;

  private get baseUrl() {
    return env.ultraFv3BaseUrl.replace(/\/+$/, "");
  }

  private ensureConfig() {
    if (!this.baseUrl || !env.ultraFv3Username || !env.ultraFv3Password) {
      throw new Error("UltraFV3 credentials are not configured");
    }
  }

  private async login() {
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
  }

  async request<T>(path: string): Promise<T> {
    this.ensureConfig();

    if (!this.token) {
      await this.login();
    }

    const execute = async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          ...DEFAULT_HEADERS,
          Authorization: `Bearer ${this.token}`,
        },
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
