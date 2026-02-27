import { formatNumberBR } from "../lib/formatters";

type DonutLegendChipItem = {
  label: string;
  value: number;
  color: string;
};

type DonutLegendChipsProps = {
  items: DonutLegendChipItem[];
  total: number;
  formatValue?: (value: number) => string;
};

const formatPercent = (value: number) => `${value.toFixed(1).replace(".", ",")}%`;

export default function DonutLegendChips({ items, total, formatValue = formatNumberBR }: DonutLegendChipsProps) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
      {items.map((item) => {
        const percent = total > 0 ? (item.value / total) * 100 : 0;
        return (
          <div
            key={item.label}
            className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
            <span className="font-medium text-slate-800">{item.label}</span>
            <span className="text-slate-500">•</span>
            <span>{formatValue(item.value)}</span>
            <span className="text-slate-500">•</span>
            <span>{formatPercent(percent)}</span>
          </div>
        );
      })}
    </div>
  );
}
