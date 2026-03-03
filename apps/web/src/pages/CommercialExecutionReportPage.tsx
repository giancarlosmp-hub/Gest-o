import { useEffect, useMemo, useState } from "react";
import { Bar } from "react-chartjs-2";
import { BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip } from "chart.js";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";
import { formatNumberBR, formatPercentBR } from "../lib/formatters";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type ReportSeller = {
  sellerId: string;
  sellerName: string;
  planned: number;
  executed: number;
  notExecuted: number;
  executionRate: number;
  punctualRate: number;
  followUps: number;
  opportunities: number;
};

type PlannedVsRealizedResponse = {
  totalPlanned: number;
  totalExecuted: number;
  totalNotExecuted: number;
  executionRate: number;
  punctualRate: number;
  followUpGenerated: number;
  opportunitiesGenerated: number;
  sellers: ReportSeller[];
};

type SelectOption = { id: string; name: string };

type WeeklyDisciplineItem = {
  sellerId: string;
  sellerName: string;
  planned: number;
  executed: number;
  minimumRequired: number;
  belowMinimum: boolean;
};

const toDateInput = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const getPerformanceClass = (rate: number) => {
  if (rate > 80) return "text-emerald-700";
  if (rate >= 60) return "text-amber-600";
  return "text-rose-600";
};

const cardClass = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

const getCurrentWeekStart = () => {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  return toDateInput(monday);
};

