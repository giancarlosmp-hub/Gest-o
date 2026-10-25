import api from "./apiClient";

// Lista oficial do IBGE (via API) para UF e cidade do cliente. Cache por UF durante a sessão da página.
export type CatalogMunicipality = { city: string; ibgeCode: string };
type CatalogResponse = { states: string[]; municipalities: CatalogMunicipality[] };

const cache = new Map<string, Promise<CatalogResponse>>();

const loadCatalog = (uf: string) => {
  const key = uf.trim().toUpperCase();
  if (!cache.has(key)) {
    const request = api
      .get<CatalogResponse>("/clients/address-catalog", { params: key ? { uf: key } : {} })
      .then((response) => response.data)
      .catch((error) => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, request);
  }
  return cache.get(key)!;
};

export const loadBrazilStates = async () => (await loadCatalog("")).states;
export const loadMunicipalities = async (uf: string) => (uf.trim() ? (await loadCatalog(uf)).municipalities : []);

// Mesma comparação da API: sem acento, minúsculas, hífen e apóstrofo como espaço.
export const municipalityKey = (value?: string | null) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Pd}/gu, " ")
    .replace(/[`'\p{Pi}\p{Pf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const findMunicipality = (list: CatalogMunicipality[], city?: string | null) => {
  const key = municipalityKey(city);
  return key ? list.find((item) => municipalityKey(item.city) === key) ?? null : null;
};

// Cidade e UF vindas de fora (consulta de CNPJ): devolve o par oficial, ou null quando não está na lista.
export const resolveOfficialAddress = async (state?: string | null, city?: string | null) => {
  const uf = String(state ?? "").trim().toUpperCase();
  if (!uf || !city?.trim()) return null;
  const states = await loadBrazilStates();
  if (!states.includes(uf)) return null;
  const municipality = findMunicipality(await loadMunicipalities(uf), city);
  return municipality ? { state: uf, city: municipality.city } : null;
};
