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
import { useAuth } from "../context/AuthContext";
import { formatPercentBR } from "../lib/formatters";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type CommercialScoreSeller = {
  sellerId: string;
  sellerName: string;
  disciplineScore: number;
  pipelineScore: number;
  resultScore: number;
  finalScore: number;
  breakdown: {
    resultadoScore: number;
    disciplinaScore: number;
    pipelineScore: number;
    finalScore: number;
  };
  level: "Bronze" | "Prata" | "Ouro" | "Diamante" | null;
  medals: string[];
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

const medalClassByLabel: Record<string, string> = {
  Bronze: "bg-amber-100 text-amber-800 border-amber-200",
  Prata: "bg-slate-100 text-slate-700 border-slate-200",
  Ouro: "bg-yellow-100 text-yellow-800 border-yellow-200",
  Diamante: "bg-cyan-100 text-cyan-800 border-cyan-200",
  "Pontualidade Perfeita": "bg-emerald-100 text-emerald-800 border-emerald-200",
  "Executor da Semana": "bg-indigo-100 text-indigo-800 border-indigo-200",
  "Gerador de Oportunidades": "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200"
};

const getMedalClass = (medal: string) => medalClassByLabel[medal] || "bg-slate-100 text-slate-700 border-slate-200";

export default function CommercialScorePage() {
  const { user } = useAuth();
  const [month, setMonth] = useState(getCurrentMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<CommercialScoreSeller[]>([]);
  const [newMedalsBySeller, setNewMedalsBySeller] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.get<CommercialScoreResponse>(`/reports/commercial-score?month=${month}`, {
          signal: controller.signal
        });
        const nextRows = response.data.sellers || [];
        setRows((currentRows) => {
          const previousBySeller = currentRows.reduce<Record<string, Set<string>>>((acc, item) => {
            acc[item.sellerId] = new Set(item.medals);
            return acc;
          }, {});

          const discovered = nextRows.reduce<Record<string, string[]>>((acc, item) => {
            const previousMedals = previousBySeller[item.sellerId] || new Set<string>();
            const gained = item.medals.filter((medal) => !previousMedals.has(medal));
            if (gained.length) acc[item.sellerId] = gained;
            return acc;
          }, {});

          setNewMedalsBySeller(discovered);
          return nextRows;
        });
      } catch {
        setError("Não foi possível carregar o score comercial.");
      } finally {
        setLoading(false);
      }
    };

    load();

    return () => controller.abort();
  }, [month]);

  const visibleRows = useMemo(() => {
    if (user?.role !== "vendedor") return rows;

    const topThree = rows.slice(0, 3);
    const ownRow = rows.find((row) => row.sellerId === user.id);

    if (!ownRow) return topThree;
    if (topThree.some((row) => row.sellerId === ownRow.sellerId)) return topThree;

    return [...topThree, ownRow];
  }, [rows, user]);

  const chartData = useMemo(
    () => ({
      labels: visibleRows.map((item) => item.sellerName),
      datasets: [
        {
          label: "Execução",
          data: visibleRows.map((item) => Number((item.disciplineScore * 0.3).toFixed(2))),
          backgroundColor: "#0f766e"
        },
        {
          label: "Pipeline",
          data: visibleRows.map((item) => Number((item.pipelineScore * 0.2).toFixed(2))),
          backgroundColor: "#2563eb"
        },
        {
          label: "Resultado",
          data: visibleRows.map((item) => Number((item.resultScore * 0.5).toFixed(2))),
          backgroundColor: "#f59e0b"
        }
      ]
    }),
    [visibleRows]
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
            {visibleRows.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Sem dados para o mês selecionado.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-[600px] w-full text-sm">
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
                    {visibleRows.map((row) => {
                      const position = rows.findIndex((item) => item.sellerId === row.sellerId) + 1;
                      return (
                      <tr key={row.sellerId} className="border-b border-slate-100 text-slate-700">
                        <td className="py-2.5 pr-3 font-semibold text-slate-900">#{position}</td>
                        <td className="py-2.5 pr-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{row.sellerName}</span>
                            {row.medals.map((medal) => {
                              const hasJustWon = (newMedalsBySeller[row.sellerId] || []).includes(medal);
                              return (
                                <span
                                  key={`${row.sellerId}-${medal}`}
                                  className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getMedalClass(medal)} ${hasJustWon ? "animate-pulse" : ""}`}
                                >
                                  {medal}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.disciplineScore)}</td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.pipelineScore)}</td>
                        <td className="py-2.5 pr-3">{formatPercentBR(row.resultScore)}</td>
                        <td className="py-2.5 pr-0">
                          <span
                            title={`Resultado: ${formatPercentBR(row.breakdown.resultadoScore)} | Disciplina: ${formatPercentBR(row.breakdown.disciplinaScore)} | Pipeline: ${formatPercentBR(row.breakdown.pipelineScore)} | Final: ${formatPercentBR(row.breakdown.finalScore)}`}
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${getScoreColorClass(row.finalScore)}`}
                          >
                            {formatPercentBR(row.finalScore)}
                          </span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={cardClass}>
            <h3 className="text-base font-semibold text-slate-900">Hall da Performance</h3>
            <p className="mt-1 text-sm text-slate-500">Destaques de reconhecimento por nível e medalhas especiais.</p>
            {visibleRows.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Sem destaques no período.</p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visibleRows.map((row) => (
                  <article key={`hall-${row.sellerId}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="text-sm font-semibold text-slate-900">{row.sellerName}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {row.medals.length === 0 ? (
                        <span className="text-xs text-slate-500">Sem medalhas no momento</span>
                      ) : (
                        row.medals.map((medal) => {
                          const hasJustWon = (newMedalsBySeller[row.sellerId] || []).includes(medal);
                          return (
                            <span
                              key={`hall-${row.sellerId}-${medal}`}
                              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getMedalClass(medal)} ${hasJustWon ? "animate-pulse" : ""}`}
                            >
                              {medal}
                            </span>
                          );
                        })
                      )}
                    </div>
                    <div className="mt-3 text-xs text-slate-500">Score final: {formatPercentBR(row.finalScore)}</div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
