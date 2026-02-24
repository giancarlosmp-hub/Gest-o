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
    </div>
  );
}
