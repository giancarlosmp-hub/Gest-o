import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, CircleDollarSign, Info, MapPinned, Settings2, Target, TrendingUp, X } from "lucide-react";
import { Link } from "react-router-dom";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";
import { formatCurrencyBRL, formatNumberBR, formatPercentBR } from "../lib/formatters";
import { getApiErrorMessage } from "../lib/apiError";
import { brazilMonthKey } from "../lib/brazilDate";
import {
  calculateBounds,
  createOutOfTerritoryCity,
  expandBounds,
  getCityGeoMatch,
  getCityStateNameKey,
  getFeatureCityName,
  getFeatureState,
  type TerritoryCity,
  type TerritoryCityStatus,
  type TerritoryMunicipalityFeature,
  type TerritoryMunicipalityGeoJson
} from "../lib/territoryMap";

// Leaflet (JS + CSS) só é baixado quando a tela de Territórios abre, fora do pacote principal do app.
const TerritoryLeafletMap = lazy(() => import("../components/territories/TerritoryLeafletMap"));

type SellerOption = {
  id: string;
  name: string;
  role: string;
  isActive?: boolean;
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


const TERRITORY_GEOJSON_STATES = [
  { uf: "PR", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-41-mun.json" },
  { uf: "SC", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-42-mun.json" },
  { uf: "MS", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-50-mun.json" }
] as const;
// GeoJSON por UF com fonte IBGE, CC0-1.0 (tbrugz/geodata-br).
function getTooltipText(city: TerritoryCity, sellerName?: string) {
  return [
    `Cidade: ${city.city}`,
    `UF: ${city.state}`,
    `Código IBGE: ${city.ibgeCode ?? "-"}`,
    `Status: ${city.statusLabel || statusStyles[city.status].label}`,
    `Vendedor: ${sellerName ?? "-"}`,
    `Pedidos ERP: ${city.orderCount}`,
    `Valor vendido: ${formatCurrencyBRL(city.soldValue)}`,
    `Oportunidades abertas: ${city.openOpportunityCount}`
  ].join("\n");
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-bold text-slate-900">{value}</dd>
    </div>
  );
}

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
  return brazilMonthKey();
}


function CityDetailPanel({ city, sellerName, compact = false }: { city: TerritoryCity | null; sellerName?: string; compact?: boolean }) {
  if (!city) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 text-center text-sm text-slate-500 ${compact ? "py-4" : "py-6"}`}>
        <Info className="text-brand-500" size={24} />
        <p className="font-semibold text-slate-700">Selecione uma cidade no mapa para ver detalhes.</p>
        <p>Cidades coloridas fazem parte do território do vendedor.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between lg:flex-col">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Cidade selecionada</p>
          <h3 className="mt-1 text-xl font-bold text-slate-900">{city.city}/{city.state}</h3>
        </div>
        <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusStyles[city.status].badge}`}>{city.statusLabel}</span>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <DetailRow label="Vendedor" value={sellerName ?? "-"} />
        <DetailRow label="Código IBGE" value={city.ibgeCode ?? "-"} />
        <DetailRow label="Pedidos ERP" value={city.orderCount} />
        <DetailRow label="Valor vendido" value={formatCurrencyBRL(city.soldValue)} />
        <DetailRow label="Oportunidades abertas" value={city.openOpportunityCount} />
      </dl>
    </div>
  );
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
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
          {/* Celular: valor menor e sem quebra no meio (o shell aplica overflow-wrap: anywhere em <p>). */}
          <p className="mt-1 text-[15px] font-bold text-slate-900 max-sm:whitespace-nowrap max-sm:[overflow-wrap:normal] sm:mt-2 sm:text-2xl">{value}</p>
        </div>
        <span className={`rounded-xl p-2 max-sm:hidden ${toneClasses}`}>
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
  const [territoryGeoJson, setTerritoryGeoJson] = useState<TerritoryMunicipalityGeoJson | null>(null);
  const [geoJsonError, setGeoJsonError] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<TerritoryCity | null>(null);

  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";
  const canManageTerritories = user?.role === "diretor" || user?.role === "gerente";
  const visualCities = useMemo(() => [...(coverage?.cities ?? []), ...(coverage?.outOfTerritoryPreview ?? [])], [coverage]);
  const citiesByStateAndName = useMemo(() => {
    const map = new Map<string, TerritoryCity>();
    visualCities.forEach((city) => {
      map.set(getCityStateNameKey(city.state, city.city), city);
    });
    return map;
  }, [visualCities]);
  const citiesByIbgeCode = useMemo(() => {
    const map = new Map<string, TerritoryCity>();
    visualCities.forEach((city) => {
      if (city.ibgeCode !== undefined && city.ibgeCode !== null) {
        map.set(String(city.ibgeCode), city);
      }
    });
    return map;
  }, [visualCities]);
  const territoryFeatures = useMemo(() => {
    if (!territoryGeoJson) return [];

    return territoryGeoJson.features.filter((feature) => {
      const city = getCityGeoMatch(feature, citiesByIbgeCode, citiesByStateAndName);

      return Boolean(city && city.status !== "out_of_territory");
    });
  }, [citiesByIbgeCode, citiesByStateAndName, territoryGeoJson]);
  const geoBounds = useMemo(() => {
    const focusedFeatures = territoryFeatures.length > 0 ? territoryFeatures : (territoryGeoJson?.features ?? []);
    return expandBounds(calculateBounds(focusedFeatures), territoryFeatures.length > 0 ? 0.22 : 0.05);
  }, [territoryFeatures, territoryGeoJson]);
  // Cada polígono recebe a cidade da resposta da API (por IBGE ou UF + nome); sem correspondência, fica fora do território.
  const resolveMapCity = useCallback((feature: TerritoryMunicipalityFeature) =>
    getCityGeoMatch(feature, citiesByIbgeCode, citiesByStateAndName)
      ?? createOutOfTerritoryCity(getFeatureCityName(feature), getFeatureState(feature)),
  [citiesByIbgeCode, citiesByStateAndName]);
  const sellerNameForTooltip = coverage?.seller.name;
  const mapTooltipText = useCallback((city: TerritoryCity) => getTooltipText(city, sellerNameForTooltip), [sellerNameForTooltip]);
  const selectedSeller = coverage?.seller ?? sellers.find((seller) => seller.id === selectedSellerId);
  const hasTerritoryCities = (coverage?.cities.length ?? 0) > 0;
  const hasNoTerritory = Boolean(coverage && !loading && !hasTerritoryCities);
  const canInspectMunicipalities = !hasNoTerritory;
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
    let mounted = true;
    setGeoJsonError(null);

    Promise.all(TERRITORY_GEOJSON_STATES.map(async ({ uf, url }) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ao carregar ${uf}`);
      }
      const data = await response.json() as TerritoryMunicipalityGeoJson;
      return data.features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, __state: uf }
      }));
    }))
      .then((stateFeatures) => {
        if (!mounted) return;
        setTerritoryGeoJson({ type: "FeatureCollection", features: stateFeatures.flat() });
      })
      .catch(() => {
        if (!mounted) return;
        setGeoJsonError("Não foi possível carregar o GeoJSON dos municípios de PR, SC e MS. Recarregue a página ou verifique a rede.");
      });

    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setSelectedCity(null);
  }, [selectedSellerId, month]);

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
    <div className="space-y-6 max-sm:space-y-0 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-3 rounded-3xl bg-gradient-to-br from-brand-700 to-brand-500 px-4 py-4 text-white shadow-lg sm:gap-4 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide sm:mb-3 sm:gap-2 sm:px-3 sm:text-xs">
            <MapPinned size={14} />
            Mapa de cobertura comercial
          </div>
          <h1 className="text-2xl font-bold sm:text-3xl">Territórios</h1>
          <p className="mt-1 max-w-2xl text-xs text-brand-50 sm:mt-2 sm:text-sm">Acompanhamento de cobertura comercial por cidade.</p>
        </div>

        <div className="grid gap-2 rounded-2xl bg-white/10 p-2.5 backdrop-blur sm:grid-cols-2 sm:gap-3 sm:p-3 lg:min-w-[460px]">
          <label className="text-xs font-semibold text-brand-50">
            Vendedor
            <select
              className="mt-1 h-9 min-h-0 w-full rounded-xl border border-white/20 bg-white px-2.5 py-0 text-sm leading-none text-slate-900 shadow-sm disabled:bg-slate-100 sm:h-10 sm:px-3"
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
              className="mt-1 h-9 min-h-0 w-full appearance-none rounded-xl border border-white/20 bg-white px-2.5 py-0 text-sm leading-none text-slate-900 shadow-sm [color-scheme:light] sm:h-10 sm:px-3"
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

      {hasNoTerritory ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 shrink-0 text-amber-600" size={20} />
            <div>
              <p className="font-bold">Este vendedor ainda não possui território cadastrado.</p>
              <p className="mt-1 text-amber-800">{selectedSeller?.name ?? "Vendedor selecionado"} não tem cidades vinculadas para o mês exibido; por isso os indicadores permanecem zerados.</p>
            </div>
          </div>
          {canManageTerritories ? (
            <Link
              to="/configurações?section=seller-territories"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white transition hover:bg-amber-700"
            >
              <Settings2 size={15} />
              Configurar territórios
            </Link>
          ) : null}
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-6">
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

      <section className="space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5 lg:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Mapa real dos municípios de PR, SC e MS</h2>
                <p className="mt-1 text-sm text-slate-500">Toque em uma cidade para ver pedidos, valor vendido e oportunidades.</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">Território do vendedor</p>
                <div className="grid gap-2 text-xs font-semibold text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
                  <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-emerald-600" />Verde: pedido ERP</span>
                  <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-amber-500" />Amarelo: oportunidade</span>
                  <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-600" />Vermelho: sem venda</span>
                  <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-slate-200 ring-1 ring-slate-300" />Cinza: fora</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-500">
                  <p>Cidades coloridas fazem parte do território do vendedor.</p>
                  <p>Cidades em cinza estão fora do território.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:p-6">
            <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-emerald-50/30 shadow-[0_24px_70px_rgba(15,23,42,0.12)] ring-1 ring-white">
              {loading ? (
                <div className="flex min-h-[420px] items-center justify-center p-6 text-sm font-semibold text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">Carregando território...</div>
              ) : geoJsonError ? (
                <div className="flex min-h-[420px] flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">
                  <AlertCircle className="text-amber-500" size={22} />
                  <span>{geoJsonError}</span>
                </div>
              ) : territoryGeoJson ? (
                <Suspense fallback={<div className="flex min-h-[420px] items-center justify-center p-6 text-sm font-semibold text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">Carregando mapa de PR, SC e MS...</div>}>
                <TerritoryLeafletMap
                  features={territoryGeoJson.features}
                  resolveCity={resolveMapCity}
                  selectedCity={selectedCity}
                  onSelectCity={setSelectedCity}
                  canInspect={canInspectMunicipalities}
                  focusBounds={geoBounds}
                  viewKey={`${selectedSellerId}|${month}|${hasTerritoryCities ? "territory" : "empty"}`}
                  tooltipText={mapTooltipText}
                  ariaLabel="Mapa de cobertura comercial dos municípios do Paraná, Santa Catarina e Mato Grosso do Sul"
                />
                </Suspense>
              ) : (
                <div className="flex min-h-[420px] items-center justify-center p-6 text-sm font-semibold text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">Carregando mapa de PR, SC e MS...</div>
              )}
              {/* Celular e tablet: resumo da cidade tocada por cima do mapa (o detalhe completo continua abaixo).
                  Fica acima da linha de atribuição do OpenStreetMap, que precisa seguir visível. rounded-[1rem] e rounded-[0.75rem]
                  (e não rounded-2xl/rounded-xl): no celular o shell estica essas classes para 100% da largura. */}
              {selectedCity && !hasNoTerritory ? (
                <div className="absolute inset-x-3 bottom-8 z-10 rounded-[1rem] border border-slate-200 bg-white/95 p-3 text-sm shadow-xl backdrop-blur lg:hidden" role="status" aria-live="polite">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900">{selectedCity.city}/{selectedCity.state}</p>
                      <span className={`mt-1 inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${statusStyles[selectedCity.status].badge}`}>{selectedCity.statusLabel}</span>
                    </div>
                    <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.75rem] text-slate-500 hover:bg-slate-100" onClick={() => setSelectedCity(null)} aria-label="Fechar resumo da cidade">
                      <X size={18} />
                    </button>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600">
                    <div><dt>Pedidos ERP</dt><dd className="font-bold text-slate-900">{selectedCity.orderCount}</dd></div>
                    <div><dt>Vendido</dt><dd className="whitespace-nowrap font-bold text-slate-900 [overflow-wrap:normal]">{formatCurrencyBRL(selectedCity.soldValue)}</dd></div>
                    <div><dt>Oportunidades</dt><dd className="font-bold text-slate-900">{selectedCity.openOpportunityCount}</dd></div>
                  </dl>
                </div>
              ) : null}
              {hasNoTerritory ? (
                <div className="pointer-events-auto absolute inset-x-4 bottom-8 z-10 rounded-[1rem] border border-amber-200 bg-white/95 p-4 text-sm text-slate-700 shadow-xl backdrop-blur sm:inset-x-auto sm:left-4 sm:max-w-md">
                  <div className="flex items-start gap-3">
                    <Info className="mt-0.5 shrink-0 text-amber-600" size={20} />
                    <div>
                      <p className="font-bold text-slate-900">Este vendedor ainda não possui território cadastrado.</p>
                      <p className="mt-1">O mapa mostra PR, SC e MS apenas como referência, sem destacar cidades.</p>
                      {canManageTerritories ? (
                        <Link
                          to="/configurações?section=seller-territories"
                          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white transition hover:bg-brand-700"
                        >
                          <Settings2 size={15} />
                          Configurações &gt; Territórios Comerciais
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <aside className="hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:block">
              <CityDetailPanel city={selectedCity} sellerName={coverage?.seller.name} compact />
            </aside>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:hidden">
              <CityDetailPanel city={selectedCity} sellerName={coverage?.seller.name} />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5">
            <h2 className="text-lg font-bold text-slate-900">Lista de cidades</h2>
            <p className="text-sm text-slate-500">Cidades do território do vendedor selecionado no mês.</p>
          </div>

          <div className="hidden max-h-[520px] overflow-auto md:block">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 shadow-sm">
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

          <div className="grid gap-3 p-4 md:hidden">
            {loading ? (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Carregando cidades...</p>
            ) : (coverage?.cities ?? []).length === 0 ? (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Nenhuma cidade vinculada ao território deste vendedor.</p>
            ) : (coverage?.cities ?? []).map((city) => {
              const style = statusStyles[city.status];
              return (
                <article key={city.id ?? `${city.state}-${city.city}`} className={`rounded-2xl border p-4 ${style.card}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-slate-900">{city.city}</h3>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{city.state}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${style.badge}`}>{city.statusLabel}</span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                    <div><dt>Pedidos ERP</dt><dd className="font-bold text-slate-900">{city.orderCount}</dd></div>
                    <div><dt>Vendido</dt><dd className="font-bold text-slate-900">{formatCurrencyBRL(city.soldValue)}</dd></div>
                    <div><dt>Oportunidades</dt><dd className="font-bold text-slate-900">{city.openOpportunityCount}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
