import { useEffect, useMemo, useState } from "react";
import { Bar, Doughnut } from "react-chartjs-2";
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartOptions
} from "chart.js";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatNumberBR, formatPercentBR } from "../lib/formatters";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

type AgroCrmResponse = {
  kpis: {
    pipelineByCrop: Array<{ crop: string; value: number; weighted: number; count: number }>;
    pipelineBySeason: Array<{ season: string; value: number; weighted: number; count: number }>;
    topClientsByWeightedValue: Array<{ clientId: string; clientName: string; weightedValue: number; value: number; opportunities: number }>;
    overdueBySeller: Array<{ sellerId: string; sellerName: string; overdueCount: number; overdueValue: number }>;
    stageConversion: Array<{ fromStage: string; toStage: string; baseCount: number; progressedCount: number; conversionRate: number }>;
  };
  tables: {
    portfolioByPotentialHa: Array<{
      clientId: string;
      clientName: string;
      potentialHa: number;
      farmSizeHa: number;
      opportunities: number;
      weightedValue: number;
      potentialCoveragePercent: number;
    }>;
    opportunitiesByPlantingWindow: Array<{ month: string; opportunities: number; weightedValue: number; pipelineValue: number }>;
  };
};

const cardClass = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
const chartPalette = ["#2563eb", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

const stageLabels: Record<string, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const baseChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: {
        color: "#334155",
        font: { family: "Inter, ui-sans-serif, system-ui", size: 12, weight: 600 }
      }
    }
  }
} as const;

const monthLabel = (value: string) => {
  const [year, month] = value.split("-");
  const dt = new Date(Number(year), Number(month) - 1, 1);
  return dt.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
};

