import { useEffect, useMemo, useState } from "react";
import api from "../lib/apiClient";

type CatalogGoal = {
  rangeMin: number;
  rangeMax: number;
  unit: string;
  notes: string[];
};

export type CatalogCulture = {
  id: string;
  key: string;
  label: string;
  notes: string[];
  active: boolean;
  goalsJson: Record<string, CatalogGoal>;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const normalizeGoal = (value: unknown): CatalogGoal | null => {
  if (!value || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;

  if (!isFiniteNumber(goal.rangeMin) || !isFiniteNumber(goal.rangeMax)) return null;

  return {
    rangeMin: goal.rangeMin,
    rangeMax: goal.rangeMax,
    unit: typeof goal.unit === "string" && goal.unit.trim() ? goal.unit : "kg/ha",
    notes: Array.isArray(goal.notes) ? goal.notes.filter((item): item is string => typeof item === "string") : []
  };
};

const normalizeCulture = (value: unknown): CatalogCulture | null => {
  if (!value || typeof value !== "object") return null;

  const culture = value as Record<string, unknown>;
  const goalsRaw = culture.goalsJson;
  if (!goalsRaw || typeof goalsRaw !== "object") return null;

  const goalsJson: Record<string, CatalogGoal> = {};
  Object.entries(goalsRaw).forEach(([goalKey, goalValue]) => {
    const normalizedGoal = normalizeGoal(goalValue);
    if (normalizedGoal) goalsJson[goalKey] = normalizedGoal;
  });

  if (!Object.keys(goalsJson).length) return null;

  return {
    id: typeof culture.id === "string" ? culture.id : `culture-${String(culture.key ?? "")}`,
    key: typeof culture.key === "string" ? culture.key : "",
    label: typeof culture.label === "string" ? culture.label : "",
    notes: Array.isArray(culture.notes) ? culture.notes.filter((item): item is string => typeof item === "string") : [],
    active: culture.active !== false,
    goalsJson
  };
};

export const LOCAL_CULTURES_FALLBACK: CatalogCulture[] = [
  {
    id: "fallback-sorgo",
    key: "sorgo",
    label: "Sorgo",
    active: true,
    notes: ["Ajustar conforme PMS e qualidade real do lote."],
    goalsJson: {
      silagem: { rangeMin: 12, rangeMax: 18, unit: "kg/ha", notes: ["Monitorar profundidade e umidade para emergência uniforme."] },
      grao: { rangeMin: 8, rangeMax: 12, unit: "kg/ha", notes: ["Revisar janela de semeadura e população-alvo."] }
    }
  },
  {
    id: "fallback-milheto",
    key: "milheto",
    label: "Milheto",
    active: true,
    notes: ["Indicado para cobertura e reciclagem de nutrientes."],
    goalsJson: {
      cobertura: { rangeMin: 15, rangeMax: 20, unit: "kg/ha", notes: ["Ajustar para mais palhada em áreas com alta pressão de invasoras."] }
    }
  },
  {
    id: "fallback-brachiaria",
    key: "brachiaria",
    label: "Brachiaria",
    active: true,
    notes: ["Dose varia conforme espécie e método de implantação."],
    goalsJson: {
      cobertura: { rangeMin: 8, rangeMax: 15, unit: "kg/ha", notes: ["Garantir contato solo-semente para bom estabelecimento."] }
    }
  }
];

export function useCulturesCatalog() {
  const [data, setData] = useState<CatalogCulture[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFallback, setIsFallback] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      try {
        const response = await api.get("/cultures?active=true");
        const parsed = Array.isArray(response.data) ? response.data.map(normalizeCulture).filter((item): item is CatalogCulture => Boolean(item)) : [];

        if (!parsed.length) throw new Error("Catálogo vazio");

        if (!active) return;
        setData(parsed);
        setIsFallback(false);
      } catch {
        if (!active) return;
        setData(LOCAL_CULTURES_FALLBACK);
        setIsFallback(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  const catalog = useMemo(() => data, [data]);

  return {
    catalog,
    loading,
    isFallback
  };
}
