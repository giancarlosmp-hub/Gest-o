import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, CircleDollarSign, MapPinned, Search, Target, TrendingUp } from "lucide-react";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";
import { formatCurrencyBRL, formatNumberBR, formatPercentBR } from "../lib/formatters";
import { getApiErrorMessage } from "../lib/apiError";

type SellerOption = {
  id: string;
  name: string;
  role: string;
  isActive?: boolean;
};

type TerritoryCityStatus = "positive" | "opportunity" | "no_sale" | "out_of_territory";

type TerritoryCity = {
  id?: string;
  city: string;
  state: string;
  status: TerritoryCityStatus;
  statusLabel: string;
  orderCount: number;
  soldValue: number;
  openOpportunityCount: number;
};

type TerritoryCoverageResponse = {
  month: string;
  seller: SellerOption;
  summary: {
    totalCities: number;
    positiveCities: number;
    opportunityCities: number;
    noSaleCities: number;
    coveragePercent: number;
    soldValue: number;
  };
  cities: TerritoryCity[];
  outOfTerritoryPreview?: TerritoryCity[];
};

const statusStyles: Record<TerritoryCityStatus, { badge: string; card: string; dot: string; label: string }> = {
  positive: {
    label: "Verde · Pedido ERP no mês",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    card: "border-emerald-200 bg-emerald-50/80",
    dot: "bg-emerald-500"
  },
  opportunity: {
    label: "Amarelo · Oportunidade aberta",
    badge: "bg-amber-100 text-amber-800 ring-amber-200",
    card: "border-amber-200 bg-amber-50/80",
    dot: "bg-amber-400"
  },
  no_sale: {
    label: "Vermelho · Sem venda",
    badge: "bg-red-100 text-red-800 ring-red-200",
    card: "border-red-200 bg-red-50/80",
    dot: "bg-red-500"
  },
  out_of_territory: {
    label: "Cinza · Fora do território",
    badge: "bg-slate-100 text-slate-700 ring-slate-200",
    card: "border-slate-200 bg-slate-100/80",
    dot: "bg-slate-400"
  }
};

function getCurrentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function SummaryCard({ title, value, icon: Icon, tone = "slate" }: { title: string; value: string; icon: typeof MapPinned; tone?: "slate" | "green" | "yellow" | "red" | "blue" }) {
  const toneClasses = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-700",
    yellow: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700"
  }[tone];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
        </div>
        <span className={`rounded-xl p-2 ${toneClasses}`}>
          <Icon size={20} />
        </span>
      </div>
    </div>
  );
}

