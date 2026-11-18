// Contas do Assistente Técnico (Calculadora de Semeadura e Valor Cultural), sem React, para a tela e os
// testes usarem a mesma regra.

export function parseDecimal(value: string | null | undefined): number | null {
  const normalized = (value ?? "").replace(",", ".").trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

type CultureSeedingDefaultsSource = {
  populationTargetDefault: number | null;
  rowSpacingCmDefault: number | null;
  pmsDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
};

const toFieldText = (value: number | null) => (value != null ? String(value) : "");

/** Padrões da cultura para os campos da Calculadora de Semeadura (campo vazio quando a cultura não tem). */
export function cultureSeedingDefaults(culture: CultureSeedingDefaultsSource) {
  return {
    populacaoHa: toFieldText(culture.populationTargetDefault),
    espacamentoCm: toFieldText(culture.rowSpacingCmDefault),
    pms: toFieldText(culture.pmsDefault),
    germinacao: toFieldText(culture.germinationDefault),
    pureza: toFieldText(culture.purityDefault),
  };
}

export type SeedingInput = {
  populationHa: number;
  rowSpacingCm: number;
  pms: number;
  germination: number;
  purity: number;
  fieldCorrectionPercent: number;
};

export type SeedingResult = {
  ready: boolean;
  plantsM2: number;
  seedsM2: number;
  seedsPerMeter: number;
  /** kg/ha só pela qualidade do lote (germinação × pureza), antes da correção de campo. */
  kgHaBase: number;
  /** kg/ha final, já com a correção de campo. */
  kgHa: number;
};

export function calculateSeeding(input: SeedingInput): SeedingResult {
  const { populationHa, rowSpacingCm, pms, germination, purity, fieldCorrectionPercent } = input;
  const plantsM2 = populationHa / 10000;
  const qualityFactor = (germination / 100) * (purity / 100);
  const fieldFactor = 1 + fieldCorrectionPercent / 100;

  if (qualityFactor <= 0 || fieldFactor <= 0 || rowSpacingCm <= 0 || pms <= 0 || populationHa <= 0) {
    return { ready: false, plantsM2, seedsM2: 0, seedsPerMeter: 0, kgHaBase: 0, kgHa: 0 };
  }

  const seedsHaBase = populationHa / qualityFactor;
  const seedsHa = seedsHaBase * fieldFactor;
  const seedsM2 = seedsHa / 10000;
  const seedsPerMeter = seedsM2 * (rowSpacingCm / 100);

  // PMS é o peso de 1.000 sementes em gramas: kg/ha = sementes/ha × PMS ÷ 1.000.000.
  return {
    ready: true,
    plantsM2,
    seedsM2,
    seedsPerMeter,
    kgHaBase: (seedsHaBase * pms) / 1000000,
    kgHa: (seedsHa * pms) / 1000000,
  };
}

export type VcInput = {
  purity: number | null;
  germination: number | null;
  hardSeeds: number | null;
  considerHardSeeds: boolean;
  physicalDose: number | null;
  spvDose: number | null;
  lastEditedDose: "fisica" | "spv" | null;
};

export type VcResult = {
  errors: string[];
  ready: boolean;
  vc: number;
  correctionFactor: number;
  effectiveGermination: number;
  spvDose: number | null;
  physicalDoseNeeded: number | null;
};

export function calculateVc(input: VcInput): VcResult {
  const { purity, germination, considerHardSeeds, physicalDose, spvDose, lastEditedDose } = input;
  const hardSeeds = input.hardSeeds ?? 0;
  const errors: string[] = [];

  if (purity != null && (purity < 0 || purity > 100)) errors.push("Pureza deve estar entre 0 e 100%.");
  if (germination != null && (germination < 0 || germination > 100)) errors.push("Germinação deve estar entre 0 e 100%.");
  if (considerHardSeeds && (hardSeeds < 0 || hardSeeds > 100)) errors.push("Sementes duras deve estar entre 0 e 100%.");
  if ((physicalDose != null && physicalDose < 0) || (spvDose != null && spvDose < 0)) {
    errors.push("As doses devem ser valores iguais ou maiores que zero.");
  }

  if (purity == null || germination == null) {
    return { errors, ready: false, vc: 0, correctionFactor: 0, effectiveGermination: 0, spvDose: null, physicalDoseNeeded: null };
  }

  const effectiveGermination = considerHardSeeds ? Math.min(100, germination + hardSeeds) : germination;
  const vc = (purity * effectiveGermination) / 100;
  const correctionFactor = vc > 0 ? 100 / vc : 0;

  // Com as duas doses preenchidas, vale a última editada.
  const both = physicalDose != null && spvDose != null;
  const physicalBase = both && lastEditedDose === "spv" ? null : physicalDose;
  const spvBase = both && lastEditedDose !== "spv" ? null : spvDose;

  return {
    errors,
    ready: true,
    vc,
    correctionFactor,
    effectiveGermination,
    spvDose: physicalBase != null ? physicalBase * (vc / 100) : null,
    physicalDoseNeeded: spvBase != null && vc > 0 ? spvBase / (vc / 100) : null,
  };
}

// ---- Faixa de referência (kg/ha) ----

export type KgHaRange = { min: number; max: number };

export type GoalOption = { key: string; label: string; range: KgHaRange };

// As chaves do goalsJson chegam normalizadas, sem acento (normalizeGoalKey na API).
const GOAL_LABELS: Record<string, string> = {
  grao: "Grão",
  silagem: "Silagem",
  cobertura: "Cobertura",
  pastejo: "Pastejo",
};

export function goalLabel(key: string) {
  const known = GOAL_LABELS[key];
  if (known) return known;
  const text = key.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

const isValidRange = (range: unknown): range is KgHaRange => {
  if (!range || typeof range !== "object") return false;
  const { min, max } = range as { min?: unknown; max?: unknown };
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min;
};

/** Objetivos com faixa válida no goalsJson da cultura, na ordem cadastrada. */
export function cultureGoalOptions(goalsJson: Record<string, unknown> | null | undefined): GoalOption[] {
  return Object.entries(goalsJson ?? {})
    .filter((entry): entry is [string, KgHaRange] => isValidRange(entry[1]))
    .map(([key, range]) => ({ key, label: goalLabel(key), range: { min: range.min, max: range.max } }));
}

export function cultureDefaultRange(culture: { defaultKgHaMin: number | null; defaultKgHaMax: number | null }): KgHaRange | null {
  const range = { min: culture.defaultKgHaMin, max: culture.defaultKgHaMax };
  return isValidRange(range) ? range : null;
}

/** Faixa usada no aviso: a do objetivo escolhido, se houver; senão a faixa geral da cultura. */
export function resolveKgHaRange(
  culture: { defaultKgHaMin: number | null; defaultKgHaMax: number | null; goalsJson?: Record<string, unknown> | null },
  goalKey: string
): KgHaRange | null {
  const goal = goalKey ? cultureGoalOptions(culture.goalsJson).find((option) => option.key === goalKey) : undefined;
  return goal ? goal.range : cultureDefaultRange(culture);
}

const formatRangeNumber = (value: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function formatKgHaRange(range: KgHaRange) {
  return `${formatRangeNumber(range.min)}–${formatRangeNumber(range.max)} kg/ha`;
}

export type KgHaRangeCheck =
  | { status: "no_range" }
  | { status: "below" | "within" | "above"; range: KgHaRange };

/**
 * Compara o kg/ha calculado com a faixa. Compara o valor arredondado a 2 casas, o mesmo que a tela
 * mostra. Sem resultado calculado (kgHa null) não há o que comparar.
 */
export function checkKgHaRange(kgHa: number | null, range: KgHaRange | null): KgHaRangeCheck | null {
  if (!range) return { status: "no_range" };
  if (kgHa == null || !Number.isFinite(kgHa) || kgHa <= 0) return null;
  const shown = Math.round(kgHa * 100) / 100;
  if (shown < range.min) return { status: "below", range };
  if (shown > range.max) return { status: "above", range };
  return { status: "within", range };
}

export function kgHaRangeMessage(check: KgHaRangeCheck) {
  switch (check.status) {
    case "no_range":
      return "Sem faixa de referência cadastrada para esta cultura.";
    case "below":
      return `Abaixo da faixa de referência (${formatKgHaRange(check.range)}). Confira PMS, população e perda a campo.`;
    case "above":
      return `Acima da faixa de referência (${formatKgHaRange(check.range)}). Confira PMS, população e perda a campo.`;
    case "within":
      return `Dentro da faixa de referência (${formatKgHaRange(check.range)}).`;
  }
}
