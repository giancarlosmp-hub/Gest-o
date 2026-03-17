import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";
import { ACTIVITY_TYPE_OPTIONS, normalizeActivityType } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";

type Seller = {
  id: string;
  name: string;
  role: "diretor" | "gerente" | "vendedor";
};

type ActivityKpi = {
  sellerId: string;
  month: string;
  type: string;
  targetValue: number;
};

type ActivityTypeKey = (typeof ACTIVITY_TYPE_OPTIONS)[number]["value"];
type KpiDraftBySeller = Record<string, Record<ActivityTypeKey, number>>;

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

const createEmptyDraft = (): Record<ActivityTypeKey, number> =>
  ACTIVITY_TYPE_OPTIONS.reduce((acc, option) => {
    acc[option.value] = 0;
    return acc;
  }, {} as Record<ActivityTypeKey, number>);

type ActivityKpisPageProps = {
  embedded?: boolean;
};

export default function ActivityKpisPage({ embedded = false }: ActivityKpisPageProps) {
  const { user, loading } = useAuth();
  const [month, setMonth] = useState(getCurrentMonth);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [draft, setDraft] = useState<KpiDraftBySeller>({});
  const [pageLoading, setPageLoading] = useState(true);
  const [savingSellerId, setSavingSellerId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const canAccess = user?.role === "diretor" || user?.role === "gerente";

  const loadData = async (selectedMonth = month) => {
    setPageLoading(true);
    setFeedback(null);

    try {
      const [usersResponse, kpisResponse] = await Promise.all([
        api.get<Seller[]>("/users"),
        api.get<ActivityKpi[]>(`/activity-kpis?month=${selectedMonth}`)
      ]);

      const sellerList = (usersResponse.data || []).filter((item) => item.role === "vendedor");
      const kpis = Array.isArray(kpisResponse.data) ? kpisResponse.data : [];

      const nextDraft = sellerList.reduce<KpiDraftBySeller>((acc, seller) => {
        acc[seller.id] = createEmptyDraft();
        return acc;
      }, {});

      for (const kpi of kpis) {
        const normalizedType = normalizeActivityType(kpi.type);
        if (!nextDraft[kpi.sellerId]) continue;
        if (!(normalizedType in nextDraft[kpi.sellerId])) continue;
        nextDraft[kpi.sellerId][normalizedType as ActivityTypeKey] = kpi.targetValue;
      }

      setSellers(sellerList);
      setDraft(nextDraft);
    } catch (error) {
      setFeedback(getApiErrorMessage(error, "Não foi possível carregar os KPIs de atividades."));
      setSellers([]);
      setDraft({});
    } finally {
      setPageLoading(false);
    }
  };

  useEffect(() => {
    if (canAccess) {
      void loadData(month);
    }
  }, [month, canAccess]);

  const hasSellers = useMemo(() => sellers.length > 0, [sellers]);

  const updateCell = (sellerId: string, type: ActivityTypeKey, value: string) => {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

    setDraft((prev) => ({
      ...prev,
      [sellerId]: {
        ...prev[sellerId],
        [type]: normalized
      }
    }));
  };

  const saveSeller = async (sellerId: string) => {
    const sellerDraft = draft[sellerId];
    if (!sellerDraft) return;

    setSavingSellerId(sellerId);
    setFeedback(null);

    try {
      await Promise.all(
        ACTIVITY_TYPE_OPTIONS.map((activityType) =>
          api.put(`/activity-kpis/${sellerId}`, {
            month,
            type: activityType.value,
            targetValue: Number(sellerDraft[activityType.value] ?? 0)
          })
        )
      );

      setFeedback("KPIs atualizados com sucesso.");
    } catch (error) {
      setFeedback(getApiErrorMessage(error, "Não foi possível salvar os KPIs. Tente novamente."));
    } finally {
      setSavingSellerId(null);
    }
  };

  if (loading) return <div className="p-8">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!canAccess) return <Navigate to="/dashboard" replace />;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:flex-row md:items-end md:justify-between">
        <div>
          {embedded ? (
            <>
              <h3 className="text-xl font-semibold text-slate-900">KPIs de Atividades</h3>
              <p className="text-sm text-slate-500">Defina as metas mensais por vendedor em um painel único e editável.</p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-slate-900">Configurações • KPIs de Atividades</h2>
              <p className="text-sm text-slate-500">Defina as metas mensais por vendedor em um painel único e editável.</p>
            </>
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Mês de referência
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none ring-brand-200 focus:ring"
          />
        </label>
      </div>

      {feedback && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {feedback}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        {pageLoading ? (
          <p className="py-8 text-center text-sm text-slate-500">Carregando vendedores e KPIs...</p>
        ) : !hasSellers ? (
          <p className="py-8 text-center text-sm text-slate-500">Nenhum vendedor encontrado.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sellers.map((seller) => (
              <article key={seller.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-slate-900">{seller.name}</h3>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Vendedor</span>
                </div>

                <div className="space-y-3">
                  {ACTIVITY_TYPE_OPTIONS.map((activityType) => (
                    <label key={`${seller.id}-${activityType.value}`} className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                      {activityType.label}
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={draft[seller.id]?.[activityType.value] ?? 0}
                        onChange={(event) => updateCell(seller.id, activityType.value, event.target.value)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none ring-brand-200 focus:ring"
                      />
                    </label>
                  ))}
                </div>

                <button
                  onClick={() => saveSeller(seller.id)}
                  disabled={savingSellerId === seller.id}
                  className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-brand-300"
                >
                  {savingSellerId === seller.id ? "Salvando..." : "Salvar KPIs"}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
