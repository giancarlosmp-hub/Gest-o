import { useEffect, useMemo, useState } from "react";
import api from "../lib/apiClient";
import { Line, Doughnut } from "react-chartjs-2";
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  TooltipItem,
} from "chart.js";
import { formatCompactNumber, formatCurrency, formatNumber, formatPercent } from "../lib/formatters";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend);

const CHART_COLORS = {
  primary: "#2563eb",
  primarySoft: "rgba(37, 99, 235, 0.15)",
  success: "#16a34a",
  successSoft: "rgba(22, 163, 74, 0.1)",
  muted: "#cbd5e1",
  text: "#0f172a",
  textMuted: "#64748b",
  grid: "rgba(148, 163, 184, 0.25)",
};

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
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          position: "bottom",
          align: "start",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            boxHeight: 10,
            padding: 16,
            color: CHART_COLORS.textMuted,
            font: { size: 12, family: "Inter, system-ui, sans-serif", weight: 600 },
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          titleColor: "#f8fafc",
          bodyColor: "#e2e8f0",
          titleFont: { size: 12, family: "Inter, system-ui, sans-serif", weight: 700 },
          bodyFont: { size: 12, family: "Inter, system-ui, sans-serif" },
          padding: 12,
          displayColors: true,
          callbacks: {
            label: (context: TooltipItem<"line">) => `${context.dataset.label}: ${formatCurrency(Number(context.parsed.y ?? 0))}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: CHART_COLORS.textMuted,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            font: { size: 11, family: "Inter, system-ui, sans-serif" },
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: CHART_COLORS.grid },
          border: { dash: [4, 4] },
          ticks: {
            color: CHART_COLORS.textMuted,
            callback: (value) => formatCompactNumber(Number(value)),
            font: { size: 11, family: "Inter, system-ui, sans-serif" },
          },
        },
      },
    }),
    [],
  );

  const doughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            boxHeight: 10,
            color: CHART_COLORS.textMuted,
            padding: 14,
            font: { size: 12, family: "Inter, system-ui, sans-serif", weight: 600 },
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          titleColor: "#f8fafc",
          bodyColor: "#e2e8f0",
          bodyFont: { size: 12, family: "Inter, system-ui, sans-serif" },
          callbacks: {
            label: (context: TooltipItem<"doughnut">) => `${context.label}: ${formatCurrency(Number(context.parsed ?? 0))}`,
          },
        },
      },
    }),
    [],
  );

  if (!summary || !series) return <div>Carregando dashboard...</div>;

  return <div className="space-y-4">
    <div className="grid md:grid-cols-4 gap-3">
      {[
        ["Faturamento total", formatCurrency(summary.totalRevenue)],
        ["Vendas realizadas", formatNumber(summary.totalSales)],
        ["Novos leads", formatNumber(summary.newLeads)],
        ["Taxa conversão", formatPercent(summary.conversionRate)],
      ].map(([k, v]) => <div key={String(k)} className="bg-white rounded-xl p-4 shadow"><div className="text-sm text-slate-500">{k}</div><div className="text-2xl font-bold text-slate-900">{v}</div></div>)}
    </div>

    <div className="grid lg:grid-cols-2 gap-4">
      <div className="bg-white p-4 rounded-xl shadow"><h3 className="font-semibold mb-2 text-slate-900">Evolução diária</h3><div className="h-[320px]"><Line options={lineOptions} data={{ labels: series.labels, datasets: [{ label: "Meta acumulada", data: series.target, borderColor: CHART_COLORS.primary, backgroundColor: CHART_COLORS.primarySoft, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5, tension: 0.3, fill: false }, { label: "Realizado acumulado", data: series.real, borderColor: CHART_COLORS.success, backgroundColor: CHART_COLORS.successSoft, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5, tension: 0.3, fill: true }] }} /></div></div>
      <div className="bg-white p-4 rounded-xl shadow"><h3 className="font-semibold mb-2 text-slate-900">Metas vs Realizado</h3><div className="h-[320px]"><Doughnut options={doughnutOptions} data={{ labels: ["Realizado", "Restante"], datasets: [{ data: [series.realizedTotal, Math.max(0, series.goalTotal - series.realizedTotal)], backgroundColor: [CHART_COLORS.primary, CHART_COLORS.muted], borderColor: "#ffffff", borderWidth: 2 }] }} /></div></div>
    </div>

    <div className="bg-white rounded-xl p-4 shadow">
      <h3 className="font-semibold mb-2">Performance da Equipe</h3>
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th>Vendedor</th><th>Vendas</th><th>Faturamento</th><th>Meta%</th></tr></thead><tbody>{summary.performance.map((p: any, idx: number) => <tr key={p.sellerId} className="border-b"><td>{idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : ""} {p.seller}</td><td>{formatNumber(p.sales)}</td><td>{formatCurrency(p.revenue)}</td><td><div className="bg-slate-200 h-2 rounded"><div className="bg-blue-600 h-2 rounded" style={{ width: `${Math.min(100, p.percent)}%` }} /></div> {formatPercent(p.percent)}</td></tr>)}</tbody></table>
    </div>

    <div className="bg-white rounded-xl p-4 shadow"><h3 className="font-semibold mb-2">Atividades recentes</h3><ul className="space-y-1">{summary.recentActivities.map((a: any) => <li key={a.id}>• {a.type} - {a.notes} ({a.done ? "Concluída" : "Pendente"})</li>)}</ul></div>
  </div>;
}