export default function CommercialExecutionReportPage() {
  const { user } = useAuth();
  const [report, setReport] = useState<PlannedVsRealizedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sellerOptions, setSellerOptions] = useState<SelectOption[]>([]);
  const [weeklyDiscipline, setWeeklyDiscipline] = useState<WeeklyDisciplineItem[]>([]);
  const [filters, setFilters] = useState(() => {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    return {
      from: toDateInput(monthStart),
      to: toDateInput(today),
      sellerId: ""
    };
  });

  const canFilterSeller = user?.role === "diretor" || user?.role === "gerente";

  useEffect(() => {
    if (!canFilterSeller) return;
    api.get("/users").then((response) => {
      const users = Array.isArray(response.data) ? response.data : [];
      const sellers = users.filter((item: any) => item?.role === "vendedor" && item?.id && item?.name);
      setSellerOptions(sellers.map((item: any) => ({ id: item.id, name: item.name })));
    });
  }, [canFilterSeller]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (canFilterSeller && filters.sellerId) params.set("sellerId", filters.sellerId);

    api
      .get<PlannedVsRealizedResponse>(`/reports/planned-vs-realized?${params.toString()}`)
      .then((response) => setReport(response.data))
      .finally(() => setLoading(false));
  }, [filters, canFilterSeller]);

  useEffect(() => {
    const params = new URLSearchParams({ weekStart: getCurrentWeekStart() });
    api.get<WeeklyDisciplineItem[]>(`/reports/weekly-discipline?${params.toString()}`).then((response) => {
      setWeeklyDiscipline(Array.isArray(response.data) ? response.data : []);
    });
  }, []);

  const chartData = useMemo(() => {
    const sellers = report?.sellers || [];
    return {
      labels: sellers.map((item) => item.sellerName),
      datasets: [
        { label: "Planejado", data: sellers.map((item) => item.planned), backgroundColor: "#94A3B8", borderRadius: 8 },
        { label: "Realizado", data: sellers.map((item) => item.executed), backgroundColor: "#0B3C1D", borderRadius: 8 }
      ]
    };
  }, [report]);

  if (loading || !report) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6">Carregando relatório de execução comercial...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 via-white to-brand-100 p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Relatórios</div>
        <h2 className="mt-1 text-2xl font-bold text-slate-900">Execução Comercial</h2>
        <p className="mt-1 text-sm text-slate-600">Visão estratégica de planejado vs realizado por vendedor.</p>
      </div>

      <section className={cardClass}>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Data inicial</span>
            <input
              type="date"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
              value={filters.from}
              onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Data final</span>
            <input
              type="date"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
              value={filters.to}
              onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
            />
          </label>
          {canFilterSeller ? (
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">Vendedor</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={filters.sellerId}
                onChange={(event) => setFilters((prev) => ({ ...prev, sellerId: event.target.value }))}
              >
                <option value="">Todos</option>
                {sellerOptions.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-4">
        <div className={cardClass}><div className="text-sm text-slate-500">Planejadas</div><div className="mt-2 text-2xl font-semibold">{formatNumberBR(report.totalPlanned)}</div></div>
        <div className={cardClass}><div className="text-sm text-slate-500">Realizadas</div><div className="mt-2 text-2xl font-semibold">{formatNumberBR(report.totalExecuted)}</div></div>
        <div className={cardClass}><div className="text-sm text-slate-500">% Execução</div><div className={`mt-2 text-2xl font-semibold ${getPerformanceClass(report.executionRate)}`}>{formatPercentBR(report.executionRate)}</div></div>
        <div className={cardClass}><div className="text-sm text-slate-500">% Pontualidade</div><div className={`mt-2 text-2xl font-semibold ${getPerformanceClass(report.punctualRate)}`}>{formatPercentBR(report.punctualRate)}</div></div>
      </div>

      <section className={cardClass}>
        <h3 className="text-base font-semibold text-slate-900">Planejado vs Realizado por vendedor</h3>
        <div className="mt-4 h-72">
          <Bar
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top" as const } } }}
            data={chartData}
          />
        </div>
      </section>

      <section className={cardClass}>
        <h3 className="mb-4 text-base font-semibold text-slate-900">Detalhamento por vendedor</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-3 font-medium">Vendedor</th>
                <th className="py-2 pr-3 font-medium">Planejado</th>
                <th className="py-2 pr-3 font-medium">Realizado</th>
                <th className="py-2 pr-3 font-medium">Não realizado</th>
                <th className="py-2 pr-3 font-medium">% Execução</th>
                <th className="py-2 pr-3 font-medium">% Pontualidade</th>
                <th className="py-2 pr-3 font-medium">Follow-ups</th>
                <th className="py-2 pr-3 font-medium">Oportunidades</th>
              </tr>
            </thead>
            <tbody>
              {report.sellers.map((seller) => (
                <tr key={seller.sellerId} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-700">{seller.sellerName}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatNumberBR(seller.planned)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatNumberBR(seller.executed)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatNumberBR(seller.notExecuted)}</td>
                  <td className={`py-2 pr-3 font-semibold ${getPerformanceClass(seller.executionRate)}`}>{formatPercentBR(seller.executionRate)}</td>
                  <td className={`py-2 pr-3 font-semibold ${getPerformanceClass(seller.punctualRate)}`}>{formatPercentBR(seller.punctualRate)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatNumberBR(seller.followUps)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatNumberBR(seller.opportunities)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
          <div>Follow-ups gerados: <span className="font-semibold text-slate-900">{formatNumberBR(report.followUpGenerated)}</span></div>
          <div>Oportunidades geradas: <span className="font-semibold text-slate-900">{formatNumberBR(report.opportunitiesGenerated)}</span></div>
        </div>
      </section>

      <section className={cardClass}>
        <h3 className="mb-4 text-base font-semibold text-slate-900">Disciplina semanal (semana atual)</h3>
        <div className="space-y-3">
          {weeklyDiscipline.map((seller) => {
            const ratio = seller.minimumRequired > 0 ? seller.planned / seller.minimumRequired : 0;
            const isCritical = ratio < 0.7;

            return (
              <div
                key={seller.sellerId}
                className={`rounded-lg border px-4 py-3 ${
                  isCritical
                    ? "border-rose-300 bg-rose-50"
                    : seller.belowMinimum
                      ? "border-amber-300 bg-amber-50"
                      : "border-emerald-200 bg-emerald-50"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{seller.sellerName}</p>
                    <p className="text-sm text-slate-700">
                      Planejadas: {formatNumberBR(seller.planned)} · Executadas: {formatNumberBR(seller.executed)} · Meta mínima: {formatNumberBR(seller.minimumRequired)}
                    </p>
                  </div>
                  {isCritical ? (
                    <span className="rounded-full bg-rose-600 px-2 py-1 text-xs font-semibold text-white">Muito abaixo (&lt;70%)</span>
                  ) : seller.belowMinimum ? (
                    <span className="rounded-full bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-900">Abaixo do mínimo</span>
                  ) : (
                    <span className="rounded-full bg-emerald-600 px-2 py-1 text-xs font-semibold text-white">No mínimo esperado</span>
                  )}
                </div>
              </div>
            );
          })}
          {weeklyDiscipline.length === 0 ? <p className="text-sm text-slate-500">Nenhum vendedor encontrado para esta semana.</p> : null}
        </div>
      </section>
    </div>
  );
}