export default function TerritoriosPage() {
  const { user } = useAuth();
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState("");
  const [month, setMonth] = useState(getCurrentMonthKey);
  const [coverage, setCoverage] = useState<TerritoryCoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";
  const visualCities = useMemo(() => [...(coverage?.cities ?? []), ...(coverage?.outOfTerritoryPreview ?? [])], [coverage]);
  const missingCities = Math.max((coverage?.summary.totalCities ?? 0) - (coverage?.summary.positiveCities ?? 0), 0);

  useEffect(() => {
    let mounted = true;
    setError(null);

    api.get<SellerOption[]>("/territories/sellers")
      .then(({ data }) => {
        if (!mounted) return;
        const loadedSellers = Array.isArray(data) ? data : [];
        setSellers(loadedSellers);
        setSelectedSellerId((current) => current || loadedSellers[0]?.id || "");
      })
      .catch((err) => {
        if (!mounted) return;
        setError(getApiErrorMessage(err, "Não foi possível carregar vendedores."));
      });

    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedSellerId) return;
    let mounted = true;
    setLoading(true);
    setError(null);

    api.get<TerritoryCoverageResponse>("/territories/coverage", { params: { sellerId: selectedSellerId, month } })
      .then(({ data }) => {
        if (!mounted) return;
        setCoverage(data);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(getApiErrorMessage(err, "Não foi possível carregar a cobertura do território."));
        setCoverage(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, [selectedSellerId, month]);

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 rounded-3xl bg-gradient-to-br from-brand-700 to-brand-500 p-5 text-white shadow-lg sm:p-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            <MapPinned size={14} />
            Mapa de cobertura comercial
          </div>
          <h1 className="text-3xl font-bold">Territórios</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-50">Acompanhamento de cobertura comercial por cidade.</p>
        </div>

        <div className="grid gap-3 rounded-2xl bg-white/10 p-3 backdrop-blur sm:grid-cols-2 lg:min-w-[460px]">
          <label className="text-xs font-semibold text-brand-50">
            Vendedor
            <select
              className="mt-1 w-full rounded-xl border border-white/20 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm disabled:bg-slate-100"
              value={selectedSellerId}
              onChange={(event) => setSelectedSellerId(event.target.value)}
              disabled={!canChooseSeller}
            >
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>{seller.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-brand-50">
            Mês/Ano
            <input
              className="mt-1 w-full rounded-xl border border-white/20 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>
        </div>
      </header>

      {error ? (
        <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} />
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <SummaryCard title="Total de cidades" value={formatNumberBR(coverage?.summary.totalCities ?? 0)} icon={MapPinned} />
        <SummaryCard title="Cidades positivadas" value={formatNumberBR(coverage?.summary.positiveCities ?? 0)} icon={CheckCircle2} tone="green" />
        <SummaryCard title="Oportunidade aberta" value={formatNumberBR(coverage?.summary.opportunityCities ?? 0)} icon={Target} tone="yellow" />
        <SummaryCard title="Cidades sem venda" value={formatNumberBR(coverage?.summary.noSaleCities ?? 0)} icon={AlertCircle} tone="red" />
        <SummaryCard title="Cobertura" value={formatPercentBR(coverage?.summary.coveragePercent ?? 0, 1)} icon={TrendingUp} tone="blue" />
        <SummaryCard title="Valor vendido" value={formatCurrencyBRL(coverage?.summary.soldValue ?? 0)} icon={CircleDollarSign} tone="green" />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Cobertura do território</h2>
            <p className="text-sm text-slate-500">{coverage?.summary.positiveCities ?? 0}/{coverage?.summary.totalCities ?? 0} cidades positivadas no mês.</p>
          </div>
          <p className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
            Faltam {missingCities} cidades para fechar seu território no mês.
          </p>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(coverage?.summary.coveragePercent ?? 0, 100)}%` }} />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(520px,1.4fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Mapa visual por cidades</h2>
              <p className="text-sm text-slate-500">MVP em cards; TODO: evoluir para React Leaflet com GeoJSON simplificado do Paraná.</p>
            </div>
            <Search className="text-slate-400" size={20} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {loading ? (
              <p className="col-span-full rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Carregando território...</p>
            ) : visualCities.length === 0 ? (
              <p className="col-span-full rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Nenhuma cidade vinculada ao território deste vendedor.</p>
            ) : visualCities.map((city) => {
              const style = statusStyles[city.status];
              return (
                <article key={`${city.state}-${city.city}-${city.status}`} className={`rounded-2xl border p-4 ${style.card}`} title={`${city.city}\n${coverage?.seller.name ?? "Vendedor"}\n${style.label}\nValor vendido: ${formatCurrencyBRL(city.soldValue)}\nPedidos: ${city.orderCount}\nOportunidades: ${city.openOpportunityCount}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-slate-900">{city.city}</h3>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{city.state}</p>
                    </div>
                    <span className={`mt-1 h-3 w-3 rounded-full ${style.dot}`} />
                  </div>
                  <p className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${style.badge}`}>{style.label}</p>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
                    <div><dt>Pedidos</dt><dd className="font-bold text-slate-900">{city.orderCount}</dd></div>
                    <div><dt>Oport.</dt><dd className="font-bold text-slate-900">{city.openOpportunityCount}</dd></div>
                    <div><dt>Vendido</dt><dd className="font-bold text-slate-900">{formatCurrencyBRL(city.soldValue)}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4">
            <h2 className="text-lg font-bold text-slate-900">Lista de cidades</h2>
            <p className="text-sm text-slate-500">Cidade | UF | Status | Pedidos ERP | Valor vendido | Oportunidades abertas</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Cidade</th>
                  <th className="px-4 py-3">UF</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Pedidos ERP</th>
                  <th className="px-4 py-3 text-right">Valor vendido</th>
                  <th className="px-4 py-3 text-right">Oportunidades abertas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(coverage?.cities ?? []).map((city) => {
                  const style = statusStyles[city.status];
                  return (
                    <tr key={city.id ?? `${city.state}-${city.city}`} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-900">{city.city}</td>
                      <td className="px-4 py-3 text-slate-600">{city.state}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${style.badge}`}>{city.statusLabel}</span></td>
                      <td className="px-4 py-3 text-right text-slate-700">{city.orderCount}</td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-900">{formatCurrencyBRL(city.soldValue)}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{city.openOpportunityCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
