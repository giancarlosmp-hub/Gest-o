import type { UserRole } from "../context/AuthContext";

export type AppRoute = "equipe" | "objetivos" | "usuarios" | "configuracoes";

const routeAccess: Record<AppRoute, UserRole[]> = {
  equipe: ["diretor", "gerente"],
  objetivos: ["diretor", "gerente"],
  usuarios: ["diretor", "gerente"],
  configuracoes: ["diretor", "gerente"]
};

export function canAccessRoute(route: AppRoute, role?: UserRole | null) {
  if (!role) return false;
  return routeAccess[route].includes(role);
}
