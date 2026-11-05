import { MERGE_KEEP_WARNING, mergeComparisonRows, type MergeClientSummary } from "../../lib/clientMerge";

// Comparação lado a lado de "Mesclar duplicado": cada coluna tem a escolha "Fica este cadastro".
type Props = {
  current: MergeClientSummary;
  candidate: MergeClientSummary;
  keepId: string | null;
  onKeepChange: (id: string) => void;
  disabled?: boolean;
};

export default function ClientMergeComparison({ current, candidate, keepId, onKeepChange, disabled }: Props) {
  const columns = [
    { client: current, title: "Este cadastro" },
    { client: candidate, title: "Outro cadastro" },
  ];
  return (
    <div className="space-y-3" data-merge-comparison="">
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900" role="note">
        {MERGE_KEEP_WARNING}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {columns.map(({ client, title }) => {
          const selected = keepId === client.id;
          return (
            <label
              key={client.id}
              className={`block min-w-0 cursor-pointer rounded-xl border p-3 ${selected ? "border-brand-600 ring-2 ring-brand-200" : "border-slate-200"}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="merge-keep"
                  value={client.id}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onKeepChange(client.id)}
                  className="h-4 w-4 text-brand-700"
                />
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
                {selected ? <span className="ml-auto text-xs font-semibold text-brand-700">Fica este cadastro</span> : null}
              </span>
              <span className="mt-2 block break-words text-sm font-semibold text-slate-900">{client.name}</span>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                {mergeComparisonRows(client).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="break-words text-right font-medium text-slate-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </label>
          );
        })}
      </div>
    </div>
  );
}
