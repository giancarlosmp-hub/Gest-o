// Regras visuais do mapa de Territórios, sem dependência de biblioteca de mapa (testáveis com tsx).
// A cor de cada cidade vem do status calculado pela API em GET /territories/coverage; aqui só se traduz status em cor.

export type TerritoryCityStatus = "positive" | "opportunity" | "no_sale" | "out_of_territory";

export type TerritoryCity = {
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

export type GeoJsonPosition = [number, number] | [number, number, number];
type GeoJsonPolygon = GeoJsonPosition[][];
type GeoJsonMultiPolygon = GeoJsonPolygon[];

export type GeoJsonGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: GeoJsonPolygon | GeoJsonMultiPolygon;
};

export type TerritoryMunicipalityFeature = {
  type: "Feature";
  properties: Record<string, string | number | null | undefined>;
  geometry: GeoJsonGeometry | null;
};

export type TerritoryMunicipalityGeoJson = {
  type: "FeatureCollection";
  features: TerritoryMunicipalityFeature[];
};

export type GeoBounds = {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
};

// Verde = pedido ERP no mês; amarelo = oportunidade aberta; vermelho = cidade do território sem venda/oportunidade;
// cinza = fora do território. Mesmas cores do mapa anterior.
export const statusFillColors: Record<TerritoryCityStatus, string> = {
  positive: "#059669",
  opportunity: "#f59e0b",
  no_sale: "#dc2626",
  out_of_territory: "#e8edf3"
};

export const statusStrokeColors: Record<TerritoryCityStatus, string> = {
  positive: "#065f46",
  opportunity: "#92400e",
  no_sale: "#991b1b",
  out_of_territory: "#b8c2cc"
};

export const SELECTED_CITY_STROKE = "#020617";

export type TerritoryPathStyle = {
  fillColor: string;
  color: string;
  weight: number;
  fillOpacity: number;
  opacity: number;
};

// Estilo do polígono sobre o fundo do OpenStreetMap: as cores são as do status; só a opacidade deixa o fundo aparecer.
export function territoryCityPathStyle(status: TerritoryCityStatus, isSelected: boolean): TerritoryPathStyle {
  const isTerritoryCity = status !== "out_of_territory";
  return {
    fillColor: statusFillColors[status],
    color: isSelected ? SELECTED_CITY_STROKE : statusStrokeColors[status],
    weight: isSelected ? 4 : isTerritoryCity ? 1.5 : 0.5,
    fillOpacity: isSelected ? 0.8 : isTerritoryCity ? 0.6 : 0.35,
    opacity: isTerritoryCity || isSelected ? 1 : 0.8
  };
}

export function normalizeCityKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function getFeatureCityName(feature: TerritoryMunicipalityFeature) {
  const props = feature.properties ?? {};
  const candidate = props.name ?? props.nome ?? props.NM_MUN ?? props.NM_MUNICIP ?? props.description ?? props.municipio ?? props.MUNICIPIO;
  return String(candidate ?? "Município");
}

export function getFeatureIbgeCode(feature: TerritoryMunicipalityFeature) {
  const props = feature.properties ?? {};
  const candidate = props.id ?? props.codigo_ibge ?? props.CD_MUN ?? props.CD_GEOCMU ?? props.geocodigo;
  return candidate === undefined || candidate === null ? "" : String(candidate);
}

export function getFeatureState(feature: TerritoryMunicipalityFeature) {
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

export function calculateBounds(features: TerritoryMunicipalityFeature[]): GeoBounds {
  const bounds = features.reduce<GeoBounds>((acc, feature) => {
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

export function expandBounds(bounds: GeoBounds, paddingRatio: number): GeoBounds {
  const lonPadding = Math.max((bounds.maxLon - bounds.minLon) * paddingRatio, 0.12);
  const latPadding = Math.max((bounds.maxLat - bounds.minLat) * paddingRatio, 0.12);

  return {
    minLon: bounds.minLon - lonPadding,
    maxLon: bounds.maxLon + lonPadding,
    minLat: bounds.minLat - latPadding,
    maxLat: bounds.maxLat + latPadding
  };
}

export function getCityStateNameKey(state: string, city: string) {
  return `${state.toUpperCase()}::${normalizeCityKey(city)}`;
}

export function normalizeIbgeCode(value: string | number | null | undefined) {
  return value === undefined || value === null ? "" : String(value).trim();
}

// Cidade da resposta da API para o polígono: primeiro pelo código IBGE, depois por UF + nome normalizado.
export function getCityGeoMatch(feature: TerritoryMunicipalityFeature, citiesByIbgeCode: Map<string, TerritoryCity>, citiesByStateAndName: Map<string, TerritoryCity>) {
  const featureIbgeCode = normalizeIbgeCode(getFeatureIbgeCode(feature));
  if (featureIbgeCode) {
    const cityByIbge = citiesByIbgeCode.get(featureIbgeCode);
    if (cityByIbge) return cityByIbge;
  }

  const featureState = getFeatureState(feature);
  if (!featureState) return null;

  return citiesByStateAndName.get(getCityStateNameKey(featureState, getFeatureCityName(feature))) ?? null;
}

export function createOutOfTerritoryCity(city: string, state: string): TerritoryCity {
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

// Mesmo critério de destaque do mapa anterior: código IBGE igual, ou nome normalizado + UF iguais.
export function isFeatureSelected(feature: TerritoryMunicipalityFeature, selectedCity: TerritoryCity | null) {
  if (!selectedCity) return false;
  const featureIbgeCode = getFeatureIbgeCode(feature);
  return normalizeIbgeCode(selectedCity.ibgeCode) === normalizeIbgeCode(featureIbgeCode)
    || (normalizeCityKey(selectedCity.city) === normalizeCityKey(getFeatureCityName(feature)) && selectedCity.state === getFeatureState(feature));
}
