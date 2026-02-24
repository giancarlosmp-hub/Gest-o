import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000",
  withCredentials: true
});

let accessToken = localStorage.getItem("accessToken") || "";
let refreshPromise: Promise<string | null> | null = null;

export const setAccessToken = (token: string) => {
  accessToken = token;
  localStorage.setItem("accessToken", token);
};

export const clearAccessToken = () => {
  accessToken = "";
  localStorage.removeItem("accessToken");
};

export const hasAccessToken = () => Boolean(accessToken);

const isAuthRoute = (url?: string) => {
  if (!url) return false;
  return ["/auth/login", "/auth/refresh", "/auth/logout"].some((route) => url.includes(route));
};

const shouldAttemptRefresh = (config?: InternalAxiosRequestConfig) => {
  if (!config) return false;
  if (config._retry) return false;
  if (isAuthRoute(config.url)) return false;
  return Boolean(accessToken);
};

const refreshAccessToken = async (): Promise<string | null> => {
  if (!refreshPromise) {
    refreshPromise = api
      .post("/auth/refresh")
      .then((response) => {
        const nextToken = response.data?.accessToken;
        if (!nextToken) return null;
        setAccessToken(nextToken);
        return nextToken;
      })
      .catch(() => {
        clearAccessToken();
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
};

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalConfig = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status !== 401 || !shouldAttemptRefresh(originalConfig)) {
      return Promise.reject(error);
    }

    originalConfig._retry = true;
    const newToken = await refreshAccessToken();

    if (!newToken) {
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      return Promise.reject(error);
    }

    originalConfig.headers.Authorization = `Bearer ${newToken}`;
    return api(originalConfig);
  }
);

export default api;
