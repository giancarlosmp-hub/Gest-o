import axios from "axios";
import { toast } from "sonner";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

type RetryableAxiosRequestConfig = AxiosRequestConfig & { _retry?: boolean };

const resolveApiBaseUrl = () => {
  const configuredBaseUrl = (import.meta.env.VITE_API_URL || "").trim();
  if (configuredBaseUrl) {
    const normalizedConfiguredBaseUrl = configuredBaseUrl.replace(/\/+$/, "");
    if (!import.meta.env.DEV) {
      console.info(`Using production API base URL: ${normalizedConfiguredBaseUrl}`);
    }
    return normalizedConfiguredBaseUrl;
  }

  if (import.meta.env.DEV) {
    return "http://localhost:4000";
  }

  const productionFallbackBaseUrl = "/api";
  console.info(`Using production API base URL: ${productionFallbackBaseUrl}`);
  return productionFallbackBaseUrl;
};

const apiTimeoutMs = Number(import.meta.env.VITE_API_TIMEOUT_MS || 15_000);

const api = axios.create({ baseURL: resolveApiBaseUrl(), withCredentials: true, timeout: apiTimeoutMs });

const MAX_CONCURRENT_REQUESTS = 6;
const RATE_LIMIT_COOLDOWN_MS = 3_000;
const RATE_LIMIT_TOAST_ID = "global-rate-limit-warning";
const NETWORK_ERROR_TOAST_ID = "global-network-error";

const inFlightRequests = new Map<string, Promise<AxiosResponse>>();
const waitingQueue: Array<() => void> = [];

let activeRequests = 0;
let cooldownUntil = 0;

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "";

  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(",")}}`;
};

const getRequestKey = (config: AxiosRequestConfig) => {
  const method = (config.method || "get").toUpperCase();
  const url = config.url || "";
  const params = stableStringify(config.params);
  const data = typeof config.data === "string" ? config.data : stableStringify(config.data);
  return `${method}::${url}::${params}::${data}`;
};

const acquireRequestSlot = async () => {
  while (Date.now() < cooldownUntil) {
    const waitMs = Math.max(cooldownUntil - Date.now(), 50);
    await new Promise((resolve) => window.setTimeout(resolve, waitMs));
  }

  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return;
  }

  await new Promise<void>((resolve) => waitingQueue.push(resolve));
  activeRequests += 1;
};

const releaseRequestSlot = () => {
  activeRequests = Math.max(activeRequests - 1, 0);
  const next = waitingQueue.shift();
  if (next) next();
};

const requestWithoutDedup = api.request.bind(api);
const authApi = axios.create({ baseURL: resolveApiBaseUrl(), withCredentials: true, timeout: apiTimeoutMs });

const requestWithGuards = <T = unknown, R = AxiosResponse<T>, D = unknown>(
  config: AxiosRequestConfig<D>
): Promise<R> => {
  const requestKey = getRequestKey(config);
  const existingPromise = inFlightRequests.get(requestKey);
  if (existingPromise) return existingPromise as Promise<R>;

  const guardedPromise = (async () => {
    await acquireRequestSlot();
    try {
      return await requestWithoutDedup<T, R, D>(config);
    } finally {
      releaseRequestSlot();
      inFlightRequests.delete(requestKey);
    }
  })();

  inFlightRequests.set(requestKey, guardedPromise as Promise<AxiosResponse>);
  return guardedPromise;
};

(api as typeof api & { request: typeof requestWithGuards }).request = requestWithGuards;

let accessToken = localStorage.getItem("accessToken") || "";
export const setAccessToken = (t: string) => { accessToken = t; localStorage.setItem("accessToken", t); };
export const clearAccessToken = () => { accessToken = ""; localStorage.removeItem("accessToken"); };

const AUTH_COOKIE_NAMES = ["accessToken", "refreshToken", "token", "authToken", "crm_auth"];
let isHandlingUnauthorized = false;
let refreshRequest: Promise<string> | null = null;

const clearAuthCookies = () => {
  if (typeof document === "undefined") return;

  const cookieNames = new Set(AUTH_COOKIE_NAMES);
  document.cookie
    .split(";")
    .map((cookie) => cookie.trim().split("=")[0])
    .filter(Boolean)
    .forEach((name) => {
      if (name.toLowerCase().includes("token") || name.toLowerCase().includes("auth")) {
        cookieNames.add(name);
      }
    });

  const hosts = window.location.hostname.split(".");
  const domainVariants = ["", window.location.hostname];
  if (hosts.length > 1) {
    domainVariants.push(`.${hosts.slice(-2).join(".")}`);
  }

  cookieNames.forEach((name) => {
    domainVariants.forEach((domain) => {
      const domainPart = domain ? `; domain=${domain}` : "";
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domainPart}`;
    });
  });
};

