import axios from "axios";

const resolveApiBaseUrl = () => {
  const configuredBaseUrl = (import.meta.env.VITE_API_URL || "").trim();
  if (!configuredBaseUrl) return "http://localhost:4000";

  return configuredBaseUrl.replace(/\/+$/, "");
};

const api = axios.create({ baseURL: resolveApiBaseUrl(), withCredentials: true });

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

  return Promise.reject(withApiErrorDetails(error));
});

export default api;
