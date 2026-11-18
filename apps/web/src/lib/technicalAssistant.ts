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
