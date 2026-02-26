import { useEffect, useMemo, useState } from "react";
import { Doughnut, Line } from "react-chartjs-2";
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
import type {
  DashboardPortfolio,
  DashboardSalesSeries,
  DashboardSummary,
} from "@salesforce-pro/shared";

import api from "../lib/apiClient";
import {
  formatCompactNumberBR,
  formatCurrencyBRL,
  formatNumberBR,
  formatPercentBR,
} from "../lib/formatters";
import { useAuth } from "../context/AuthContext";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend
);

type SellerOption = { id: string; name: string; role: string };

const palette = {
  primary: "#0B3C1D",
  success: "#2f9e44",
  warning: "#f59e0b",
  danger: "#ca8a04",
  info: "#348A4F",
  textMuted: "#4b5563",
  border: "#d1d5db",
  surface: "#ffffff",
  rest: "#8CC49B",
};

const cardClass = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

const getCurrentMonth = () => new Date().toISOString().slice(0, 7);

const getBusinessDaysRemaining = (month: string) => {
  const [year, monthN] = month.split("-").map(Number);
  const now = new Date();
  const sameMonth = now.getFullYear() === year && now.getMonth() + 1 === monthN;
  const startDay = sameMonth ? now.getDate() : 1;
  const lastDay = new Date(year, monthN, 0).getDate();

  let count = 0;
  for (let day = startDay; day <= lastDay; day += 1) {
    const date = new Date(year, monthN - 1, day);
    const weekDay = date.getDay();
    if (weekDay >= 1 && weekDay <= 5) count += 1;
  }
  return count;
};

