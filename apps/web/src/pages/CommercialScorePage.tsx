import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar } from "react-chartjs-2";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartOptions
} from "chart.js";

import api from "../lib/apiClient";
import { formatPercentBR } from "../lib/formatters";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type CommercialScoreSeller = {
  sellerId: string;
  sellerName: string;
  disciplineScore: number;
  pipelineScore: number;
  resultScore: number;
  finalScore: number;
};

type CommercialScoreResponse = {
  sellers: CommercialScoreSeller[];
};

const cardClass = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

const getCurrentMonth = () => new Date().toISOString().slice(0, 7);

const getScoreColorClass = (score: number) => {
  if (score > 80) return "bg-emerald-100 text-emerald-700";
  if (score >= 60) return "bg-amber-100 text-amber-700";
  return "bg-rose-100 text-rose-700";
};

export default function CommercialScorePage() {
  const [month, setMonth] = useState(getCurrentMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<CommercialScoreSeller[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.get<CommercialScoreResponse>(`/reports/commercial-score?month=${month}`, {
          signal: controller.signal
        });
        setRows(response.data.sellers || []);
      } catch {
        setError("Não foi possível carregar o score comercial.");
      } finally {
        setLoading(false);
      }
    };

    load();

    return () => controller.abort();
  }, [month]);

  const chartData = useMemo(
    () => ({
      labels: rows.map((item) => item.sellerName),
      datasets: [
        {
          label: "Execução",
          data: rows.map((item) => Number((item.disciplineScore * 0.4).toFixed(2))),
          backgroundColor: "#0f766e"
        },
        {
          label: "Pipeline",
          data: rows.map((item) => Number((item.pipelineScore * 0.3).toFixed(2))),
          backgroundColor: "#2563eb"
        },
        {
          label: "Resultado",
          data: rows.map((item) => Number((item.resultScore * 0.3).toFixed(2))),
          backgroundColor: "#f59e0b"
        }
      ]
    }),
    [rows]
  );

  const chartOptions: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        stacked: true,
        ticks: { color: "#475569" },
        grid: { display: false }
      },
      y: {
        stacked: true,
        beginAtZero: true,
        max: 100,
        ticks: {
          color: "#475569",
          callback: (value) => `${value}%`
        },
        grid: { color: "#e2e8f0" }
      }
    },
    plugins: {
      legend: {
        labels: {
          color: "#334155",
          font: { weight: 600 }
        }
      },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${formatPercentBR(Number(ctx.raw || 0))}`
        }
      }
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 via-white to-brand-100 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Dashboard</div>
            <h2 className="mt-1 text-2xl font-bold text-slate-900">Score Comercial</h2>
            <p className="mt-1 text-sm text-slate-600">Indicador unificado de execução, pipeline e resultado por vendedor.</p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="month" className="text-sm font-medium text-slate-600">Mês</label>
            <input
              id="month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-500"
            />
            <Link to="/dashboard" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Voltar ao Dashboard
            </Link>
          </div>
        </div>
      </div>

      {loading && <div className={cardClass}>Carregando score comercial...</div>}
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}

      {!loading && !error && (
        <>
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-slate-900">Gráfico de composição do score</h3>
            <p className="mt-1 text-sm text-slate-500">Barras empilhadas com contribuição de cada dimensão para o score final.</p>
            <div className="mt-4 h-[320px]">
              <Bar data={chartData} options={chartOptions} />
            </div>
          </div>

          <div className={cardClass}>
            <h3 className="text-base font-semibold text-slate-900">Ranking geral</h3>
            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Sem dados para o mês selecionado.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="pb-2 pr-3">Posição</th>
                      <th className="pb-2 pr-3">Vendedor</th>
                      <th className="pb-2 pr-3">Execução</th>
                      <th className="pb-2 pr-3">Pipeline</th>
                      <th className="pb-2 pr-3">Resultado</th>
                      <th className="pb-2 pr-0">Score final</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={row.sellerId} className="border-b border-slate-100 text-slate-700">
                        <td className="py-2.5 pr-3 font-semibold text-slate-900">#{index + 1}</td>
                        <td className="py-2.5 pr-3">{row.sellerName}</td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.disciplineScore)}</td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.pipelineScore)}</td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.resultScore)}</td>
                        <td className="py-2.5 pr-0">
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${getScoreColorClass(row.finalScore)}`}>
                            {formatPercentBR(row.finalScore)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
