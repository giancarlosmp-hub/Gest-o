import { useEffect, useState } from "react";
import api from "../../lib/apiClient";

type AgendaIntelligence = {
  date: string;
  summary: string;
  currentSchedule: Array<{
    agendaEventId: string;
    agendaStopId: string | null;
    title: string;
    city: string | null;
    fixedStartTime: string | null;
    currentOrder: number;
    priorityScore: number;
    priorityLevel: string;
  }>;
  suggestedOrder: Array<{
    agendaEventId: string;
    agendaStopId: string | null;
    suggestedOrder: number;
    reason: string;
    movable: boolean;
    warning: string | null;
  }>;
  suggestedInsertions: Array<{
    clientId: string;
    opportunityId: string | null;
    actionType: string;
    city: string | null;
    priorityScore: number;
    reason: string;
    suggestedPeriod: string;
  }>;
  conflicts: Array<{ type: string; description: string; severity: string }>;
  metrics: {
    totalStops: number;
    fixedStops: number;
    movableStops: number;
    stopsWithoutLocation: number;
    estimatedDistanceKm: number | null;
    optimizationConfidence: string;
  };
  source: "deterministic" | "ai";
};

type Props = { date: string; sellerId?: string };
const severityClass: Record<string, string> = {
  high: "border-red-200 bg-red-50 text-red-800",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

export default function AgendaIntelligencePanel({ date, sellerId }: Props) {
  const [data, setData] = useState<AgendaIntelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/ai/agenda-intelligence/day", {
        params: { date, sellerId, refresh: refresh || undefined },
      });
      setData(response.data);
    } catch {
      setError("Não foi possível carregar a análise inteligente agora.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, [date, sellerId]);

  return (
    <section className="rounded-xl border border-indigo-100 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            Agenda Inteligente
          </p>
          <h3 className="text-base font-semibold text-slate-900">
            Sugestão operacional do dia
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {data?.summary ||
              "Analisa compromissos, paradas, prioridades e limitações sem alterar sua agenda."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="rounded-lg border border-indigo-200 px-3 py-2 text-sm font-semibold text-indigo-700 disabled:opacity-60"
        >
          {loading ? "Atualizando..." : "Atualizar análise"}
        </button>
      </div>
      {error ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {error}
        </p>
      ) : null}
      {data ? (
        <div className="mt-4 space-y-3">
          <div className="grid gap-2 text-xs sm:grid-cols-5">
            <span className="rounded-lg bg-slate-50 p-2">
              Paradas: <strong>{data.metrics.totalStops}</strong>
            </span>
            <span className="rounded-lg bg-slate-50 p-2">
              Fixos: <strong>{data.metrics.fixedStops}</strong>
            </span>
            <span className="rounded-lg bg-slate-50 p-2">
              Flexíveis: <strong>{data.metrics.movableStops}</strong>
            </span>
            <span className="rounded-lg bg-slate-50 p-2">
              Sem coordenada:{" "}
              <strong>{data.metrics.stopsWithoutLocation}</strong>
            </span>
            <span className="rounded-lg bg-slate-50 p-2">
              Confiança: <strong>{data.metrics.optimizationConfidence}</strong>
            </span>
          </div>

          <div className="hidden gap-3 md:grid md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="mb-2 font-semibold text-slate-900">Ordem atual</p>
              {data.currentSchedule.map((item) => (
                <div
                  key={`${item.agendaEventId}-${item.agendaStopId || "event"}`}
                  className="mb-2 rounded-lg bg-slate-50 p-2 text-sm"
                >
                  <strong>
                    {item.currentOrder}. {item.title}
                  </strong>
                  <br />
                  <span className="text-slate-600">
                    {item.city || "Cidade não informada"} ·{" "}
                    {item.fixedStartTime || "flexível"} · prioridade{" "}
                    {item.priorityLevel}
                  </span>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-indigo-200 p-3">
              <p className="mb-2 font-semibold text-slate-900">
                Ordem sugerida
              </p>
              {data.suggestedOrder.map((item) => (
                <div
                  key={`${item.agendaEventId}-${item.agendaStopId || "event"}`}
                  className="mb-2 rounded-lg bg-indigo-50 p-2 text-sm"
                >
                  <strong>
                    {item.suggestedOrder}.{" "}
                    {item.movable ? "Reordenável" : "Fixo"}
                  </strong>
                  <br />
                  <span className="text-slate-700">{item.reason}</span>
                  {item.warning ? (
                    <p className="text-xs text-amber-700">{item.warning}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2 md:hidden">
            <details open className="rounded-xl border border-slate-200 p-3">
              <summary className="cursor-pointer font-semibold">
                Ordem atual
              </summary>
              {data.currentSchedule.map((item) => (
                <p
                  key={`${item.agendaEventId}-${item.agendaStopId || "event"}`}
                  className="mt-2 rounded-lg bg-slate-50 p-2 text-sm"
                >
                  {item.currentOrder}. {item.title}
                  <br />
                  <span className="text-xs text-slate-600">
                    {item.city || "Sem cidade"} ·{" "}
                    {item.fixedStartTime || "flexível"}
                  </span>
                </p>
              ))}
            </details>
            <details className="rounded-xl border border-indigo-200 p-3">
              <summary className="cursor-pointer font-semibold">
                Ordem sugerida
              </summary>
              {data.suggestedOrder.map((item) => (
                <p
                  key={`${item.agendaEventId}-${item.agendaStopId || "event"}`}
                  className="mt-2 rounded-lg bg-indigo-50 p-2 text-sm"
                >
                  {item.suggestedOrder}. {item.reason}
                </p>
              ))}
            </details>
          </div>

          {data.conflicts.length ? (
            <div className="space-y-2">
              <p className="font-semibold text-slate-900">
                Conflitos e limitações
              </p>
              {data.conflicts.map((conflict, index) => (
                <p
                  key={`${conflict.type}-${index}`}
                  className={`rounded-lg border p-2 text-sm ${severityClass[conflict.severity] || severityClass.low}`}
                >
                  {conflict.description}
                </p>
              ))}
            </div>
          ) : null}
          {data.suggestedInsertions.length ? (
            <div className="space-y-2">
              <p className="font-semibold text-slate-900">
                Inserções sugeridas (não aplicadas)
              </p>
              {data.suggestedInsertions.map((item) => (
                <p
                  key={`${item.clientId}-${item.opportunityId || "client"}`}
                  className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800"
                >
                  Visita em {item.city || "região compatível"} · prioridade{" "}
                  {item.priorityScore} · {item.suggestedPeriod}: {item.reason}
                </p>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-slate-500">
            Somente leitura · fonte {data.source} · distância por Haversine é
            linha reta quando disponível, não rota rodoviária.
          </p>
        </div>
      ) : null}
    </section>
  );
}
