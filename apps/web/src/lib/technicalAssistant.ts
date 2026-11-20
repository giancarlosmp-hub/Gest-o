// Contas do Assistente Técnico (semeadura e Valor Cultural), sem React. A Recomendação de semeadura
// (seedingRecommendation.ts) e os testes usam a mesma regra.

/**
 * Lê número digitado no padrão brasileiro: vírgula decimal ("12,5"), ponto de milhar ("180.000",
 * "1.234,5") ou ponto decimal ("12.5"). Ponto seguido de exatamente três dígitos, sem vírgula, é milhar.
 */
export function parseDecimal(value: string | null | undefined): number | null {
  let normalized = (value ?? "").replace(/\s+/g, "");
  if (!normalized) return null;
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

// Mesmo nome de categoria do Catálogo Técnico (ALLOWED_CATEGORIES do importTechnicalCatalog na API).
export const FORAGE_CATEGORY = "Forrageiras";

export type SeedingInput = {
  populationHa: number;
  rowSpacingCm: number;
  pms: number;
  germination: number;
  purity: number;
  /** Perda a campo (%): sementes que não viram planta. A conta divide por (1 − perda). */
  fieldLossPercent: number;
};

export const MAX_FIELD_LOSS_PERCENT = 50;

export type SeedingResult = {
  /** kg/ha calculado: exige população, germinação, pureza e PMS. */
  ready: boolean;
  /** Sementes por m² e por metro calculadas: exigem só população e germinação (pureza e PMS não entram). */
  seedsReady: boolean;
  plantsM2: number;
  /** Sementes que a semeadora distribui por m²: população ÷ germinação ÷ (1 − perda), sem a pureza. */
  seedsM2: number;
  /** null sem espaçamento: o kg/ha sai mesmo assim, só sementes por metro fica sem valor. */
  seedsPerMeter: number | null;
  /** kg/ha só pela qualidade do lote (germinação × pureza), antes da perda a campo. */
  kgHaBase: number;
  /** kg/ha final, já com a perda a campo. */
  kgHa: number;
  /** Perda a campo usada na conta, depois do limite (0 a 50%). */
  fieldLossApplied: number;
  /** Aviso quando o valor digitado saiu do limite e a conta usou outro. */
  fieldLossWarning: "above_max" | "negative" | null;
};

export function calculateSeeding(input: SeedingInput): SeedingResult {
  const { populationHa, rowSpacingCm, pms, germination, purity, fieldLossPercent } = input;
  const plantsM2 = populationHa / 10000;

  const fieldLossWarning =
    fieldLossPercent > MAX_FIELD_LOSS_PERCENT ? "above_max" : fieldLossPercent < 0 ? "negative" : null;
  const fieldLossApplied = Math.min(MAX_FIELD_LOSS_PERCENT, Math.max(0, Number.isFinite(fieldLossPercent) ? fieldLossPercent : 0));
  const survivalFactor = 1 - fieldLossApplied / 100;

  if (germination <= 0 || populationHa <= 0) {
    return { ready: false, seedsReady: false, plantsM2, seedsM2: 0, seedsPerMeter: null, kgHaBase: 0, kgHa: 0, fieldLossApplied, fieldLossWarning };
  }

  // Sementes que a semeadora distribui: só a germinação corrige a população. A semeadora de disco conta
  // sementes, não peso, e a impureza não ocupa furo do disco (Embrapa Arroz e Feijão, Comunicado
  // Técnico 54: L = 100 × S × E ÷ V; Embrapa Milho e Sorgo, Sistema de Produção 2, Plantio).
  const seedsHaBase = populationHa / (germination / 100);
  const seedsHa = seedsHaBase / survivalFactor;
  const seedsM2 = seedsHa / 10000;
  // O espaçamento não entra no kg/ha: sem ele, a conta sai e só sementes por metro fica sem valor.
  const seedsPerMeter = rowSpacingCm > 0 ? seedsM2 * (rowSpacingCm / 100) : null;

  if (purity <= 0 || pms <= 0) {
    return { ready: false, seedsReady: true, plantsM2, seedsM2, seedsPerMeter, kgHaBase: 0, kgHa: 0, fieldLossApplied, fieldLossWarning };
  }

  // O peso do lote inclui a impureza: kg/ha = sementes/ha ÷ pureza × PMS ÷ 1.000.000 (PMS em gramas).
  const purityFactor = purity / 100;
  return {
    ready: true,
    seedsReady: true,
    plantsM2,
    seedsM2,
    seedsPerMeter,
    kgHaBase: (seedsHaBase / purityFactor) * pms / 1000000,
    kgHa: (seedsHa / purityFactor) * pms / 1000000,
    fieldLossApplied,
    fieldLossWarning,
  };
}

/**
 * Pedido do kg/ha quando as sementes por metro já saem mas falta pureza ou PMS. null quando o kg/ha sai
 * ou quando nem as sementes saem (aí os pedidos dos campos já aparecem).
 */
export function kgHaMissingHint(input: Pick<SeedingInput, "pms" | "purity">, result: SeedingResult): string | null {
  if (result.ready || !result.seedsReady) return null;
  const missing = [input.purity > 0 ? null : "a pureza", input.pms > 0 ? null : "o PMS"].filter(Boolean);
  return `Informe ${missing.join(" e ")} do lote para ver o kg/ha.`;
}

export function fieldLossWarningMessage(warning: SeedingResult["fieldLossWarning"]) {
  if (warning === "above_max") return `Perda a campo acima de ${MAX_FIELD_LOSS_PERCENT}%: a conta usa ${MAX_FIELD_LOSS_PERCENT}%. Confira o valor.`;
  if (warning === "negative") return "Perda a campo não pode ser negativa: a conta usa 0%.";
  return null;
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
