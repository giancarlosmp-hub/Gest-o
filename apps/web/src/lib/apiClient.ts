import axios from "axios";

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000", withCredentials: true });

let accessToken = localStorage.getItem("accessToken") || "";
export const setAccessToken = (t: string) => { accessToken = t; localStorage.setItem("accessToken", t); };
export const clearAccessToken = () => { accessToken = ""; localStorage.removeItem("accessToken"); };

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use((r) => r, async (error) => {
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

  return Promise.reject(error);
});

export default api;
