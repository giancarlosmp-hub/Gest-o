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

type WeeklyVisitsItem = {
  userId: string;
  name: string;
  visitsDone: number;
  goal: number;
  medal: "gold" | "silver" | "bronze" | "none";
  missing: number;
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
  const [weeklyVisits, setWeeklyVisits] = useState<WeeklyVisitsItem[]>([]);
  const [isMobile, setIsMobile] = useState(false);
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
    api.get<WeeklyVisitsItem[]>(`/reports/weekly-visits?${params.toString()}`).then((response) => {
      setWeeklyVisits(Array.isArray(response.data) ? response.data : []);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
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
        <div className="mt-4 h-64 sm:h-72">
          <Bar
            options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top" as const, display: !isMobile }, tooltip: { enabled: true } }, scales: { x: { ticks: { autoSkip: true, maxTicksLimit: isMobile ? 4 : 12, maxRotation: 0 } } } }}
            data={chartData}
          />
        </div>
      </section>

      <section className={cardClass}>
        <h3 className="mb-4 text-base font-semibold text-slate-900">Detalhamento por vendedor</h3>
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[600px] w-full text-sm">
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
        <div className="space-y-3 md:hidden">
          {report.sellers.map((seller) => (
            <article key={seller.sellerId} className="rounded-xl border border-slate-200 p-3 text-sm">
              <h4 className="font-semibold text-slate-900">{seller.sellerName}</h4>
              <dl className="mt-2 space-y-1">
                <div className="flex justify-between gap-3"><dt className="text-slate-500">Planejado</dt><dd className="text-slate-700">{formatNumberBR(seller.planned)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">Realizado</dt><dd className="text-slate-700">{formatNumberBR(seller.executed)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">Não realizado</dt><dd className="text-slate-700">{formatNumberBR(seller.notExecuted)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">% Execução</dt><dd className={`font-semibold ${getPerformanceClass(seller.executionRate)}`}>{formatPercentBR(seller.executionRate)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">% Pontualidade</dt><dd className={`font-semibold ${getPerformanceClass(seller.punctualRate)}`}>{formatPercentBR(seller.punctualRate)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">Follow-ups</dt><dd className="text-slate-700">{formatNumberBR(seller.followUps)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-500">Oportunidades</dt><dd className="text-slate-700">{formatNumberBR(seller.opportunities)}</dd></div>
              </dl>
            </article>
          ))}
        </div>
        <div className="mt-4 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
          <div>Follow-ups gerados: <span className="font-semibold text-slate-900">{formatNumberBR(report.followUpGenerated)}</span></div>
          <div>Oportunidades geradas: <span className="font-semibold text-slate-900">{formatNumberBR(report.opportunitiesGenerated)}</span></div>
        </div>
      </section>

      <section className={cardClass}>
        <h3 className="mb-4 text-base font-semibold text-slate-900">Ranking semanal de visitas (semana atual)</h3>
        <div className="space-y-3">
          {weeklyVisits.map((seller, index) => (
            <div key={seller.userId} className="rounded-lg border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">{index + 1}º · {seller.name}</p>
                  <p className="text-sm text-slate-700">
                    Visitas concluídas: {formatNumberBR(seller.visitsDone)} / Meta: {formatNumberBR(seller.goal)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {seller.missing > 0 ? `Faltam ${formatNumberBR(seller.missing)} para a meta semanal.` : "Meta da semana atingida. Excelente ritmo!"}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                  {seller.medal === "gold" ? "🥇 Ouro" : seller.medal === "silver" ? "🥈 Prata" : seller.medal === "bronze" ? "🥉 Bronze" : "Sem medalha"}
                </span>
              </div>
            </div>
          ))}
          {weeklyVisits.length === 0 ? <p className="text-sm text-slate-500">Nenhum vendedor encontrado para esta semana.</p> : null}
        </div>
      </section>
    </div>
  );
}
