import { normalizeState } from "../utils/normalize.js";
import { IBGE_BRAZIL_MUNICIPALITIES } from "./ibgeBrazilMunicipalities.data.js";
import { normalizeTerritoryCityKey } from "./territoryOfficialCities.js";

// Endereço do cliente: UF e município do catálogo oficial do IBGE (Brasil inteiro). Território comercial segue só
// PR, SC e MS (territoryOfficialCities).
export type BrazilState = keyof typeof IBGE_BRAZIL_MUNICIPALITIES;
export type BrazilMunicipality = { state: BrazilState; city: string; ibgeCode: string };

export const BRAZIL_STATES = (Object.keys(IBGE_BRAZIL_MUNICIPALITIES) as BrazilState[]).sort();

export const isBrazilState = (state?: string | null): state is BrazilState => BRAZIL_STATES.includes(normalizeState(state) as BrazilState);

const MUNICIPALITIES_BY_STATE = new Map(
  BRAZIL_STATES.map((state) => {
    const list = IBGE_BRAZIL_MUNICIPALITIES[state].map(([ibgeCode, city]): BrazilMunicipality => ({ state, city, ibgeCode }));
    return [state, { list, byKey: new Map(list.map((item) => [normalizeTerritoryCityKey(item.city), item])) }] as const;
  })
);

export const listBrazilMunicipalities = (state: string) => (isBrazilState(state) ? MUNICIPALITIES_BY_STATE.get(normalizeState(state) as BrazilState)!.list : []);

// Município pela UF e pelo nome (sem acento, maiúsculas, hífen ou apóstrofo como espaço). Nunca procura em outra UF.
export const findBrazilMunicipality = (state?: string | null, city?: string | null): BrazilMunicipality | null => {
  if (!isBrazilState(state) || !city?.trim()) return null;
  return MUNICIPALITIES_BY_STATE.get(normalizeState(state) as BrazilState)!.byKey.get(normalizeTerritoryCityKey(city)) ?? null;
};

// UFs em que existe um município com esse nome (para relatório; o cadastro nunca adivinha a UF).
export const statesWithMunicipalityNamed = (city?: string | null) => (city?.trim() ? BRAZIL_STATES.filter((state) => findBrazilMunicipality(state, city)) : []);

export const INVALID_CLIENT_ADDRESS_MESSAGE = "Escolha a UF e a cidade da lista oficial do IBGE.";

export const invalidClientAddressMessage = (state?: string | null, city?: string | null) => {
  const uf = normalizeState(state);
  if (!isBrazilState(uf)) return `UF "${uf || "-"}" inválida. ${INVALID_CLIENT_ADDRESS_MESSAGE}`;
  return `Cidade "${city?.trim() || "-"}" não encontrada na UF ${uf}. ${INVALID_CLIENT_ADDRESS_MESSAGE}`;
};
