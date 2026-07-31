import type { UserRole } from "../context/AuthContext";

export type AppRoute = "equipe" | "objetivos" | "usuarios" | "configuracoes" | "assistenteTecnico" | "saudePlataforma";

const routeAccess: Record<AppRoute, UserRole[]> = {
  equipe: ["diretor", "gerente"],
  objetivos: ["diretor", "gerente"],
  usuarios: ["diretor", "gerente"],
  configuracoes: ["diretor", "gerente"],
  assistenteTecnico: ["diretor", "gerente", "vendedor"],
  saudePlataforma: ["diretor"]
};

export function canAccessRoute(route: AppRoute, role?: UserRole | null) {
  if (!role) return false;
  return routeAccess[route].includes(role);
}
