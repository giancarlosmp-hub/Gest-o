import { createContext, useContext, useEffect, useRef, useState } from "react";
import api, { clearSession, setAccessToken } from "../lib/apiClient";

export type UserRole = "diretor" | "gerente" | "vendedor";

type User = { id: string; name: string; email: string; role: UserRole; region?: string };

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const meRequestRef = useRef<Promise<void> | null>(null);

  const fetchMe = () => {
    if (meRequestRef.current) return meRequestRef.current;

    meRequestRef.current = (async () => {
      try {
        const { data } = await api.get("/auth/me");
        setUser(data);
      } catch {
        clearSession();
        setUser(null);
      } finally {
        setLoading(false);
        meRequestRef.current = null;
      }
    })();

    return meRequestRef.current;
  };

  useEffect(() => { void fetchMe(); }, []);

  const login = async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
    setAccessToken(data.accessToken);
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      clearSession();
      setUser(null);
    }
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
