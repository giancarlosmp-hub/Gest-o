import { LogOut, Menu, Ruler } from "lucide-react";
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
  icon?: typeof Ruler;
};

const items: SidebarItem[] = [
  { id: "home", label: "Central do Dia", path: "/" },
  { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  { id: "equipe", label: "Equipe", path: "/equipe", route: "equipe" },
  { id: "clientes", label: "Clientes", path: "/clientes" },
  { id: "oportunidades", label: "Oportunidades", path: "/oportunidades" },
  { id: "atividades", label: "Atividades", path: "/atividades" },
  { id: "agenda", label: "Agenda", path: "/agenda" },
  {
    id: "assistente-tecnico",
    label: "Assistente Técnico",
    path: "/assistente-tecnico",
    route: "assistenteTecnico",
    icon: Ruler
  },
  { id: "relatorios", label: "Relatórios", path: "/relatórios" },
  { id: "configuracoes", label: "Configurações", path: "/configurações", route: "configuracoes" }
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const { reminders } = useReminders();

  const getSidebarBadgeCount = (item: SidebarItem) => {
    if (item.id === "agenda") return reminders.agendaBadgeCount;
    if (item.id === "atividades") return reminders.activitiesBadgeCount;
    return 0;
  };

  const getSidebarTooltipText = (item: SidebarItem) => {
    if (item.id === "agenda" && reminders.agendaBadgeCount > 0) {
      return `${reminders.tasksDueCount} tarefas • ${reminders.followUpsDueCount} follow-ups • ${reminders.overdueOppsCount} atrasadas`;
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
          const tooltipText = getSidebarTooltipText(item);

          return (
            <SidebarNavItem
              key={item.id}
              to={item.path}
              active={active}
              label={item.label}
              badgeCount={badgeCount}
              tooltipText={tooltipText}
              icon={item.icon}
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

      <main className="min-w-0 flex-1">
        <header className="border-b border-brand-100 bg-white px-3 py-3 sm:px-4">
          <div className="flex items-start gap-2 md:hidden">
            <button
              className="shrink-0 rounded-md p-1 text-brand-700 md:hidden"
              onClick={() => setOpen(true)}
              aria-label="Abrir menu"
            >
              <Menu />
            </button>

            <div className="min-w-0 flex-1 pt-0.5">
              <BrandLogo
                size="header"
                textClassName="text-brand-700"
                className="min-w-0 md:hidden"
              />
            </div>

            <button
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-700 px-2.5 py-2 text-xs font-medium text-white hover:bg-brand-800 xs:gap-2 xs:px-3 xs:text-sm md:hidden"
              onClick={logout}
            >
              <LogOut size={16} />
              <span className="hidden xs:inline">Logout</span>
            </button>
          </div>

          <div className="mt-2 flex min-w-0 items-center justify-between gap-2 md:mt-0 md:justify-end md:gap-3">
            <div className="min-w-0 text-xs text-slate-700 sm:text-sm md:text-right">
              <strong className="block break-words leading-tight md:truncate">{user?.name}</strong>
              <span className="mt-0.5 block break-words text-[11px] leading-tight text-slate-500 sm:text-xs md:truncate">
                Perfil: {user?.role}
              </span>
            </div>

            <button
              className="hidden items-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 md:inline-flex"
              onClick={logout}
            >
              <LogOut size={16} />
              Logout
            </button>
          </div>
        </header>

        <div className="crm-page-shell p-4 sm:p-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
