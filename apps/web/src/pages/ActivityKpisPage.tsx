import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";

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

const activityTypes = [
  { key: "ligacao", label: "Ligação" },
  { key: "mensagem", label: "Mensagem" },
  { key: "visita_presencial", label: "Visita presencial" },
  { key: "envio_proposta", label: "Envio de proposta" },
  { key: "visita_tecnica", label: "Visita técnica" },
  { key: "cliente_novo", label: "Cliente novo (prospecção)" }
] as const;

type ActivityTypeKey = (typeof activityTypes)[number]["key"];
type KpiDraftBySeller = Record<string, Record<ActivityTypeKey, number>>;

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

const createEmptyDraft = (): Record<ActivityTypeKey, number> => ({
  ligacao: 0,
  mensagem: 0,
  visita_presencial: 0,
  envio_proposta: 0,
  visita_tecnica: 0,
  cliente_novo: 0
});

export default function ActivityKpisPage() {
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
        if (!nextDraft[kpi.sellerId]) continue;
        if (!(kpi.type in nextDraft[kpi.sellerId])) continue;
        nextDraft[kpi.sellerId][kpi.type as ActivityTypeKey] = kpi.targetValue;
      }

      setSellers(sellerList);
      setDraft(nextDraft);
    } catch {
      setFeedback("Não foi possível carregar os KPIs de atividades.");
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
        activityTypes.map((activityType) =>
          api.put(`/activity-kpis/${sellerId}`, {
            month,
            type: activityType.key,
            targetValue: Number(sellerDraft[activityType.key] ?? 0)
          })
        )
      );

      setFeedback("KPIs atualizados com sucesso.");
    } catch {
      setFeedback("Não foi possível salvar os KPIs. Tente novamente.");
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
          <h2 className="text-2xl font-bold text-slate-900">Configurações • KPIs de Atividades</h2>
          <p className="text-sm text-slate-500">Defina as metas mensais por vendedor em um painel único e editável.</p>
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

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">Vendedor</th>
                {activityTypes.map((activityType) => (
                  <th key={activityType.key} className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {activityType.label}
                  </th>
                ))}
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {pageLoading ? (
                <tr>
                  <td colSpan={activityTypes.length + 2} className="px-4 py-8 text-center text-sm text-slate-500">
                    Carregando vendedores e KPIs...
                  </td>
                </tr>
              ) : !hasSellers ? (
                <tr>
                  <td colSpan={activityTypes.length + 2} className="px-4 py-8 text-center text-sm text-slate-500">
                    Nenhum vendedor encontrado.
                  </td>
                </tr>
              ) : (
                sellers.map((seller) => (
                  <tr key={seller.id} className="hover:bg-slate-50/70">
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-slate-800">{seller.name}</td>
                    {activityTypes.map((activityType) => (
                      <td key={`${seller.id}-${activityType.key}`} className="px-3 py-2 text-center">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={draft[seller.id]?.[activityType.key] ?? 0}
                          onChange={(event) => updateCell(seller.id, activityType.key, event.target.value)}
                          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-center text-sm shadow-sm outline-none ring-brand-200 focus:ring"
                        />
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => saveSeller(seller.id)}
                        disabled={savingSellerId === seller.id}
                        className="inline-flex min-w-28 items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-brand-300"
                      >
                        {savingSellerId === seller.id ? "Salvando..." : "Salvar"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