export default function DashboardPage() {
  const { user } = useAuth();
  const [month] = useState(getCurrentMonth());
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [series, setSeries] = useState<DashboardSalesSeries | null>(null);
  const [portfolio, setPortfolio] = useState<DashboardPortfolio | null>(null);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellerId, setSellerId] = useState("");

  useEffect(() => {
    if (user?.role === "vendedor") return;
    api.get<SellerOption[]>("/users").then((response) => {
      setSellers(response.data.filter((item) => item.role === "vendedor"));
    });
  }, [user?.role]);

  useEffect(() => {
    const querySeller = sellerId ? `&sellerId=${sellerId}` : "";
    Promise.all([
      api.get<DashboardSummary>(`/dashboard/summary?month=${month}${querySeller}`),
      api.get<DashboardSalesSeries>(`/dashboard/sales-series?month=${month}${querySeller}`),
      api.get<DashboardPortfolio>(`/dashboard/portfolio?month=${month}${querySeller}`),
    ]).then(([summaryResponse, seriesResponse, portfolioResponse]) => {
      setSummary(summaryResponse.data);
      setSeries(seriesResponse.data);
      setPortfolio(portfolioResponse.data);
    });
  }, [month, sellerId]);

  const lineOptions = useMemo<ChartOptions<"line">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: palette.textMuted, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatCurrencyBRL(Number(context.raw || 0))}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: palette.textMuted }, grid: { color: palette.border } },
        y: {
          ticks: { color: palette.textMuted, callback: (value) => formatCompactNumberBR(Number(value)) },
          grid: { color: palette.border },
        },
      },
    }),
    []
  );

  const doughnutOptions = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: { position: "bottom", labels: { color: palette.textMuted, usePointStyle: true } },
      },
    }),
    []
  );

  const salesPace = useMemo(() => {
    if (!summary || !series || !portfolio) return null;
    const soldInMonth = summary.totalRevenue;
    const soldToday = portfolio.soldToday;
    const objectiveMonth = series.objectiveTotal;
    const realizedPercent = objectiveMonth > 0 ? (soldInMonth / objectiveMonth) * 100 : 0;
    const missingToSell = Math.max(objectiveMonth - soldInMonth, 0);
    const remainingBusinessDays = getBusinessDaysRemaining(month);
    const requiredPerBusinessDay =
      remainingBusinessDays > 0 ? missingToSell / remainingBusinessDays : null;

    return {
      soldInMonth,
      soldToday,
      objectiveMonth,
      realizedPercent,
      missingToSell,
      requiredPerBusinessDay,
    };
  }, [summary, series, portfolio, month]);

  if (!summary || !series || !portfolio || !salesPace) {
    return <div className={cardClass}>Carregando dashboard...</div>;
  }

  return (
    <div className="space-y-4">
      {user?.role !== "vendedor" && (
        <div className={cardClass}>
          <label className="text-sm font-medium text-slate-600">Filtrar vendedor</label>
          <select
            value={sellerId}
            onChange={(event) => setSellerId(event.target.value)}
            className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          >
            <option value="">Todos vendedores</option>
            {sellers.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        {[
          ["Faturamento no mês", formatCurrencyBRL(summary.totalRevenue)],
          ["Vendas realizadas no mês", formatNumberBR(summary.totalSales)],
          ["Novos leads", formatNumberBR(summary.newLeads)],
          ["Conversão", formatPercentBR(summary.conversionRate)],
        ].map(([label, value]) => (
          <div key={String(label)} className={cardClass}>
            <div className="text-sm text-slate-500">{label}</div>
            <div className="text-2xl font-bold text-slate-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-900">Vendido x Objetivo do mês</h3>
        {series.objectiveTotal === 0 && (
          <div className="mt-2 text-sm text-amber-600">Objetivo do mês não definido.</div>
        )}
        <div className="mt-4 space-y-3">
          <div className="text-sm text-slate-600">Vendido no mês: <span className="font-semibold text-slate-900">{formatCurrencyBRL(salesPace.soldInMonth)}</span></div>
          <div className="text-sm text-slate-600">Vendido hoje: <span className="font-semibold text-slate-900">{formatCurrencyBRL(salesPace.soldToday)}</span></div>
          <div className="text-sm text-slate-600">Objetivo do mês: <span className="font-semibold text-slate-900">{formatCurrencyBRL(salesPace.objectiveMonth)}</span></div>
          <div>
            <div className="mb-1 flex items-center justify-between text-sm text-slate-600">
              <span>Realizado: {formatPercentBR(salesPace.realizedPercent)}</span>
              <span>{formatCurrencyBRL(salesPace.soldInMonth)} / {formatCurrencyBRL(salesPace.objectiveMonth)}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div
                className="h-2 rounded-full bg-brand-600"
                style={{ width: `${Math.min(salesPace.realizedPercent, 100)}%` }}
              />
            </div>
          </div>
          <div className="text-sm text-slate-600">Falta vender: <span className="font-semibold text-slate-900">{formatCurrencyBRL(salesPace.missingToSell)}</span></div>
          <div className="text-sm text-slate-600">Necessário vender por dia útil: <span className="font-semibold text-slate-900">{salesPace.requiredPerBusinessDay === null ? "—" : formatCurrencyBRL(salesPace.requiredPerBusinessDay)}</span></div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className={cardClass}>
          <h3 className="mb-2 font-semibold text-slate-800">Evolução diária</h3>
          <div className="h-72 w-full">
            <Line
              options={lineOptions}
              data={{
                labels: series.labels,
                datasets: [
                  {
                    label: "Faturado acumulado",
                    data: series.realizedAccumulated,
                    borderColor: palette.success,
                    backgroundColor: "rgba(47, 158, 68, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                  {
                    label: "Objetivo acumulado",
                    data: series.objectiveAccumulated,
                    borderColor: palette.primary,
                    backgroundColor: "rgba(11, 60, 29, 0.2)",
                    borderWidth: 2,
                    tension: 0.3,
                  },
                ],
              }}
            />
          </div>
        </div>

        <div className={cardClass}>
          <h3 className="mb-2 font-semibold text-slate-800">Carteira de clientes</h3>
          <div className="mb-3 text-sm text-slate-600">Total de clientes: <span className="font-semibold text-slate-900">{formatNumberBR(portfolio.totalClients)}</span></div>
          <div className="h-64 w-full">
            <Doughnut
              options={doughnutOptions}
              data={{
                labels: ["Ativos", "Inativos recentes", "Inativos antigos"],
                datasets: [
                  {
                    data: [portfolio.walletStatus.active, portfolio.walletStatus.inactiveRecent, portfolio.walletStatus.inactiveOld],
                    backgroundColor: [palette.success, palette.warning, palette.danger],
                    borderColor: palette.surface,
                    borderWidth: 2,
                  },
                ],
              }}
            />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
            <div>Ativos: <span className="font-semibold text-slate-900">{formatNumberBR(portfolio.walletStatus.active)}</span></div>
            <div>Inativos 31–90: <span className="font-semibold text-slate-900">{formatNumberBR(portfolio.walletStatus.inactiveRecent)}</span></div>
            <div>Inativos &gt;90: <span className="font-semibold text-slate-900">{formatNumberBR(portfolio.walletStatus.inactiveOld)}</span></div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className={cardClass}>
          <h3 className="mb-2 font-semibold text-slate-800">Curva ABC de clientes (últimos 90 dias)</h3>
          <div className="h-64 w-full">
            <Doughnut
              options={doughnutOptions}
              data={{
                labels: ["Classe A", "Classe B", "Classe C"],
                datasets: [
                  {
                    data: [
                      portfolio.abcCurve.A.percentRevenue,
                      portfolio.abcCurve.B.percentRevenue,
                      portfolio.abcCurve.C.percentRevenue,
                    ],
                    backgroundColor: [palette.primary, palette.info, palette.rest],
                    borderColor: palette.surface,
                    borderWidth: 2,
                  },
                ],
              }}
            />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
            <div>A: {formatPercentBR(portfolio.abcCurve.A.percentRevenue)} ({formatNumberBR(portfolio.abcCurve.A.clients)} clientes)</div>
            <div>B: {formatPercentBR(portfolio.abcCurve.B.percentRevenue)} ({formatNumberBR(portfolio.abcCurve.B.clients)} clientes)</div>
            <div>C: {formatPercentBR(portfolio.abcCurve.C.percentRevenue)} ({formatNumberBR(portfolio.abcCurve.C.clients)} clientes)</div>
          </div>
        </div>

        <div className={cardClass}>
          <h3 className="mb-3 font-semibold text-slate-800">Performance da equipe</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-3">Ranking</th>
                  <th className="py-2 pr-3">Vendedor</th>
                  <th className="py-2 pr-3">Vendas</th>
                  <th className="py-2 pr-3">Faturamento</th>
                  <th className="py-2 pr-3">Realizado</th>
                </tr>
              </thead>
              <tbody>
                {summary.performance.map((row, index) => {
                  const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "";
                  return (
                    <tr key={row.sellerId} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{medal || `#${index + 1}`}</td>
                      <td className="py-2 pr-3 font-medium text-slate-800">{row.seller}</td>
                      <td className="py-2 pr-3 text-slate-700">{formatNumberBR(row.sales)}</td>
                      <td className="py-2 pr-3 text-slate-700">{formatCurrencyBRL(row.revenue)}</td>
                      <td className="py-2 pr-3 text-slate-700">{formatPercentBR(row.realizedPercent)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
