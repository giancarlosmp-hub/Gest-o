import { LogOut, Menu } from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import BrandLogo from "../components/BrandLogo";
import { canAccessRoute, type AppRoute } from "../lib/authorization";
import { useReminders } from "../hooks/useReminders";
import SidebarNavItem from "../components/sidebar/SidebarNavItem";

type SidebarItem = {
  id: string;
  label: string;
  path: string;
  route?: AppRoute;
};

const items: SidebarItem[] = [
  { id: "home", label: "Home", path: "/" },
  { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  { id: "equipe", label: "Equipe", path: "/equipe", route: "equipe" },
  { id: "clientes", label: "Clientes (Cliente 360)", path: "/clientes" },
  { id: "oportunidades", label: "Oportunidades", path: "/oportunidades" },
  { id: "atividades", label: "Atividades", path: "/atividades" },
  { id: "relatorios", label: "Relatórios", path: "/relatórios" },
  { id: "configuracoes", label: "Configurações", path: "/configurações", route: "configuracoes" }
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const { reminders } = useReminders();

  const getSidebarBadgeCount = (item: SidebarItem) => {
    if (item.id === "home") return reminders.agendaBadgeCount;
    if (item.id === "atividades") return reminders.activitiesBadgeCount;
    return 0;
  };

  const getSidebarTooltipText = (item: SidebarItem) => {
    if (item.id === "home" && reminders.agendaBadgeCount > 0) {
      return `${reminders.tasksDueCount} tarefas • ${reminders.followUpsDueCount} follow-ups • ${reminders.overdueOppsCount} atrasadas`;
    }

    if (item.id === "atividades" && reminders.activitiesBadgeCount > 0) {
      return `${reminders.activitiesBadgeCount} tarefas pendentes`;
    }

    return undefined;
  };

  const isActiveItem = (item: SidebarItem) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
  };

  const sidebar = (
    <aside className="bg-brand-700 text-white w-64 min-h-screen p-4 space-y-3">
      <h1 className="mb-6">
        <BrandLogo size="sidebar" textClassName="text-white" />
      </h1>

      {items
        .filter((item) => !item.route || canAccessRoute(item.route, user?.role))
        .map((item) => {
          const active = isActiveItem(item);
          const badgeCount = getSidebarBadgeCount(item);
          const itemLabel = item.id === "home" ? "Agenda" : item.label;
          const tooltipText = getSidebarTooltipText(item);

          return (
            <SidebarNavItem
              key={item.id}
              to={item.path}
              active={active}
              label={itemLabel}
              badgeCount={badgeCount}
              tooltipText={tooltipText}
              onClick={() => setOpen(false)}
            />
          );
        })}
    </aside>
  );

  return (
    <div className="flex">
      <div className="hidden md:block">{sidebar}</div>

      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setOpen(false)}>
          <div className="w-64" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}

      <main className="flex-1">
        <header className="border-b border-brand-100 bg-white px-4 py-3 flex items-center justify-between">
          <button
            className="rounded-md p-1 text-brand-700 md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Abrir menu"
          >
            <Menu />
          </button>

          <BrandLogo size="header" textClassName="text-brand-700" className="md:hidden" />

          <div className="ml-auto flex items-center gap-3">
            <div className="text-sm text-slate-700">
              <strong>{user?.name}</strong> ({user?.role})
            </div>

            <button
              className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800"
              onClick={logout}
            >
              <LogOut size={16} />
              Logout
            </button>
          </div>
        </header>

        <div className="p-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
