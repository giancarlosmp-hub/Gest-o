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
  goalsJson: Record<string, { min: number; max: number }>;
  tags: string[];
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
  { id: "fallback-sorgo", slug: "sorgo", label: "Sorgo", category: "Grãos", isActive: true, defaultKgHaMin: 8, defaultKgHaMax: 18, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 28, germinationDefault: 85, purityDefault: 98, populationTargetDefault: 180000, rowSpacingCmDefault: 45, goalsJson: {}, tags: [] },
  { id: "fallback-milho", slug: "milho", label: "Milho", category: "Grãos", isActive: true, defaultKgHaMin: 14, defaultKgHaMax: 24, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 32, germinationDefault: 90, purityDefault: 98, populationTargetDefault: 65000, rowSpacingCmDefault: 50, goalsJson: {}, tags: [] },
  { id: "fallback-milheto", slug: "milheto", label: "Milheto", category: "Cobertura", isActive: true, defaultKgHaMin: 10, defaultKgHaMax: 20, notes: "Fallback local ativo. Ajuste em Configurações.", pmsDefault: 8, germinationDefault: 80, purityDefault: 95, populationTargetDefault: 250000, rowSpacingCmDefault: 34, goalsJson: {}, tags: [] }
];

type TechnicalCultureCatalogResponse = {
  data: Array<Omit<TechnicalCulture, "goalsJson" | "tags"> & { goalsJson?: Record<string, { min: number; max: number }>; tags?: string[] }>;
  total: number;
  page: number;
  pageSize: number;
};

export async function fetchTechnicalCultures() {
  const response = await api.get<TechnicalCultureCatalogResponse>("/technical/cultures", {
    params: { page: 1, pageSize: 200 },
  });
  return response.data.data.map((item) => ({
    ...item,
    goalsJson: item.goalsJson ?? {},
    tags: item.tags ?? [],
  }));
}
