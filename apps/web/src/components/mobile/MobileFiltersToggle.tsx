import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { mobileFiltersLabel } from "../../lib/opportunityFilters";

type MobileFiltersToggleProps = {
  activeCount: number;
  open: boolean;
  onToggle: () => void;
  panelId: string;
};

// Só no celular (abaixo de sm): recolhe os filtros num botão com a contagem dos ativos. No desktop some e os filtros
// ficam como sempre estiveram.
export default function MobileFiltersToggle({ activeCount, open, onToggle, panelId }: MobileFiltersToggleProps) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:hidden"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
    >
      <span className="inline-flex items-center gap-2">
        <SlidersHorizontal size={16} />
        {mobileFiltersLabel(activeCount)}
      </span>
      <ChevronDown size={16} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
  );
}
