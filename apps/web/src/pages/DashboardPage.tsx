import { useEffect, useMemo, useState } from "react";
import { Line, Doughnut } from "react-chartjs-2";
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartOptions,
} from "chart.js";
import api from "../lib/apiClient";
import { formatCompactNumberBR, formatCurrencyBRL, formatNumberBR, formatPercentBR } from "../lib/formatters";
import { portfolioDashboardMock } from "../data/dashboardMock";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend);

const chartPalette = {
  primary: "#2563eb",
  success: "#16a34a",
  surface: "#f8fafc",
  text: "#0f172a",
  mutedText: "#475569",
  border: "#e2e8f0",
  doughnutRest: "#cbd5e1",
};

const baseChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
} as const;

export default function DashboardPage() {
  const [summary, setSummary] = useState<any>(null);
  const [series, setSeries] = useState<any>(null);

  useEffect(() => {
    const month = new Date().toISOString().slice(0, 7);
    Promise.all([api.get(`/dashboard/summary?month=${month}`), api.get(`/dashboard/sales-series?month=${month}`)]).then(([s, ss]) => {
      setSummary(s.data);
      setSeries(ss.data);
    });
  }, []);

  const lineOptions = useMemo<ChartOptions<"line">>(
    () => ({
      ...baseChartOptions,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: chartPalette.mutedText,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 16,
            font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 },
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          titleFont: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, ui-sans-serif, system-ui", size: 12 },
          padding: 10,
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatCurrencyBRL(Number(context.raw ?? 0))}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartPalette.mutedText, maxRotation: 0, autoSkipPadding: 12 },
          grid: { color: chartPalette.border, drawBorder: false },
        },
        y: {
          ticks: {
            color: chartPalette.mutedText,
            callback: (value) => formatCompactNumberBR(Number(value)),
          },
          grid: { color: chartPalette.border, drawBorder: false },
        },
      },
    }),
    []
  );

  const doughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      ...baseChartOptions,
      cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: chartPalette.mutedText,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 16,
            font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 },
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          titleFont: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, ui-sans-serif, system-ui", size: 12 },
          padding: 10,
          callbacks: {
            label: (context) => `${context.label}: ${formatCurrencyBRL(Number(context.raw ?? 0))}`,
          },
        },
      },
    }),
    []
  );

  const walletDistributionOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      ...baseChartOptions,
      cutout: "72%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: chartPalette.mutedText,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 14,
            font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 },
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${formatNumberBR(Number(context.raw ?? 0))} clientes`,
          },
        },
      },
    }),
    []
  );

  const abcCurveOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      ...baseChartOptions,
      cutout: "62%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: chartPalette.mutedText,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 14,
            font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 },
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${formatPercentBR(Number(context.raw ?? 0))}`,
          },
        },
      },
    }),
    []
  );

  const portfolioSalesOptions = useMemo<ChartOptions<"line">>(
    () => ({
      ...baseChartOptions,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: chartPalette.mutedText,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 14,
            font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 },
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatCurrencyBRL(Number(context.raw ?? 0))}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartPalette.mutedText, maxRotation: 0 },
          grid: { color: chartPalette.border, drawBorder: false },
        },
        y: {
          ticks: { color: chartPalette.mutedText, callback: (value) => formatCompactNumberBR(Number(value)) },
          grid: { color: chartPalette.border, drawBorder: false },
        },
      },
    }),
    []
  );

  const totalWallet = portfolioDashboardMock.walletStatus.reduce((acc, status) => acc + status.value, 0);
  const positivationPercent = (portfolioDashboardMock.positivation.positiveCustomers / portfolioDashboardMock.positivation.totalCustomers) * 100;

  if (!summary || !series) return <div>Carregando dashboard...</div>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {[
          ["Faturamento total", formatCurrencyBRL(summary.totalRevenue)],
          ["Vendas realizadas", formatNumberBR(summary.totalSales)],
          ["Novos leads", formatNumberBR(summary.newLeads)],
          ["Taxa conversão", formatPercentBR(summary.conversionRate)],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-sm text-slate-500">{k}</div>
            <div className="text-2xl font-bold text-slate-900">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 font-semibold text-slate-800">Evolução diária</h3>
          <div className="h-72 w-full">
            <Line
              options={lineOptions}
              data={{
                labels: series.labels,
                datasets: [
                  {
                    label: "Meta acumulada",
                    data: series.target,
                    borderColor: chartPalette.primary,
                    backgroundColor: "rgba(37, 99, 235, 0.15)",
                    borderWidth: 2,
                    tension: 0.35,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBorderWidth: 2,
                  },
                  {
                    label: "Realizado acumulado",
                    data: series.real,
                    borderColor: chartPalette.success,
                    backgroundColor: "rgba(22, 163, 74, 0.15)",
                    borderWidth: 2,
                    tension: 0.35,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBorderWidth: 2,
                  },
                ],
              }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 font-semibold text-slate-800">Metas vs Realizado</h3>
          <div className="h-72 w-full">
            <Doughnut
              options={doughnutOptions}
              data={{
                labels: ["Realizado", "Restante"],
                datasets: [
                  {
                    data: [series.realizedTotal, Math.max(0, series.goalTotal - series.realizedTotal)],
                    backgroundColor: [chartPalette.primary, chartPalette.doughnutRest],
                    borderColor: chartPalette.surface,
                    borderWidth: 3,
                    hoverOffset: 6,
                  },
                ],
              }}
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-semibold">Performance da Equipe</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>Vendedor</th>
              <th>Vendas</th>
              <th>Faturamento</th>
              <th>Meta%</th>
            </tr>
          </thead>
          <tbody>
            {summary.performance.map((p: any, idx: number) => (
              <tr key={p.sellerId} className="border-b">
                <td>
                  {idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : ""} {p.seller}
                </td>
                <td>{formatNumberBR(p.sales)}</td>
                <td>{formatCurrencyBRL(p.revenue)}</td>
                <td>
                  <div className="h-2 rounded bg-slate-200">
                    <div className="h-2 rounded bg-blue-600" style={{ width: `${Math.min(100, p.percent)}%` }} />
                  </div>{" "}
                  {formatPercentBR(p.percent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-semibold">Atividades recentes</h3>
        <ul className="space-y-1 text-sm text-slate-700">
          {summary.recentActivities.map((a: any) => (
            <li key={a.id}>
              • {a.type} - {a.notes} ({a.done ? "Concluída" : "Pendente"})
            </li>
          ))}
        </ul>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Gestão da Carteira</h2>
          <p className="text-sm text-slate-500">Indicadores de clientes e acompanhamento de metas comerciais.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">Carteira de clientes</h3>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">{formatNumberBR(totalWallet)} clientes</span>
            </div>
            <div className="h-72 w-full">
              <Doughnut
                options={walletDistributionOptions}
                data={{
                  labels: portfolioDashboardMock.walletStatus.map((item) => item.label),
                  datasets: [
                    {
                      data: portfolioDashboardMock.walletStatus.map((item) => item.value),
                      backgroundColor: portfolioDashboardMock.walletStatus.map((item) => item.color),
                      borderColor: "#ffffff",
                      borderWidth: 3,
                    },
                  ],
                }}
              />
            </div>
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">Curva ABC</h3>
              <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">Distribuição da receita</span>
            </div>
            <div className="h-72 w-full">
              <Doughnut
                options={abcCurveOptions}
                data={{
                  labels: portfolioDashboardMock.abcCurve.map((item) => `Classe ${item.label}`),
                  datasets: [
                    {
                      data: portfolioDashboardMock.abcCurve.map((item) => item.value),
                      backgroundColor: portfolioDashboardMock.abcCurve.map((item) => item.color),
                      borderColor: "#ffffff",
                      borderWidth: 3,
                    },
                  ],
                }}
              />
            </div>
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">Positivação de clientes</h3>
              <span className="text-sm font-semibold text-emerald-700">{formatPercentBR(positivationPercent)}</span>
            </div>
            <div className="rounded-lg bg-slate-100 p-3">
              <div className="mb-2 flex items-center justify-between text-sm text-slate-600">
                <span>Clientes positivados</span>
                <span>
                  {formatNumberBR(portfolioDashboardMock.positivation.positiveCustomers)} / {formatNumberBR(portfolioDashboardMock.positivation.totalCustomers)}
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-200">
                <div className="h-3 rounded-full bg-emerald-500" style={{ width: `${Math.min(100, positivationPercent)}%` }} />
              </div>
            </div>
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-800">Evolução de vendas no mês vs objetivo</h3>
            <div className="h-64 w-full">
              <Line
                options={portfolioSalesOptions}
                data={{
                  labels: portfolioDashboardMock.monthlySalesGoal.labels,
                  datasets: [
                    {
                      label: "Vendas acumuladas",
                      data: portfolioDashboardMock.monthlySalesGoal.achieved,
                      borderColor: chartPalette.success,
                      backgroundColor: "rgba(16, 185, 129, 0.15)",
                      borderWidth: 2,
                      tension: 0.35,
                      fill: true,
                      pointRadius: 3,
                    },
                    {
                      label: "Objetivo acumulado",
                      data: portfolioDashboardMock.monthlySalesGoal.goal,
                      borderColor: chartPalette.primary,
                      backgroundColor: "rgba(37, 99, 235, 0.1)",
                      borderWidth: 2,
                      tension: 0.35,
                      fill: false,
                      pointRadius: 3,
                    },
                  ],
                }}
              />
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
