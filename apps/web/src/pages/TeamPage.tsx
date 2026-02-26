import { useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal, UserRound } from "lucide-react";
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
import { formatCurrencyBRL, formatPercentBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";
import {
  type SellerCardMetrics,
  buildSellerMetrics,
  getCurrentMonthKey
} from "../lib/sellerMetrics";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type TeamUser = {
  id: string;
  name: string;
  role?: string;
  status?: string | null;
};

type TeamOpportunity = {
  id: string;
  value: number;
  stage: "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
  ownerSellerId: string;
  expectedCloseDate?: string;
  proposalDate?: string;
};

type TeamActivity = {
  id: string;
  ownerSellerId: string;
  createdAt: string;
};

type SellerObjective = {
  userId: string;
  month: number;
  year: number;
  amount: number;
};

const roleLabel: Record<string, string> = {
  diretor: "Diretor",
  gerente: "Gerente",
  vendedor: "Vendedor"
};

const statusLabel: Record<string, string> = {
  ativo: "Ativo",
  inativo: "Inativo"
};

const rankingMedalByPosition: Record<number, string> = {
  1: "🥇",
  2: "🥈",
  3: "🥉"
};

function formatRole(role?: string) {
  if (!role) return "Não informado";
  return roleLabel[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

function formatStatus(status?: string | null) {
  if (!status) return "Ativo";
  return statusLabel[status.toLowerCase()] ?? status;
}

export default function TeamPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"todos" | "vendedores">("todos");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TeamUser | null>(null);
  const [metricsBySeller, setMetricsBySeller] = useState<Record<string, SellerCardMetrics>>({});
  const [objectiveModalUser, setObjectiveModalUser] = useState<TeamUser | null>(null);
  const [objectiveAmount, setObjectiveAmount] = useState("");
  const [objectiveMonth, setObjectiveMonth] = useState(() => getCurrentMonthKey());
  const [savingObjective, setSavingObjective] = useState(false);
  const [teamActivitiesInMonth, setTeamActivitiesInMonth] = useState<number | null>(null);

  const isManagerProfile = user?.role === "gerente" || user?.role === "diretor";

  const loadTeamData = async (monthYear = objectiveMonth) => {
    const [yearString, monthString] = monthYear.split("-");
    const year = Number(yearString);
    const month = Number(monthString);
    const monthKey = `${yearString}-${monthString}`;

    const [usersResponse, opportunitiesResponse, activitiesResponse, objectivesResponse] = await Promise.all([
      api.get<TeamUser[]>("/users"),
      api.get<TeamOpportunity[]>("/opportunities"),
      api.get<TeamActivity[]>("/activities"),
      api.get<SellerObjective[]>(`/objectives?month=${month}&year=${year}`)
    ]);

    const loadedUsers = Array.isArray(usersResponse.data) ? usersResponse.data : [];
    const loadedOpportunities = Array.isArray(opportunitiesResponse.data) ? opportunitiesResponse.data : [];
    const loadedActivities = Array.isArray(activitiesResponse.data) ? activitiesResponse.data : [];
    const loadedObjectives = Array.isArray(objectivesResponse.data) ? objectivesResponse.data : [];
    const sellerIds = new Set(loadedUsers.filter((teamUser) => teamUser.role === "vendedor").map((teamUser) => teamUser.id));

    const activitiesInMonth = loadedActivities.filter((activity) => {
      if (!sellerIds.has(activity.ownerSellerId)) return false;
      return activity.createdAt?.slice(0, 7) === monthKey;
    }).length;

    const objectivesBySeller = loadedObjectives.reduce<Record<string, number>>((acc, objective) => {
      acc[objective.userId] = objective.amount;
      return acc;
    }, {});

    setUsers(loadedUsers);
    setTeamActivitiesInMonth(activitiesInMonth);
    setMetricsBySeller(buildSellerMetrics(loadedUsers, loadedOpportunities, loadedActivities, objectivesBySeller, monthKey));
  };

  useEffect(() => {
    const run = async () => {
      try {
        await loadTeamData(getCurrentMonthKey());
      } catch {
        const fallbackUsers = [
          { id: "seed-1", name: "Vendedor 1", role: "vendedor", status: "ativo" },
          { id: "seed-2", name: "Vendedora 2", role: "vendedor", status: "ativo" },
          { id: "seed-3", name: "Vendedor 3", role: "vendedor", status: "inativo" }
        ];

        setUsers(fallbackUsers);
        setTeamActivitiesInMonth(null);
        setMetricsBySeller(buildSellerMetrics(fallbackUsers, [], [], {}, getCurrentMonthKey()));
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, []);

  const filteredUsers = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return users
      .filter((teamUser) => (filter === "vendedores" ? teamUser.role === "vendedor" : true))
      .filter((teamUser) => teamUser.name.toLowerCase().includes(normalizedSearch));
  }, [users, search, filter]);

  const sellerRanking = useMemo(() => {
    return users
      .filter((teamUser) => teamUser.role === "vendedor")
      .map((teamUser) => ({
        seller: teamUser,
        metrics: metricsBySeller[teamUser.id]
      }))
      .sort((a, b) => (b.metrics?.monthlyRevenue ?? 0) - (a.metrics?.monthlyRevenue ?? 0));
  }, [users, metricsBySeller]);

  const topSellers = sellerRanking.slice(0, 3);

  const teamSummary = useMemo(() => {
    const sellerIds = new Set(users.filter((teamUser) => teamUser.role === "vendedor").map((teamUser) => teamUser.id));
    const metricsList = Array.from(sellerIds).map((sellerId) => metricsBySeller[sellerId]).filter((value): value is SellerCardMetrics => Boolean(value));

    const totalRevenue = metricsList.reduce((sum, metrics) => sum + (metrics.monthlyRevenue || 0), 0);
    const totalObjective = metricsList.reduce((sum, metrics) => sum + (metrics.objectiveAmount || 0), 0);
    const totalPipeline = metricsList.reduce((sum, metrics) => sum + (metrics.openPipelineValue || 0), 0);
    const totalActivities = teamActivitiesInMonth ?? 0;
    const progressPercent = totalObjective > 0 ? (totalRevenue / totalObjective) * 100 : 0;

    return {
      totalRevenue,
      totalObjective,
      totalPipeline,
      totalActivities,
      progressPercent
    };
  }, [users, metricsBySeller, teamActivitiesInMonth]);

  const barChartOptions = useMemo<ChartOptions<"bar">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          ticks: { color: "#4b5563" },
          grid: { color: "rgba(15, 23, 42, 0.06)" }
        },
        y: {
          ticks: { color: "#4b5563" },
          grid: { color: "rgba(15, 23, 42, 0.08)" }
        }
      }
    }),
    []
  );

  const revenueBySellerChartData = useMemo(() => {
    const labels = sellerRanking.map(({ seller }) => seller.name);
    const values = sellerRanking.map(({ metrics }) => metrics?.monthlyRevenue ?? 0);

    return {
      labels,
      datasets: [
        {
          label: "Faturado no mês",
          data: values,
          backgroundColor: "#0B3C1D",
          borderRadius: 6,
          maxBarThickness: 42
        }
      ]
    };
  }, [sellerRanking]);

  const progressBySellerChartData = useMemo(() => {
    const labels = sellerRanking.map(({ seller }) => seller.name);
    const values = sellerRanking.map(({ metrics }) => metrics?.progressPercent ?? 0);

    return {
      labels,
      datasets: [
        {
          label: "% realizado",
          data: values,
          backgroundColor: "#348A4F",
          borderRadius: 6,
          maxBarThickness: 42
        }
      ]
    };
  }, [sellerRanking]);

  const openObjectiveModal = (teamUser: TeamUser) => {
    setObjectiveModalUser(teamUser);
    setObjectiveAmount(String(metricsBySeller[teamUser.id]?.objectiveAmount ?? ""));
  };

  const handleSaveObjective = async () => {
    if (!objectiveModalUser) return;

    const [yearString, monthString] = objectiveMonth.split("-");
    const parsedAmount = Number(objectiveAmount.replace(",", "."));

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return;

    setSavingObjective(true);
    try {
      await api.put(`/objectives/${objectiveModalUser.id}`, {
        month: Number(monthString),
        year: Number(yearString),
        amount: parsedAmount
      });

      await loadTeamData(objectiveMonth);
      setObjectiveModalUser(null);
      setObjectiveAmount("");
    } finally {
      setSavingObjective(false);
    }
  };

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Equipe</h2>
        <p className="text-sm text-slate-500">Acompanhe e navegue pela sua equipe comercial.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <Search size={16} className="text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full bg-transparent text-sm text-slate-700 outline-none"
              placeholder="Buscar por nome"
            />
          </label>

          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <SlidersHorizontal size={16} className="text-slate-400" />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as "todos" | "vendedores")}
              className="w-full bg-transparent text-sm text-slate-700 outline-none"
            >
              <option value="todos">Todos</option>
              <option value="vendedores">Somente vendedores</option>
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Carregando equipe...
        </div>
      ) : (
        <>
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Consolidado do time</h3>
              <p className="text-sm text-slate-500">KPIs gerais do mês atual para acompanhamento rápido.</p>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Total faturado no mês</p>
                <p className="mt-1 text-base font-semibold text-slate-900">{formatCurrencyBRL(teamSummary.totalRevenue)}</p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Objetivo total do mês</p>
                <p className="mt-1 text-base font-semibold text-slate-900">{formatCurrencyBRL(teamSummary.totalObjective)}</p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">% realizado do time</p>
                <p className="mt-1 text-base font-semibold text-slate-900">{formatPercentBR(teamSummary.progressPercent, 0)}</p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Pipeline total do time</p>
                <p className="mt-1 text-base font-semibold text-slate-900">{formatCurrencyBRL(teamSummary.totalPipeline)}</p>
              </article>
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Atividades no mês</p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {teamActivitiesInMonth === null ? "N/D" : teamSummary.totalActivities}
                </p>
              </article>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-base font-semibold text-slate-900">Faturado por vendedor (mês)</h3>
              <div className="mt-4 h-72">
                <Bar data={revenueBySellerChartData} options={barChartOptions} />
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-base font-semibold text-slate-900">% realizado por vendedor</h3>
              <div className="mt-4 h-72">
                <Bar
                  data={progressBySellerChartData}
                  options={{
                    ...barChartOptions,
                    scales: {
                      ...barChartOptions.scales,
                      y: {
                        ticks: {
                          color: "#4b5563",
                          callback: (value) => `${Number(value)}%`
                        },
                        grid: { color: "rgba(15, 23, 42, 0.08)" }
                      }
                    }
                  }}
                />
              </div>
            </article>
          </section>

          {isManagerProfile && (
            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Ranking do time</h3>
                <p className="text-sm text-slate-500">Vendedores ordenados por faturado no mês atual.</p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {topSellers.map(({ seller, metrics }, index) => {
                  const position = index + 1;
                  return (
                    <article key={seller.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {rankingMedalByPosition[position]} {position}º lugar
                      </p>
                      <p className="mt-1 text-base font-semibold text-slate-900">{seller.name}</p>
                      <div className="mt-2 space-y-1 text-sm text-slate-600">
                        <p>Faturado mês: <span className="font-medium text-slate-900">{formatCurrencyBRL(metrics?.monthlyRevenue ?? 0)}</span></p>
                        <p>% realizado: <span className="font-medium text-slate-900">{formatPercentBR(metrics?.progressPercent ?? 0, 0)}</span></p>
                        <p>Pipeline total: <span className="font-medium text-slate-900">{formatCurrencyBRL(metrics?.openPipelineValue ?? 0)}</span></p>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Posição</th>
                      <th className="px-3 py-2 font-semibold">Nome</th>
                      <th className="px-3 py-2 font-semibold">Faturado mês</th>
                      <th className="px-3 py-2 font-semibold">% realizado</th>
                      <th className="px-3 py-2 font-semibold">Pipeline total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                    {sellerRanking.map(({ seller, metrics }, index) => {
                      const position = index + 1;
                      return (
                        <tr key={seller.id}>
                          <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900">
                            {position}º {rankingMedalByPosition[position] ?? ""}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">{seller.name}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatCurrencyBRL(metrics?.monthlyRevenue ?? 0)}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatPercentBR(metrics?.progressPercent ?? 0, 0)}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatCurrencyBRL(metrics?.openPipelineValue ?? 0)}</td>
                        </tr>
                      );
                    })}
                    {!sellerRanking.length && (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                          Nenhum vendedor encontrado para o ranking.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredUsers.map((teamUser) => {
              const metrics = metricsBySeller[teamUser.id];
              const objective = metrics?.objectiveAmount ?? 0;
              const progressWidth = objective > 0 ? Math.max(4, Math.min(100, metrics?.progressPercent ?? 0)) : 4;

              return (
                <article key={teamUser.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <h3 className="text-lg font-semibold text-slate-900">{teamUser.name}</h3>
                      <p className="text-sm text-slate-500">{formatRole(teamUser.role)}</p>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                      {formatStatus(teamUser.status)}
                    </span>
                  </div>

                  <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">Faturado no mês</p>
                      <p className="text-base font-semibold text-slate-900">
                        {formatCurrencyBRL(metrics?.monthlyRevenue ?? 0)}
                      </p>
                      {metrics?.isRevenueEstimated && (
                        <p className="text-xs text-amber-700">Valor estimado com base no pipeline atual.</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs text-slate-500">Oportunidades abertas</p>
                        <p className="font-semibold text-slate-900">{metrics?.openOpportunities ?? 0}</p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs text-slate-500">Pipeline aberto</p>
                        <p className="font-semibold text-slate-900">{formatCurrencyBRL(metrics?.openPipelineValue ?? 0)}</p>
                      </div>
                    </div>

                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">Última atividade</p>
                      <p className="text-sm font-medium text-slate-700">{metrics?.lastActivityLabel ?? "Sem atividades"}</p>
                    </div>

                    <div>
                      <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                        <span>Realizado ({formatCurrencyBRL(metrics?.monthlyRevenue ?? 0)})</span>
                        <span>{formatPercentBR(metrics?.progressPercent ?? 0, 0)}</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-200">
                        <div
                          className="h-2 rounded-full bg-brand-700 transition-all"
                          style={{ width: `${progressWidth}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">Objetivo do mês: {formatCurrencyBRL(objective)}</p>
                    </div>
                  </div>

                  {isManagerProfile && teamUser.role === "vendedor" && (
                    <button
                      onClick={() => openObjectiveModal(teamUser)}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800"
                    >
                      Definir objetivo
                    </button>
                  )}

                  <button
                    onClick={() => setSelected(teamUser)}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    <UserRound size={16} />
                    Ver detalhes
                  </button>
                </article>
              );
            })}

            {!filteredUsers.length && (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
                Nenhum vendedor encontrado para os filtros selecionados.
              </div>
            )}
          </div>
        </>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">Detalhes do vendedor</h3>
            <p className="mt-1 text-sm text-slate-500">
              Placeholder para próximos PRs com dados de performance e carteira.
            </p>

            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p><strong>Nome:</strong> {selected.name}</p>
              <p><strong>Role:</strong> {formatRole(selected.role)}</p>
              <p><strong>Status:</strong> {formatStatus(selected.status)}</p>
            </div>

            <button
              onClick={() => setSelected(null)}
              className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {objectiveModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">Definir objetivo</h3>
            <p className="mt-1 text-sm text-slate-500">Configure o objetivo mensal de {objectiveModalUser.name}.</p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Objetivo do mês (R$)</span>
                <input
                  value={objectiveAmount}
                  onChange={(event) => setObjectiveAmount(event.target.value)}
                  type="number"
                  min={0}
                  step="0.01"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Mês/ano (opcional)</span>
                <input
                  value={objectiveMonth}
                  onChange={(event) => setObjectiveMonth(event.target.value)}
                  type="month"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>
            </div>

            <div className="mt-5 flex items-center gap-2">
              <button
                onClick={() => setObjectiveModalUser(null)}
                className="inline-flex flex-1 items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveObjective}
                disabled={savingObjective}
                className="inline-flex flex-1 items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-60"
              >
                {savingObjective ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