export default function ReportsPage() {
  const [report, setReport] = useState<AgroCrmResponse | null>(null);

  useEffect(() => {
    api.get<AgroCrmResponse>("/reports/agro-crm").then((response) => setReport(response.data));
  }, []);

  const totals = useMemo(() => {
    const pipeline = report?.kpis.pipelineByCrop.reduce((sum, row) => sum + row.value, 0) || 0;
    const weighted = report?.kpis.pipelineByCrop.reduce((sum, row) => sum + row.weighted, 0) || 0;
    const overdue = report?.kpis.overdueBySeller.reduce((sum, row) => sum + row.overdueCount, 0) || 0;
    return { pipeline, weighted, overdue };
  }, [report]);

  const barOptions: ChartOptions<"bar"> = {
    ...baseChartOptions,
    plugins: {
      ...baseChartOptions.plugins,
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => formatCurrencyBRL(Number(ctx.raw || 0))
        }
      }
    },
    scales: {
      x: { ticks: { color: "#475569" }, grid: { color: "#e2e8f0" } },
      y: { ticks: { color: "#475569" }, grid: { color: "#e2e8f0" } }
    }
  };

  const overdueOptions: ChartOptions<"bar"> = {
    ...baseChartOptions,
    indexAxis: "y",
    plugins: {
      ...baseChartOptions.plugins,
      legend: { display: false }
    },
    scales: {
      x: { ticks: { color: "#475569" }, grid: { color: "#e2e8f0" } },
      y: { ticks: { color: "#475569" }, grid: { display: false } }
    }
  };

  if (!report) return <div className="rounded-xl border border-slate-200 bg-white p-6">Carregando relatório Agro CRM...</div>;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Relatórios</div>
        <h2 className="mt-1 text-2xl font-bold text-slate-900">Agro CRM</h2>
        <p className="mt-1 text-sm text-slate-600">Insights de carteira e pipeline para decisões comerciais de campo.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className={cardClass}><div className="text-sm text-slate-500">Pipeline total</div><div className="mt-2 text-2xl font-semibold">{formatCurrencyBRL(totals.pipeline)}</div></div>
        <div className={cardClass}><div className="text-sm text-slate-500">Pipeline ponderado</div><div className="mt-2 text-2xl font-semibold">{formatCurrencyBRL(totals.weighted)}</div></div>
        <div className={cardClass}><div className="text-sm text-slate-500">Oportunidades atrasadas</div><div className="mt-2 text-2xl font-semibold">{formatNumberBR(totals.overdue)}</div></div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={cardClass}>
          <h3 className="text-base font-semibold text-slate-900">Pipeline por cultura</h3>
          <div className="mt-4 h-72">
            <Bar
              options={barOptions}
              data={{
                labels: report.kpis.pipelineByCrop.map((item) => item.crop),
                datasets: [{ data: report.kpis.pipelineByCrop.map((item) => item.weighted), backgroundColor: chartPalette, borderRadius: 10 }]
              }}
            />
          </div>
        </section>

        <section className={cardClass}>
          <h3 className="text-base font-semibold text-slate-900">Pipeline por safra</h3>
          <div className="mt-4 h-72">
            <Doughnut
              options={{
                ...baseChartOptions,
                cutout: "58%",
                plugins: {
                  ...baseChartOptions.plugins,
                  tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatCurrencyBRL(Number(ctx.raw || 0))}` } }
                }
              }}
              data={{
                labels: report.kpis.pipelineBySeason.map((item) => item.season),
                datasets: [{ data: report.kpis.pipelineBySeason.map((item) => item.weighted), backgroundColor: chartPalette }]
              }}
            />
          </div>
        </section>

        <section className={cardClass}>
          <h3 className="text-base font-semibold text-slate-900">Oportunidades atrasadas por vendedor</h3>
          <div className="mt-4 h-72">
            <Bar
              options={overdueOptions}
              data={{
                labels: report.kpis.overdueBySeller.map((item) => item.sellerName),
                datasets: [{ data: report.kpis.overdueBySeller.map((item) => item.overdueCount), backgroundColor: "#f97316", borderRadius: 8 }]
              }}
            />
          </div>
        </section>

        <section className={cardClass}>
          <h3 className="text-base font-semibold text-slate-900">Conversão por etapa (simples)</h3>
          <div className="mt-4 space-y-4">
            {report.kpis.stageConversion.map((item) => (
              <div key={`${item.fromStage}-${item.toStage}`}>
                <div className="mb-1 flex items-center justify-between text-sm text-slate-600">
                  <span>{stageLabels[item.fromStage]} → {stageLabels[item.toStage]}</span>
                  <span className="font-semibold text-slate-900">{formatPercentBR(item.conversionRate)}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-blue-600" style={{ width: `${Math.min(item.conversionRate, 100)}%` }} />
                </div>
                <div className="mt-1 text-xs text-slate-500">{item.progressedCount} de {item.baseCount} oportunidades</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className={cardClass}>
        <h3 className="mb-4 text-base font-semibold text-slate-900">Top 10 clientes por valor ponderado</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Valor ponderado</th>
                <th className="py-2 pr-3 font-medium">Pipeline bruto</th>
                <th className="py-2 pr-3 font-medium">Oportunidades</th>
              </tr>
            </thead>
            <tbody>
              {report.kpis.topClientsByWeightedValue.map((row) => (
                <tr key={row.clientId} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-700">{row.clientName}</td>
                  <td className="py-2 pr-3 font-semibold text-slate-900">{formatCurrencyBRL(row.weightedValue)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatCurrencyBRL(row.value)}</td>
                  <td className="py-2 pr-3 text-slate-700">{row.opportunities}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={cardClass}>
          <h3 className="mb-4 text-base font-semibold text-slate-900">Carteira por potencial (ha)</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-3 font-medium">Cliente</th>
                  <th className="py-2 pr-3 font-medium">Potencial (ha)</th>
                  <th className="py-2 pr-3 font-medium">Área total (ha)</th>
                  <th className="py-2 pr-3 font-medium">Cobertura</th>
                </tr>
              </thead>
              <tbody>
                {report.tables.portfolioByPotentialHa.map((row) => (
                  <tr key={row.clientId} className="border-b border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">{row.clientName}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatNumberBR(row.potentialHa)}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatNumberBR(row.farmSizeHa)}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatPercentBR(row.potentialCoveragePercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={cardClass}>
          <h3 className="mb-4 text-base font-semibold text-slate-900">Oportunidades por janela de plantio</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-3 font-medium">Mês</th>
                  <th className="py-2 pr-3 font-medium">Qtd oportunidades</th>
                  <th className="py-2 pr-3 font-medium">Pipeline bruto</th>
                  <th className="py-2 pr-3 font-medium">Pipeline ponderado</th>
                </tr>
              </thead>
              <tbody>
                {report.tables.opportunitiesByPlantingWindow.map((row) => (
                  <tr key={row.month} className="border-b border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">{monthLabel(row.month)}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatNumberBR(row.opportunities)}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatCurrencyBRL(row.pipelineValue)}</td>
                    <td className="py-2 pr-3 font-semibold text-slate-900">{formatCurrencyBRL(row.weightedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
