import {
  BarChart3,
  Building2,
  Calendar,
  CheckSquare,
  ChevronFirst,
  ChevronLast,
  FileBarChart,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Settings,
  Target,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { useMemo, useState, type CSSProperties } from "react";
import { useAuth, type UserRole } from "../context/AuthContext";
import BrandLogo from "../components/BrandLogo";
import { canAccessRoute, type AppRoute } from "../lib/authorization";
import { useReminders } from "../hooks/useReminders";
import MobileActionBar from "../components/mobile/MobileActionBar";
import SidebarItem from "../components/sidebar/SidebarItem";
import { SidebarProvider, useSidebar } from "../context/SidebarContext";

type SidebarNavItem = {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  route?: AppRoute;
};

const DESKTOP_COLLAPSED_WIDTH = 72;
const DESKTOP_EXPANDED_WIDTH = 240;


function normalizePath(pathname: string) {
  const decodedPath = decodeURIComponent(pathname);
  const normalized = decodedPath
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function isSidebarItemActive(currentPath: string, itemPath: string) {
  const normalizedCurrentPath = normalizePath(currentPath);
  const normalizedItemPath = normalizePath(itemPath);

  if (normalizedItemPath === "/") return normalizedCurrentPath === "/";

  return (
    normalizedCurrentPath === normalizedItemPath ||
    normalizedCurrentPath.startsWith(`${normalizedItemPath}/`)
  );
}

const items: SidebarNavItem[] = [
  { id: "home", label: "Central do Dia", path: "/", icon: LayoutDashboard },
  { id: "dashboard", label: "Dashboard", path: "/dashboard", icon: BarChart3 },
  { id: "equipe", label: "Equipe", path: "/equipe", route: "equipe", icon: Users },
  { id: "clientes", label: "Clientes", path: "/clientes", icon: Building2 },
  { id: "oportunidades", label: "Oportunidades", path: "/oportunidades", icon: Target },
  { id: "atividades", label: "Atividades", path: "/atividades", icon: CheckSquare },
  { id: "agenda", label: "Agenda", path: "/agenda", icon: Calendar },
  { id: "whatsapp", label: "WhatsApp", path: "/whatsapp", icon: MessageCircle },
  {
    id: "assistente-tecnico",
    label: "Assistente Técnico",
    path: "/assistente-tecnico",
    route: "assistenteTecnico",
    icon: FlaskConical,
  },
  { id: "relatorios", label: "Relatórios", path: "/relatórios", icon: FileBarChart },
  {
    id: "configuracoes",
    label: "Configurações",
    path: "/configurações",
    route: "configuracoes",
    icon: Settings,
  },
];

function canAccessSidebarItem(item: SidebarNavItem, role?: UserRole | null) {
  if (item.route) return canAccessRoute(item.route, role);

  const itemPath = normalizePath(item.path);

  if (itemPath.startsWith("/equipe")) return canAccessRoute("equipe", role);
  if (itemPath.startsWith("/objetivos") || itemPath.startsWith("/metas")) return canAccessRoute("objetivos", role);
  if (itemPath.startsWith("/configuracoes")) return canAccessRoute("configuracoes", role);

  return true;
}

function AppLayoutShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { reminders } = useReminders();
  const { isPinnedExpanded, togglePinnedExpanded } = useSidebar();
  const [isDesktopHovered, setDesktopHovered] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isDesktopExpanded = isPinnedExpanded || isDesktopHovered;
  const desktopSidebarWidth = isDesktopExpanded ? DESKTOP_EXPANDED_WIDTH : DESKTOP_COLLAPSED_WIDTH;

  const visibleItems = useMemo(
    () => items.filter((item) => canAccessSidebarItem(item, user?.role)),
    [user?.role]
  );

  const isActiveItem = (item: SidebarNavItem) => {
    const active = isSidebarItemActive(location.pathname, item.path);

    if (import.meta.env.DEV) {
      console.debug("[sidebar-active]", {
        label: item.label,
        path: item.path,
        currentPath: location.pathname,
        normalizedCurrentPath: normalizePath(location.pathname),
        normalizedItemPath: normalizePath(item.path),
        active,
      });
    }

    return active;
  };

  const getSidebarBadgeCount = (item: SidebarNavItem) => {
    if (item.id === "agenda") return reminders.agendaBadgeCount;
    if (item.id === "atividades") return reminders.activitiesBadgeCount;
    return 0;
  };

  const renderSidebarContent = (
    expanded: boolean,
    options?: {
      onItemClick?: () => void;
      onFooterActionClick?: () => void;
      footerActionLabel?: string;
      showBrand?: boolean;
    }
  ) => (
    <>
      {options?.showBrand === false ? null : (
        <div className="mb-4 flex h-11 items-center overflow-hidden px-2">
          <div className={expanded ? "block" : "hidden"}>
            <BrandLogo context="sidebar" tone="light" showText className="min-w-0" />
          </div>
          <div className={expanded ? "hidden" : "flex w-full justify-center"}>
            <BrandLogo context="sidebar" tone="light" compact />
          </div>
        </div>
      )}

      <nav className="flex-1 space-y-1.5">
        {visibleItems.map((item) => (
          <SidebarItem
            key={item.id}
            to={item.path}
            label={item.label}
            icon={item.icon}
            active={isActiveItem(item)}
            expanded={expanded}
            badgeCount={getSidebarBadgeCount(item)}
            onClick={options?.onItemClick}
          />
        ))}
      </nav>

      <div className="mt-4 border-t border-white/15 pt-3">
        <button
          type="button"
          onClick={options?.onFooterActionClick ?? togglePinnedExpanded}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl text-brand-100 transition hover:bg-white/10 hover:text-white"
          aria-label={options?.footerActionLabel ?? (isPinnedExpanded ? "Fixar recolhida" : "Fixar expandida")}
          title={options?.footerActionLabel ?? (isPinnedExpanded ? "Fixar recolhida" : "Fixar expandida")}
        >
          {options?.onFooterActionClick ? <X size={18} /> : isPinnedExpanded ? <ChevronFirst size={18} /> : <ChevronLast size={18} />}
          <span className={expanded ? "text-xs font-semibold" : "hidden"}>
            {options?.footerActionLabel ?? (isPinnedExpanded ? "Recolher" : "Expandir")}
          </span>
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-[color:var(--bg-app)] md:pl-[var(--sidebar-width)]" style={{ "--sidebar-width": `${desktopSidebarWidth}px` } as CSSProperties}>
      <aside
        className="fixed left-0 top-0 z-40 hidden h-screen overflow-hidden border-r border-white/10 bg-brand-700 px-3 py-4 text-white shadow-2xl transition-[width] duration-300 md:flex md:flex-col"
        style={{ width: desktopSidebarWidth }}
        onMouseEnter={() => setDesktopHovered(true)}
        onMouseLeave={() => setDesktopHovered(false)}
      >
        {renderSidebarContent(isDesktopExpanded, { showBrand: true })}
      </aside>

      <div className="fixed left-0 top-0 z-50 w-full border-b border-brand-100 bg-white px-3 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <button className="rounded-md p-1 text-brand-700" onClick={() => setMobileOpen(true)} aria-label="Abrir menu">
            <Menu />
          </button>
          <BrandLogo context="header" tone="dark" compact className="min-w-0" />
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-2.5 py-2 text-xs font-medium text-white hover:bg-brand-800"
            onClick={logout}
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-[84%] max-w-[280px] bg-brand-700 px-3 py-4 text-white shadow-2xl">
            <div className="mb-3 flex items-center justify-between px-1">
              <BrandLogo context="header" tone="light" compact />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Fechar menu"
                className="rounded-md p-1 text-white/90 hover:bg-white/10"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex h-[calc(100%-3.5rem)] flex-col">{renderSidebarContent(true, {
              onItemClick: () => setMobileOpen(false),
              onFooterActionClick: () => setMobileOpen(false),
              footerActionLabel: "Recolher",
              showBrand: false,
            })}</div>
          </aside>
        </div>
      )}

      <main className="min-w-0">
        <header className="hidden border-b border-brand-100 bg-white px-6 py-3 md:block">
          <div className="flex min-w-0 items-center justify-end gap-3">
            <div className="min-w-0 text-right text-sm text-slate-700">
              <strong className="block truncate leading-tight">{user?.name}</strong>
              <span className="mt-0.5 block truncate text-xs leading-tight text-slate-500">Perfil: {user?.role}</span>
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

        <section className="pt-[76px] md:pt-0">
          <div className="crm-page-shell min-w-0 px-4 py-4 pb-28 md:px-6 md:pb-4">
            <Outlet />
          </div>
        </section>

        <MobileActionBar />
      </main>
    </div>
  );
}

export default function AppLayout() {
  return (
    <SidebarProvider>
      <AppLayoutShell />
    </SidebarProvider>
  );
}
