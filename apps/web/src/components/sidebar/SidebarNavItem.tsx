import { Link } from "react-router-dom";
import { useEffect, useId, useRef, useState } from "react";

type SidebarNavItemProps = {
  to: string;
  active: boolean;
  label: string;
  badgeCount?: number;
  tooltipText?: string;
  onClick?: () => void;
};

export default function SidebarNavItem({
  to,
  active,
  label,
  badgeCount = 0,
  tooltipText,
  onClick,
}: SidebarNavItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const shouldShowBadge = badgeCount > 0;
  const shouldShowTooltip = shouldShowBadge && Boolean(tooltipText);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDownOutside);
    return () => document.removeEventListener("pointerdown", handlePointerDownOutside);
  }, [isOpen]);

  const openTooltip = () => {
    if (shouldShowTooltip) setIsOpen(true);
  };

  const closeTooltip = () => setIsOpen(false);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={openTooltip}
      onMouseLeave={closeTooltip}
      onFocus={openTooltip}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closeTooltip();
        }
      }}
    >
      <Link
        to={to}
        onClick={onClick}
        title={tooltipText}
        aria-label={shouldShowTooltip ? `${label}: ${tooltipText}` : label}
        aria-describedby={shouldShowTooltip && isOpen ? tooltipId : undefined}
        className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
          active ? "bg-white text-brand-700" : "hover:bg-brand-600"
        }`}
      >
        <span>{label}</span>
        {shouldShowBadge && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold leading-none ${
              active ? "bg-brand-700 text-white" : "bg-white/20 text-white"
            }`}
            aria-label={`${badgeCount} ${badgeCount === 1 ? "pendência" : "pendências"}`}
          >
            {badgeCount}
          </span>
        )}
      </Link>

      {shouldShowTooltip && (
        <button
          type="button"
          className="absolute right-2 top-1/2 h-6 w-10 -translate-y-1/2 rounded-full"
          aria-label={`Detalhar ${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
        />
      )}

      {shouldShowTooltip && isOpen && (
        <div
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute left-3 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-lg"
        >
          {tooltipText}
        </div>
      )}
    </div>
  );
}
