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

type ClosedOpportunityStage = "ganho" | "perdido";
type ClosedOpportunity = {
  id: string;
  title: string;
  value: number;
  stage: ClosedOpportunityStage;
  client: string;
  owner: string;
  crop?: string | null;
  season?: string | null;
  expectedCloseDate: string;
};

type PaginatedClosedOpportunitiesResponse = {
  items: ClosedOpportunity[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type ClosedFilters = {
  dateFrom: string;
  dateTo: string;
  ownerSellerId: string;
  clientId: string;
  crop: string;
  season: string;
  stage: "" | ClosedOpportunityStage;
};

type SelectOption = { id: string; name: string };

const toDateInput = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const getClosedDefaultFilters = (): ClosedFilters => {
  const today = new Date();
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(today.getDate() - 90);

  return {
    dateFrom: toDateInput(ninetyDaysAgo),
    dateTo: toDateInput(today),
    ownerSellerId: "",
    clientId: "",
    crop: "",
    season: "",
    stage: ""
  };
};

const cardClass = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
const chartPalette = ["#0B3C1D", "#236F3C", "#348A4F", "#5DAA72", "#8CC49B", "#F59E0B", "#CA8A04", "#4B5563"];

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
        color: "#374151",
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
  const [closedFilters, setClosedFilters] = useState<ClosedFilters>(getClosedDefaultFilters);
  const [closedItems, setClosedItems] = useState<ClosedOpportunity[]>([]);
  const [closedTotals, setClosedTotals] = useState({ total: 0, page: 1, pageSize: 10, totalPages: 1 });
  const [closedLoading, setClosedLoading] = useState(true);
  const [closedKpiItems, setClosedKpiItems] = useState<ClosedOpportunity[]>([]);
  const [sellerOptions, setSellerOptions] = useState<SelectOption[]>([]);
  const [clientOptions, setClientOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    api.get<AgroCrmResponse>("/reports/agro-crm").then((response) => setReport(response.data));
    Promise.all([api.get("/users"), api.get("/clients")]).then(([usersRes, clientsRes]) => {
      const users = Array.isArray(usersRes.data) ? usersRes.data : [];
      const sellers = users.filter((item: any) => item?.role === "vendedor" && item?.id && item?.name);
      const clients = Array.isArray(clientsRes.data) ? clientsRes.data : [];

      setSellerOptions(sellers.map((item: any) => ({ id: item.id, name: item.name })));
      setClientOptions(clients.filter((item: any) => item?.id && item?.name).map((item: any) => ({ id: item.id, name: item.name })));
    });
  }, []);


  useEffect(() => {
    setClosedTotals((prev) => ({ ...prev, page: 1 }));
  }, [closedFilters]);

  useEffect(() => {
    setClosedLoading(true);
    const params = new URLSearchParams({
      status: "closed",
      page: String(closedTotals.page),
      pageSize: String(closedTotals.pageSize)
    });

    Object.entries(closedFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    const kpiParams = new URLSearchParams(params);
    kpiParams.delete("page");
    kpiParams.delete("pageSize");

    Promise.all([
      api.get<PaginatedClosedOpportunitiesResponse>(`/opportunities?${params.toString()}`),
      api.get<ClosedOpportunity[]>(`/opportunities?${kpiParams.toString()}`)
    ])
      .then(([paginatedResponse, kpiResponse]) => {
        setClosedItems(paginatedResponse.data.items || []);
        setClosedKpiItems(Array.isArray(kpiResponse.data) ? kpiResponse.data : []);
        setClosedTotals({
          total: paginatedResponse.data.total,
          page: paginatedResponse.data.page,
          pageSize: paginatedResponse.data.pageSize,
          totalPages: paginatedResponse.data.totalPages
        });
      })
      .finally(() => setClosedLoading(false));
  }, [closedFilters, closedTotals.page, closedTotals.pageSize]);

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
      x: { ticks: { color: "#4b5563" }, grid: { color: "#d1d5db" } },
      y: { ticks: { color: "#4b5563" }, grid: { color: "#d1d5db" } }
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
      x: { ticks: { color: "#4b5563" }, grid: { color: "#d1d5db" } },
      y: { ticks: { color: "#4b5563" }, grid: { display: false } }
    }
  };

  const closedKpis = useMemo(() => {
    const won = closedKpiItems.filter((item) => item.stage === "ganho");
    const lost = closedKpiItems.filter((item) => item.stage === "perdido");
    const totalWon = won.reduce((sum, item) => sum + item.value, 0);
    const totalLost = lost.reduce((sum, item) => sum + item.value, 0);
    const totalCount = closedKpiItems.length;
    const winRate = totalCount ? (won.length / totalCount) * 100 : 0;
    const averageWonTicket = won.length ? totalWon / won.length : 0;

    return { totalWon, totalLost, totalCount, winRate, averageWonTicket };
  }, [closedKpiItems]);

  const cropOptions = useMemo(() => Array.from(new Set(closedItems.map((item) => item.crop).filter(Boolean))) as string[], [closedItems]);
  const seasonOptions = useMemo(() => Array.from(new Set(closedItems.map((item) => item.season).filter(Boolean))) as string[], [closedItems]);

  if (!report) return <div className="rounded-xl border border-slate-200 bg-white p-6">Carregando relatório Agro CRM...</div>;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 via-white to-brand-100 p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Relatórios</div>
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
                datasets: [{ data: report.kpis.overdueBySeller.map((item) => item.overdueCount), backgroundColor: "#CA8A04", borderRadius: 8 }]
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
                  <div className="h-2 rounded-full bg-brand-600" style={{ width: `${Math.min(item.conversionRate, 100)}%` }} />
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

      <section className={cardClass}>
        <div className="mb-4 flex flex-col gap-2">
          <h3 className="text-base font-semibold text-slate-900">Oportunidades encerradas</h3>
          <p className="text-sm text-slate-500">Histórico de ganhos e perdas com busca rápida e paginação server-side.</p>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <input type="date" value={closedFilters.dateFrom} onChange={(e) => setClosedFilters((prev) => ({ ...prev, dateFrom: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input type="date" value={closedFilters.dateTo} onChange={(e) => setClosedFilters((prev) => ({ ...prev, dateTo: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <select value={closedFilters.ownerSellerId} onChange={(e) => setClosedFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Todos vendedores</option>
            {sellerOptions.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
          <select value={closedFilters.clientId} onChange={(e) => setClosedFilters((prev) => ({ ...prev, clientId: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Todos clientes</option>
            {clientOptions.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
          <select value={closedFilters.crop} onChange={(e) => setClosedFilters((prev) => ({ ...prev, crop: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Todas culturas</option>
            {cropOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
          </select>
          <select value={closedFilters.season} onChange={(e) => setClosedFilters((prev) => ({ ...prev, season: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Todas safras</option>
            {seasonOptions.map((season) => <option key={season} value={season}>{season}</option>)}
          </select>
          <select value={closedFilters.stage} onChange={(e) => setClosedFilters((prev) => ({ ...prev, stage: e.target.value as ClosedOpportunityStage | "" }))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Ganho + perdido</option>
            <option value="ganho">Ganho</option>
            <option value="perdido">Perdido</option>
          </select>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">Total ganho</div><div className="mt-1 text-lg font-semibold text-slate-900">{formatCurrencyBRL(closedKpis.totalWon)}</div></div>
          <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">Total perdido</div><div className="mt-1 text-lg font-semibold text-slate-900">{formatCurrencyBRL(closedKpis.totalLost)}</div></div>
          <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">Quantidade</div><div className="mt-1 text-lg font-semibold text-slate-900">{formatNumberBR(closedKpis.totalCount)}</div></div>
          <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">Taxa de ganho</div><div className="mt-1 text-lg font-semibold text-slate-900">{formatPercentBR(closedKpis.winRate)}</div></div>
          <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">Ticket médio ganho</div><div className="mt-1 text-lg font-semibold text-slate-900">{formatCurrencyBRL(closedKpis.averageWonTicket)}</div></div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-3 font-medium">Oportunidade</th>
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Vendedor</th>
                <th className="py-2 pr-3 font-medium">Cultura</th>
                <th className="py-2 pr-3 font-medium">Safra</th>
                <th className="py-2 pr-3 font-medium">Etapa</th>
                <th className="py-2 pr-3 font-medium">Valor</th>
              </tr>
            </thead>
            <tbody>
              {closedLoading ? (
                <tr><td colSpan={7} className="py-6 text-center text-slate-500">Carregando oportunidades encerradas...</td></tr>
              ) : closedItems.length === 0 ? (
                <tr><td colSpan={7} className="py-6 text-center text-slate-500">Nenhuma oportunidade encontrada para os filtros aplicados.</td></tr>
              ) : closedItems.map((item) => (
                <tr key={item.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-700">{item.title}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.client}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.owner}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.crop || "—"}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.season || "—"}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.stage === "ganho" ? "Ganho" : "Perdido"}</td>
                  <td className="py-2 pr-3 font-semibold text-slate-900">{formatCurrencyBRL(item.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="text-sm text-slate-500">Página {closedTotals.page} de {closedTotals.totalPages} • {formatNumberBR(closedTotals.total)} registros</div>
          <div className="flex items-center gap-2">
            <select
              value={closedTotals.pageSize}
              onChange={(e) => setClosedTotals((prev) => ({ ...prev, page: 1, pageSize: Number(e.target.value) }))}
              className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
            >
              {[10, 20, 50].map((size) => <option key={size} value={size}>{size}/pág.</option>)}
            </select>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              disabled={closedTotals.page <= 1 || closedLoading}
              onClick={() => setClosedTotals((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
            >Anterior</button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              disabled={closedTotals.page >= closedTotals.totalPages || closedLoading}
              onClick={() => setClosedTotals((prev) => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
            >Próxima</button>
          </div>
        </div>
      </section>
    </div>
  );
}