export const clearSession = () => {
  clearAccessToken();
  sessionStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  sessionStorage.removeItem("refreshToken");
  clearAuthCookies();
};

const redirectToLoginOnce = () => {
  if (isHandlingUnauthorized) return;
  isHandlingUnauthorized = true;

  clearSession();
  sessionStorage.setItem("session-expired", "1");

  if (window.location.pathname !== "/login") {
    window.location.replace("/login");
    return;
  }

  window.setTimeout(() => {
    isHandlingUnauthorized = false;
  }, 500);
};

const refreshAccessToken = async () => {
  if (!refreshRequest) {
    refreshRequest = authApi
      .post<{ accessToken?: string }>("/auth/refresh")
      .then(({ data }) => {
        const nextAccessToken = String(data?.accessToken || "").trim();
        if (!nextAccessToken) {
          throw new Error("Refresh sem access token");
        }

        setAccessToken(nextAccessToken);
        return nextAccessToken;
      })
      .finally(() => {
        refreshRequest = null;
      });
  }

  return refreshRequest;
};


const withApiErrorDetails = (error: any) => {
  const status = error?.response?.status;
  const backendMessage = error?.response?.data?.message;

  if (status && backendMessage) {
    error.message = `${status} - ${backendMessage}`;
  } else if (status && !String(error?.message || "").includes(String(status))) {
    error.message = `${status} - ${error.message || "Erro na API"}`;
  }

  return error;
};

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use((r) => r, async (error) => {
  withApiErrorDetails(error);
  const status = error.response?.status;
  const isNetworkError = !error.response;
  const requestConfig = (error.config || {}) as RetryableAxiosRequestConfig;
  const requestUrl = String(requestConfig.url || "");
  const isAuthLoginRoute = requestUrl.includes("/auth/login");
  const isAuthRefreshRoute = requestUrl.includes("/auth/refresh");
  const authHeader = requestConfig.headers?.Authorization || requestConfig.headers?.authorization;
  const hasAuthenticatedContext = Boolean(authHeader || accessToken);
  const shouldRetryWithRefresh =
    status === 401 &&
    hasAuthenticatedContext &&
    !isAuthLoginRoute &&
    !isAuthRefreshRoute &&
    !requestConfig._retry;

  if (shouldRetryWithRefresh) {
    try {
      const nextAccessToken = await refreshAccessToken();
      requestConfig._retry = true;
      requestConfig.headers = requestConfig.headers || {};
      requestConfig.headers.Authorization = `Bearer ${nextAccessToken}`;
      return await requestWithoutDedup(requestConfig);
    } catch {
      redirectToLoginOnce();
    }
  } else if (status === 401 && !isAuthLoginRoute) {
    redirectToLoginOnce();
  }

  if (status === 429) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    if (import.meta.env.DEV) {
      console.warn("[api] 429 rate limit", {
        url: error?.config?.url,
        method: error?.config?.method,
        params: error?.config?.params
      });
    }
    toast.error("Muitas requisições. Aguarde alguns segundos.", { id: RATE_LIMIT_TOAST_ID });
  }

  if (isNetworkError) {
    toast.error("Servidor indisponível. Verifique conexão.", { id: NETWORK_ERROR_TOAST_ID });
  }

  return Promise.reject(withApiErrorDetails(error));
});

export default api;
