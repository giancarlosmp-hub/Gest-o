import { normalizeState, normalizeText } from "../utils/normalize.js";
import { IBGE_TERRITORY_MUNICIPALITIES } from "./territoryOfficialCities.data.js";

export const TERRITORY_ALLOWED_STATES = ["PR", "SC", "MS"] as const;
export type TerritoryAllowedState = (typeof TERRITORY_ALLOWED_STATES)[number];
export type OfficialTerritoryCity = { city: string; state: TerritoryAllowedState; ibgeCode: string | null };

export const isTerritoryAllowedState = (state: string): state is TerritoryAllowedState => TERRITORY_ALLOWED_STATES.includes(normalizeState(state) as TerritoryAllowedState);

// Chave de comparação de nome: sem acento, minúsculas, hífen como espaço ("Grão Pará" = "Grão-Pará").
export const normalizeTerritoryCityKey = (city?: string | null) =>
  normalizeText(city)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Pd}/gu, " ")
    .replace(/[`\p{Pi}\p{Pf}]/gu, "'")
    .replace(/\s+/g, " ")
    .trim();

const OFFICIAL_CITIES_BY_STATE = Object.fromEntries(
  TERRITORY_ALLOWED_STATES.map((state) => [state, IBGE_TERRITORY_MUNICIPALITIES[state].map(([ibgeCode, city]): OfficialTerritoryCity => ({ city, state, ibgeCode }))])
) as Record<TerritoryAllowedState, OfficialTerritoryCity[]>;

export const listOfficialTerritoryCities = (state?: string) => {
  const states = state ? [normalizeState(state)] : [...TERRITORY_ALLOWED_STATES];
  return states
    .filter(isTerritoryAllowedState)
    .flatMap((uf) => OFFICIAL_CITIES_BY_STATE[uf])
    .sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city, "pt-BR"));
};

export const findOfficialTerritoryCity = (state: string, city: string, ibgeCode?: string | null) => {
  const normalizedState = normalizeState(state);
  if (!isTerritoryAllowedState(normalizedState)) return null;
  const officialCities = OFFICIAL_CITIES_BY_STATE[normalizedState];
  const normalizedIbgeCode = ibgeCode?.trim();
  if (normalizedIbgeCode) {
    const officialByIbge = officialCities.find((officialCity) => officialCity.ibgeCode === normalizedIbgeCode);
    if (officialByIbge) return officialByIbge;
  }

  const normalizedCityKey = normalizeTerritoryCityKey(city);
  return officialCities.find((officialCity) => normalizeTerritoryCityKey(officialCity.city) === normalizedCityKey) ?? null;
};

const STATE_NAMES: Record<string, TerritoryAllowedState> = {
  pr: "PR", parana: "PR",
  sc: "SC", "santa catarina": "SC",
  ms: "MS", "mato grosso do sul": "MS"
};

// UF escrita no marcador: "Irati - PR", "Irati/PR", "Irati (PR)", "Irati, PR" ou com o nome do estado por extenso.
export const parsePlacemarkCityName = (sourceName: string): { name: string; state: TerritoryAllowedState | null } => {
  const match = sourceName.trim().match(/^(.+?)\s*(?:\(\s*([^()]+?)\s*\)|(?:\s[-–—]\s|\s*[/,]\s*)([^/,()]+?))\s*$/);
  if (match) {
    const state = STATE_NAMES[normalizeTerritoryCityKey(match[2] ?? match[3])];
    if (state) return { name: match[1].trim(), state };
  }
  return { name: sourceName.trim(), state: null };
};

export type PlacemarkCityResolution =
  | { status: "resolved"; city: OfficialTerritoryCity }
  | { status: "ambiguous"; candidates: OfficialTerritoryCity[] }
  | { status: "not_found" };

const findOfficialCitiesByName = (name: string) => TERRITORY_ALLOWED_STATES
  .map((state) => findOfficialTerritoryCity(state, name))
  .filter((city): city is OfficialTerritoryCity => Boolean(city));

/**
 * Resolve os marcadores do arquivo no catálogo. Nome que existe em mais de uma UF (Irati PR/SC): vale a UF escrita
 * no marcador; sem ela, a UF com mais cidades resolvidas no próprio arquivo; empate fica "ambiguous" para escolha.
 */
export const resolvePlacemarkCities = (sourceNames: string[]): PlacemarkCityResolution[] => {
  const firstPass = sourceNames.map((sourceName) => {
    const parsed = parsePlacemarkCityName(sourceName);
    if (parsed.state) {
      const city = findOfficialTerritoryCity(parsed.state, parsed.name);
      if (city) return [city];
    }
    return findOfficialCitiesByName(sourceName);
  });

  const stateCounts = new Map<TerritoryAllowedState, number>();
  for (const candidates of firstPass) {
    if (candidates.length === 1) stateCounts.set(candidates[0].state, (stateCounts.get(candidates[0].state) ?? 0) + 1);
  }

  return firstPass.map((candidates): PlacemarkCityResolution => {
    if (candidates.length === 0) return { status: "not_found" };
    if (candidates.length === 1) return { status: "resolved", city: candidates[0] };
    const ranked = candidates
      .map((city) => ({ city, count: stateCounts.get(city.state) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    if (ranked[0].count > ranked[1].count) return { status: "resolved", city: ranked[0].city };
    return { status: "ambiguous", candidates };
  });
};
