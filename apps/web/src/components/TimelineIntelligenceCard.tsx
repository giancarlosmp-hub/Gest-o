import { useEffect, useMemo, useState } from "react";
import api from "../lib/apiClient";
import { getApiErrorMessage } from "../lib/apiError";

type Highlight = { type: string; title: string; description: string; occurredAt: string; importance: "low" | "medium" | "high" };
type Intelligence = {
  summary: string;
  status: "stable" | "attention" | "critical" | "progressing";
  highlights?: Highlight[];
  risks?: string[];
  recommendedNextAction?: string | null;
  source: "ai" | "deterministic";
};

type Props = { clientId?: string; opportunityId?: string };

const STATUS_LABEL: Record<Intelligence["status"], string> = {
  stable: "Estável",
  attention: "Atenção",
  critical: "Crítico",
  progressing: "Em avanço"
};

const STATUS_CLASS: Record<Intelligence["status"], string> = {
  stable: "border-emerald-200 bg-emerald-50 text-emerald-800",
  attention: "border-amber-200 bg-amber-50 text-amber-800",
  critical: "border-rose-200 bg-rose-50 text-rose-800",
  progressing: "border-sky-200 bg-sky-50 text-sky-800"
};

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data não informada" : date.toLocaleDateString("pt-BR");
};

export default function TimelineIntelligenceCard({ clientId, opportunityId }: Props) {
  const [data, setData] = useState<Intelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const endpoint = useMemo(() => {
    if (opportunityId) return `/ai/timeline-intelligence/opportunity/${opportunityId}`;
    if (clientId) return `/ai/timeline-intelligence/client/${clientId}`;
    return null;
  }, [clientId, opportunityId]);

  const load = async (refresh = false) => {
    if (!endpoint) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.get<Intelligence>(`${endpoint}${refresh ? "?refresh=true" : ""}`);
      setData(response.data);
    } catch (err) {
      setError(getApiErrorMessage(err, "Não foi possível carregar o resumo inteligente."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(false); }, [endpoint]);

  if (!endpoint) return null;

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm md:p-4" aria-label="Resumo inteligente da Timeline">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">Resumo inteligente da Timeline</h3>
            {data ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{data.source === "ai" ? "IA" : "Análise automática"}</span> : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">A Timeline cronológica original permanece abaixo.</p>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={loading} className="min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
          {loading ? "Atualizando..." : "Atualizar análise"}
        </button>
      </div>

      {loading && !data ? <p className="mt-3 text-sm text-slate-500">Gerando resumo inteligente...</p> : null}
      {error ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p> : null}
      {!loading && !error && !data ? <p className="mt-3 text-sm text-slate-500">Sem histórico suficiente para análise.</p> : null}

      {data ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className={`inline-flex w-fit items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_CLASS[data.status]}`} aria-label={`Status ${STATUS_LABEL[data.status]}`}>
              <span aria-hidden="true">●</span> {STATUS_LABEL[data.status]}
            </span>
            {data.recommendedNextAction ? <p className="text-sm text-slate-700"><strong>Próxima ação:</strong> {data.recommendedNextAction}</p> : null}
          </div>
          <p className={`${expanded ? "" : "line-clamp-3"} text-sm leading-6 text-slate-700`}>{data.summary}</p>
          {data.summary.length > 180 ? <button type="button" className="text-sm font-medium text-slate-700 underline" onClick={() => setExpanded((value) => !value)}>{expanded ? "Ver menos" : "Ver detalhes"}</button> : null}
          {data.highlights?.length ? (
            <div className="grid gap-2 md:grid-cols-3">
              {data.highlights.slice(0, 3).map((item, index) => (
                <article key={`${item.title}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">{item.title}</p>
                  <p className="mt-1 text-slate-600">{item.description}</p>
                  <p className="mt-2 text-xs text-slate-500">{formatDate(item.occurredAt)} · importância {item.importance}</p>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
