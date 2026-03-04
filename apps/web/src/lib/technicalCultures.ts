import api from "./apiClient";

export type TechnicalCulture = {
  id: string;
  slug: string;
  label: string;
  category: string;
  isActive: boolean;
  defaultKgHaMin: number | null;
  defaultKgHaMax: number | null;
  notes: string | null;
  pmsDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  populationTargetDefault: number | null;
  rowSpacingCmDefault: number | null;
};

export type CultureFormInput = {
  slug: string;
  label: string;
  category: string;
  isActive: boolean;
  defaultKgHaMin: number | null;
  defaultKgHaMax: number | null;
  notes: string | null;
  pmsDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  populationTargetDefault: number | null;
  rowSpacingCmDefault: number | null;
  goalsJson: Record<string, { min: number; max: number }>;
  tags: string[];
};

export const CULTURE_FALLBACKS: TechnicalCulture[] = [
  { id: "fallback-sorgo", slug: "sorgo", label: "Sorgo", category: "Grãos", isActive: true, defaultKgHaMin: 8, defaultKgHaMax: 18, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 28, germinationDefault: 85, purityDefault: 98, populationTargetDefault: 180000, rowSpacingCmDefault: 45 },
  { id: "fallback-milho", slug: "milho", label: "Milho", category: "Grãos", isActive: true, defaultKgHaMin: 14, defaultKgHaMax: 24, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 32, germinationDefault: 90, purityDefault: 98, populationTargetDefault: 65000, rowSpacingCmDefault: 50 },
  { id: "fallback-milheto", slug: "milheto", label: "Milheto", category: "Cobertura", isActive: true, defaultKgHaMin: 10, defaultKgHaMax: 20, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 8, germinationDefault: 80, purityDefault: 95, populationTargetDefault: 250000, rowSpacingCmDefault: 34 }
];

type TechnicalCultureCatalogResponse = {
  items: Array<{
    id: string;
    name: string;
    category: string;
    kgHaMin: number | null;
    kgHaMax: number | null;
    pmsDefault: number | null;
    populationDefaultHa: number | null;
    spacingDefaultCm: number | null;
    germinationDefault: number | null;
    purityDefault: number | null;
    notes?: string;
  }>;
  source: "db" | "seed" | "static";
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const mapCatalogItemToTechnicalCulture = (item: TechnicalCultureCatalogResponse["items"][number]): TechnicalCulture => ({
  id: item.id,
  slug: item.id,
  label: item.name,
  category: item.category,
  isActive: true,
  defaultKgHaMin: item.kgHaMin,
  defaultKgHaMax: item.kgHaMax,
  notes: item.notes ?? null,
  pmsDefault: item.pmsDefault,
  germinationDefault: item.germinationDefault,
  purityDefault: item.purityDefault,
  populationTargetDefault: item.populationDefaultHa,
  rowSpacingCmDefault: item.spacingDefaultCm,
});

export async function fetchTechnicalCultures() {
  const endpoint = "/technical-cultures";
  const baseURL = api.defaults.baseURL ?? "";
  const fullUrl = `${String(baseURL).replace(/\/+$/, "")}${endpoint}`;

  if (import.meta.env.DEV) {
    console.info("[technical-cultures] Request", { endpoint, baseURL, fullUrl });
  }

  try {
    const response = await api.get<TechnicalCultureCatalogResponse>(endpoint);
    return response.data.items.map(mapCatalogItemToTechnicalCulture);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[technical-cultures] Primeira tentativa falhou. Aplicando retry.", error);
    }

    await wait(300);
    const retryResponse = await api.get<TechnicalCultureCatalogResponse>(endpoint);
    return retryResponse.data.items.map(mapCatalogItemToTechnicalCulture);
  }
}
