import axios from "axios";
import { toast } from "sonner";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

const resolveApiBaseUrl = () => {
  const configuredBaseUrl = (import.meta.env.VITE_API_URL || "").trim();
  if (!configuredBaseUrl) return "http://localhost:4000";

  return configuredBaseUrl.replace(/\/+$/, "");
};

const api = axios.create({ baseURL: resolveApiBaseUrl(), withCredentials: true });

const MAX_CONCURRENT_REQUESTS = 6;
const RATE_LIMIT_COOLDOWN_MS = 3_000;
const RATE_LIMIT_TOAST_ID = "global-rate-limit-warning";

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
  const requestUrl = String(error.config?.url || "");
  const isAuthRoute = requestUrl.includes("/auth/login") || requestUrl.includes("/auth/refresh");

  if (status === 401 && !error.config?._retry && !isAuthRoute) {
    error.config._retry = true;
    try {
      const { data } = await api.post("/auth/refresh");
      setAccessToken(data.accessToken);
      error.config.headers.Authorization = `Bearer ${data.accessToken}`;
      return api(error.config);
    } catch {
      clearAccessToken();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
  }

  if (status === 429) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    toast.error("Muitas requisições. Aguarde alguns segundos e tente novamente.", { id: RATE_LIMIT_TOAST_ID });
  }

  return Promise.reject(withApiErrorDetails(error));
});

export default api;
