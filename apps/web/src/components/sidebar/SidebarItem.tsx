import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

type SidebarItemProps = {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  expanded: boolean;
  badgeCount?: number;
  tooltipText?: string;
  onClick?: () => void;
};

export default function SidebarItem({
  to,
  label,
  icon: Icon,
  active,
  expanded,
  badgeCount = 0,
  tooltipText,
  onClick,
}: SidebarItemProps) {
  const showBadge = badgeCount > 0;

  return (
    <Link
      to={to}
      onClick={onClick}
      aria-label={label}
      title={!expanded ? label : tooltipText}
      className={[
        "group relative flex h-11 items-center overflow-hidden rounded-xl px-3 transition-all duration-200",
        active
          ? "bg-brand-600 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_12px_24px_rgba(11,60,29,0.25)]"
          : "text-brand-100 hover:bg-white/10 hover:text-white",
      ].join(" ")}
    >
      <span className="flex w-full items-center gap-3">
        <span
          className={[
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
            active ? "bg-white/20" : "bg-white/10 group-hover:bg-white/20",
          ].join(" ")}
        >
          <Icon size={18} aria-hidden="true" />
        </span>

        <span
          className={[
            "flex min-w-0 flex-1 items-center justify-between gap-2 transition-all duration-200",
            expanded ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-2 opacity-0",
          ].join(" ")}
        >
          <span className="truncate text-sm font-medium">{label}</span>
          {showBadge && (
            <span
              className={[
                "rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none",
                active ? "bg-white/20 text-white" : "bg-white/15 text-brand-50",
              ].join(" ")}
              aria-label={`${badgeCount} pendências`}
            >
              {badgeCount}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
