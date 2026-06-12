import type { UserRole } from "../context/AuthContext";

export type AppRoute = "equipe" | "objetivos" | "usuarios" | "configuracoes" | "assistenteTecnico";

const routeAccess: Record<AppRoute, UserRole[]> = {
  equipe: ["diretor", "gerente"],
  objetivos: ["diretor", "gerente"],
  usuarios: ["diretor", "gerente"],
  configuracoes: ["diretor", "gerente"],
  assistenteTecnico: ["diretor", "gerente", "vendedor"]
};

export function canAccessRoute(route: AppRoute, role?: UserRole | null) {
  if (!role) return false;
  return routeAccess[route].includes(role);
}
