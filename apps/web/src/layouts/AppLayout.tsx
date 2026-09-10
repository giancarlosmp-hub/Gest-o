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
  MapPinned,
  Menu,
  MessageCircle,
  ShoppingCart,
  Bot,
  Settings,
  ShieldCheck,
  Target,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAuth, type UserRole } from "../context/AuthContext";
import BrandLogo from "../components/BrandLogo";
import { canAccessRoute, type AppRoute } from "../lib/authorization";
import { useReminders } from "../hooks/useReminders";
import MobileActionBar from "../components/mobile/MobileActionBar";
import SidebarItem from "../components/sidebar/SidebarItem";
import SidebarBrand from "../components/sidebar/SidebarBrand";
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
  { id: "platform-health", label: "Saúde da Plataforma", path: "/saude-da-plataforma", route: "saudePlataforma", icon: ShieldCheck },
  { id: "equipe", label: "Equipe", path: "/equipe", route: "equipe", icon: Users },
  { id: "clientes", label: "Clientes", path: "/clientes", icon: Building2 },
  { id: "oportunidades", label: "Oportunidades", path: "/oportunidades", icon: Target },
  { id: "pedidos", label: "Pedidos", path: "/pedidos", icon: ShoppingCart },
  { id: "atividades", label: "Atividades", path: "/atividades", icon: CheckSquare },
  { id: "agenda", label: "Agenda", path: "/agenda", icon: Calendar },
  { id: "assistant", label: "Assistente Comercial", path: "/assistant", icon: Bot },
  { id: "whatsapp", label: "WhatsApp", path: "/whatsapp", icon: MessageCircle },
  { id: "territorios", label: "Territórios", path: "/territórios", icon: MapPinned },
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

  useEffect(() => {
    if (!mobileOpen) return;

    const scrollY = window.scrollY;
    const previous = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      document.body.style.overflow = previous.overflow;
      document.body.style.position = previous.position;
      document.body.style.top = previous.top;
      document.body.style.width = previous.width;
      window.scrollTo(0, scrollY);
    };
  }, [mobileOpen]);

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
        <SidebarBrand expanded={expanded} className="mb-4 px-2" />
      )}

      <nav className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pb-2 [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch]">
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

      <div className="mt-2 shrink-0 border-t border-white/15 pt-2">
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
    <div className="min-h-screen min-w-0 bg-[color:var(--bg-app)] md:pl-[var(--sidebar-width)]" style={{ "--sidebar-width": `${desktopSidebarWidth}px` } as CSSProperties}>
      <aside
        className="fixed left-0 top-0 z-40 hidden h-screen max-h-[100dvh] overflow-hidden border-r border-white/10 bg-brand-700 px-3 py-4 text-white shadow-2xl transition-[width] duration-300 md:flex md:flex-col"
        style={{ width: desktopSidebarWidth }}
        onMouseEnter={() => setDesktopHovered(true)}
        onMouseLeave={() => setDesktopHovered(false)}
      >
        {renderSidebarContent(isDesktopExpanded, { showBrand: true })}
      </aside>

      <div className="mobile-app-header fixed inset-x-0 top-0 z-50 w-full border-b border-brand-100 bg-white px-3 pb-3 pt-[calc(env(safe-area-inset-top)+12px)] md:hidden">
        <div className="flex items-center gap-2">
          <button className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1 text-brand-700" onClick={() => setMobileOpen(true)} aria-label="Abrir menu">
            <Menu />
          </button>
          <BrandLogo
            context="header"
            tone="dark"
            showText
            className="min-w-0 flex-1"
            textClassName="min-w-0"
            brandNameClassName="font-bold text-brand-700"
            taglineClassName="font-medium text-slate-700"
          />
          <button
            className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand-700 px-2.5 py-2 text-xs font-medium text-white hover:bg-brand-800"
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
          <aside aria-label="Menu principal" className="absolute left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-[min(84vw,280px)] min-w-0 flex-col overflow-hidden bg-brand-700 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))] text-white shadow-2xl">
            <div className="mb-3 flex shrink-0 items-center justify-between gap-2 px-1">
              <SidebarBrand expanded className="flex-1" />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Fechar menu"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1 text-white/90 hover:bg-white/10"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{renderSidebarContent(true, {
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

        <section className="pt-[calc(76px+env(safe-area-inset-top))] md:pt-0">
          <div className="crm-page-shell min-w-0 px-4 py-4 pb-[calc(var(--mobile-action-bar-height)+env(safe-area-inset-bottom)+1rem)] md:px-6 md:pb-4">
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
