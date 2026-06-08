import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, CircleDollarSign, Info, MapPinned, Target, TrendingUp } from "lucide-react";
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
  ibgeCode?: string | number | null;
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


const TERRITORY_GEOJSON_STATES = [
  { uf: "PR", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-41-mun.json" },
  { uf: "SC", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-42-mun.json" },
  { uf: "MS", url: "https://cdn.jsdelivr.net/gh/tbrugz/geodata-br@master/geojson/geojs-50-mun.json" }
] as const;
// GeoJSON por UF com fonte IBGE, CC0-1.0 (tbrugz/geodata-br).
const MAP_WIDTH = 1100;
const MAP_HEIGHT = 760;
const MAP_PADDING = 18;

type GeoJsonPosition = [number, number] | [number, number, number];
type GeoJsonPolygon = GeoJsonPosition[][];
type GeoJsonMultiPolygon = GeoJsonPolygon[];

type GeoJsonGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: GeoJsonPolygon | GeoJsonMultiPolygon;
};

type TerritoryMunicipalityFeature = {
  type: "Feature";
  properties: Record<string, string | number | null | undefined>;
  geometry: GeoJsonGeometry | null;
};

type TerritoryMunicipalityGeoJson = {
  type: "FeatureCollection";
  features: TerritoryMunicipalityFeature[];
};

type ProjectedBounds = {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
};

const statusFillColors: Record<TerritoryCityStatus, string> = {
  positive: "#059669",
  opportunity: "#f59e0b",
  no_sale: "#dc2626",
  out_of_territory: "#e8edf3"
};

const statusStrokeColors: Record<TerritoryCityStatus, string> = {
  positive: "#065f46",
  opportunity: "#92400e",
  no_sale: "#991b1b",
  out_of_territory: "#b8c2cc"
};

function normalizeCityKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function getFeatureCityName(feature: TerritoryMunicipalityFeature) {
  const props = feature.properties ?? {};
  const candidate = props.name ?? props.nome ?? props.NM_MUN ?? props.NM_MUNICIP ?? props.description ?? props.municipio ?? props.MUNICIPIO;
  return String(candidate ?? "Município");
}

function getFeatureIbgeCode(feature: TerritoryMunicipalityFeature) {
  const props = feature.properties ?? {};
  const candidate = props.id ?? props.codigo_ibge ?? props.CD_MUN ?? props.CD_GEOCMU ?? props.geocodigo;
  return candidate === undefined || candidate === null ? "" : String(candidate);
}

function getFeatureState(feature: TerritoryMunicipalityFeature) {
  const props = feature.properties ?? {};
  const explicitState = props.__state ?? props.uf ?? props.UF ?? props.state;
  if (explicitState) return String(explicitState).toUpperCase();

  const ibgeCode = getFeatureIbgeCode(feature);
  if (ibgeCode.startsWith("41")) return "PR";
  if (ibgeCode.startsWith("42")) return "SC";
  if (ibgeCode.startsWith("50")) return "MS";
  return "";
}

function getPolygons(geometry: GeoJsonGeometry | null): GeoJsonPolygon[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as GeoJsonPolygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as GeoJsonMultiPolygon;
  return [];
}

function calculateBounds(features: TerritoryMunicipalityFeature[]): ProjectedBounds {
  const bounds = features.reduce<ProjectedBounds>((acc, feature) => {
    getPolygons(feature.geometry).forEach((polygon) => {
      polygon.forEach((ring) => {
        ring.forEach(([lon, lat]) => {
          acc.minLon = Math.min(acc.minLon, lon);
          acc.maxLon = Math.max(acc.maxLon, lon);
          acc.minLat = Math.min(acc.minLat, lat);
          acc.maxLat = Math.max(acc.maxLat, lat);
        });
      });
    });
    return acc;
  }, { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity });

  return Number.isFinite(bounds.minLon) ? bounds : { minLon: -54, maxLon: -48, minLat: -27, maxLat: -22 };
}


function expandBounds(bounds: ProjectedBounds, paddingRatio: number): ProjectedBounds {
  const lonPadding = Math.max((bounds.maxLon - bounds.minLon) * paddingRatio, 0.12);
  const latPadding = Math.max((bounds.maxLat - bounds.minLat) * paddingRatio, 0.12);

  return {
    minLon: bounds.minLon - lonPadding,
    maxLon: bounds.maxLon + lonPadding,
    minLat: bounds.minLat - latPadding,
    maxLat: bounds.maxLat + latPadding
  };
}

function getCityStateNameKey(state: string, city: string) {
  return `${state.toUpperCase()}::${normalizeCityKey(city)}`;
}

function projectPosition([lon, lat]: GeoJsonPosition, bounds: ProjectedBounds) {
  const lonRange = bounds.maxLon - bounds.minLon || 1;
  const latRange = bounds.maxLat - bounds.minLat || 1;
  const drawableWidth = MAP_WIDTH - MAP_PADDING * 2;
  const drawableHeight = MAP_HEIGHT - MAP_PADDING * 2;
  const scale = Math.min(drawableWidth / lonRange, drawableHeight / latRange);
  const mapPixelWidth = lonRange * scale;
  const mapPixelHeight = latRange * scale;
  const offsetX = (MAP_WIDTH - mapPixelWidth) / 2;
  const offsetY = (MAP_HEIGHT - mapPixelHeight) / 2;

  return {
    x: offsetX + (lon - bounds.minLon) * scale,
    y: offsetY + (bounds.maxLat - lat) * scale
  };
}

function polygonToPath(polygon: GeoJsonPolygon, bounds: ProjectedBounds) {
  return polygon
    .map((ring) => ring
      .map((position, index) => {
        const point = projectPosition(position, bounds);
        return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      })
      .join(" ") + " Z")
    .join(" ");
}

function featureToPath(feature: TerritoryMunicipalityFeature, bounds: ProjectedBounds) {
  return getPolygons(feature.geometry).map((polygon) => polygonToPath(polygon, bounds)).join(" ");
}

function getTooltipText(city: TerritoryCity, sellerName?: string) {
  return [
    `Cidade: ${city.city}`,
    `UF: ${city.state}`,
    `Status: ${city.statusLabel || statusStyles[city.status].label}`,
    `Vendedor: ${sellerName ?? "-"}`,
    `Pedidos ERP: ${city.orderCount}`,
    `Valor vendido: ${formatCurrencyBRL(city.soldValue)}`,
    `Oportunidades abertas: ${city.openOpportunityCount}`
  ].join("\n");
}

function createOutOfTerritoryCity(city: string, state: string): TerritoryCity {
  return {
    city,
    state,
    status: "out_of_territory",
    statusLabel: "Fora do território",
    orderCount: 0,
    soldValue: 0,
    openOpportunityCount: 0
  };
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
  return new Date().toISOString().slice(0, 7);
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
  const [territoryGeoJson, setTerritoryGeoJson] = useState<TerritoryMunicipalityGeoJson | null>(null);
  const [geoJsonError, setGeoJsonError] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<TerritoryCity | null>(null);

  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";
  const visualCities = useMemo(() => [...(coverage?.cities ?? []), ...(coverage?.outOfTerritoryPreview ?? [])], [coverage]);
  const citiesByNormalizedName = useMemo(() => {
    const map = new Map<string, TerritoryCity>();
    visualCities.forEach((city) => {
      map.set(normalizeCityKey(city.city), city);
    });
    return map;
  }, [visualCities]);
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
      const featureCityName = getFeatureCityName(feature);
      const featureState = getFeatureState(feature);
      const city = citiesByIbgeCode.get(getFeatureIbgeCode(feature))
        ?? citiesByStateAndName.get(getCityStateNameKey(featureState, featureCityName))
        ?? citiesByNormalizedName.get(normalizeCityKey(featureCityName));

      return Boolean(city && city.status !== "out_of_territory");
    });
  }, [citiesByIbgeCode, citiesByNormalizedName, citiesByStateAndName, territoryGeoJson]);
  const geoBounds = useMemo(() => {
    const focusedFeatures = territoryFeatures.length > 0 ? territoryFeatures : (territoryGeoJson?.features ?? []);
    return expandBounds(calculateBounds(focusedFeatures), territoryFeatures.length > 0 ? 0.22 : 0.05);
  }, [territoryFeatures, territoryGeoJson]);
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
              className="mt-1 h-8 min-h-0 w-full rounded-xl border border-white/20 bg-white px-2.5 py-1 text-sm leading-tight text-slate-900 shadow-sm disabled:bg-slate-100 sm:h-10 sm:px-3 sm:py-1.5"
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
              className="mt-1 h-8 min-h-0 w-full rounded-xl border border-white/20 bg-white px-2.5 py-1 text-sm leading-tight text-slate-900 shadow-sm [color-scheme:light] sm:h-10 sm:px-3 sm:py-1.5"
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

      <section className="space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5 lg:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Mapa real dos municípios de PR, SC e MS</h2>
                <p className="mt-1 text-sm text-slate-500">Clique em uma cidade para ver clientes, oportunidades e pedidos.</p>
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

          <div className="p-3 sm:p-5 lg:p-6">
            <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-emerald-50/30 shadow-[0_24px_70px_rgba(15,23,42,0.12)] ring-1 ring-white">
              <div className="flex min-h-[420px] items-center justify-center sm:min-h-[560px] lg:min-h-[700px]">
                {loading ? (
                  <div className="flex min-h-[420px] items-center justify-center p-6 text-sm font-semibold text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">Carregando território...</div>
                ) : geoJsonError ? (
                  <div className="flex min-h-[420px] flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">
                    <AlertCircle className="text-amber-500" size={22} />
                    <span>{geoJsonError}</span>
                  </div>
                ) : territoryGeoJson ? (
                  <svg
                    className="h-full min-h-[420px] w-full max-w-[1280px] touch-manipulation sm:min-h-[560px] lg:min-h-[700px]"
                    role="img"
                    aria-label="Mapa de cobertura comercial dos municípios do Paraná, Santa Catarina e Mato Grosso do Sul"
                    viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                  >
                    <defs>
                      <filter id="territoryGlow" x="-18%" y="-18%" width="136%" height="136%">
                        <feDropShadow dx="0" dy="2" stdDeviation="2.2" floodColor="#0f172a" floodOpacity="0.18" />
                      </filter>
                      <filter id="selectedGlow" x="-24%" y="-24%" width="148%" height="148%">
                        <feDropShadow dx="0" dy="4" stdDeviation="3.5" floodColor="#0f172a" floodOpacity="0.32" />
                      </filter>
                    </defs>
                    <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#f8fafc" />
                    {territoryGeoJson.features.map((feature) => {
                      const featureCityName = getFeatureCityName(feature);
                      const featureState = getFeatureState(feature);
                      const city = citiesByIbgeCode.get(getFeatureIbgeCode(feature))
                        ?? citiesByStateAndName.get(getCityStateNameKey(featureState, featureCityName))
                        ?? citiesByNormalizedName.get(normalizeCityKey(featureCityName))
                        ?? createOutOfTerritoryCity(featureCityName, featureState);
                      const isTerritoryCity = city.status !== "out_of_territory";
                      const isSelected = selectedCity
                        ? normalizeCityKey(selectedCity.city) === normalizeCityKey(featureCityName) && selectedCity.state === city.state
                        : false;
                      const path = featureToPath(feature, geoBounds);
                      if (!path) return null;

                      return (
                        <path
                          key={`${feature.properties.id ?? `${featureState}-${featureCityName}`}`}
                          d={path}
                          fill={statusFillColors[city.status]}
                          stroke={isSelected ? "#020617" : statusStrokeColors[city.status]}
                          strokeWidth={isSelected ? 4 : isTerritoryCity ? 1.8 : 0.55}
                          vectorEffect="non-scaling-stroke"
                          opacity={isTerritoryCity ? 0.98 : 0.64}
                          filter={isSelected ? "url(#selectedGlow)" : isTerritoryCity ? "url(#territoryGlow)" : undefined}
                          className="cursor-pointer transition-[opacity,stroke-width,filter] duration-150 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          tabIndex={0}
                          role="button"
                          aria-label={`${city.city}, ${city.state}: ${city.statusLabel}`}
                          onClick={() => setSelectedCity(city)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedCity(city);
                            }
                          }}
                        >
                          <title>{getTooltipText(city, coverage?.seller.name)}</title>
                        </path>
                      );
                    })}
                  </svg>
                ) : (
                  <div className="flex min-h-[420px] items-center justify-center p-6 text-sm font-semibold text-slate-500 sm:min-h-[560px] lg:min-h-[700px]">Carregando mapa de PR, SC e MS...</div>
                )}
              </div>

              <div className="hidden lg:block lg:absolute lg:right-5 lg:top-5 lg:w-[360px]">
                <div className="rounded-2xl border border-white/70 bg-white/95 p-4 shadow-[0_18px_55px_rgba(15,23,42,0.18)] backdrop-blur">
                  <CityDetailPanel city={selectedCity} sellerName={coverage?.seller.name} compact />
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:hidden">
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
