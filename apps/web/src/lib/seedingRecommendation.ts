import {
  FORAGE_CATEGORY,
  type KgHaRange,
  type KgHaRangeCheck,
  calculateSeeding,
  calculateVc,
  checkKgHaRange,
  fieldLossWarningMessage,
  formatKgHaRange,
  kgHaMissingHint,
  parseDecimal,
  resolveKgHaRange,
} from "./technicalAssistant";

// "Recomendação de semeadura" do Assistente Técnico: um estado só para cultura, plantio e lote. As contas são
// as do technicalAssistant.ts (calculateSeeding e calculateVc); aqui só se decide qual valor entra em cada
// campo e de onde ele veio.
//
// Origem dos padrões: a germinação e a pureza do Catálogo Técnico são o menor padrão mínimo do MAPA (regra do
// technicalCatalog.json); população, espaçamento e PMS são do catálogo. A lista reduzida sem conexão
// (CULTURE_FALLBACKS) não segue essa regra: com ela, germinação, pureza e PMS são pedidos ao usuário.

export const SPACING_OPTIONS_CM = [45, 50, 70, 90] as const;

export const LEGUME_CATEGORY = "Leguminosas";

export type RecommendationMode = "simple" | "complete";

export const MODE_STORAGE_KEY = "technical_assistant_seeding_mode";

export type ValueOrigin = "typed" | "catalog" | "mapa_minimum" | "offline_list";

export const ORIGIN_LABEL: Record<ValueOrigin, string> = {
  typed: "digitado",
  catalog: "catálogo",
  mapa_minimum: "mínimo legal do MAPA",
  offline_list: "lista reduzida, sem conexão",
};

// Forrageiras: o padrão do MAPA é de germinação (IN 30/2008, Anexo III), mas braquiárias e Panicum maximum podem
// ser comercializadas pela viabilidade do tetrazólio (Anexo I, IV, item 3, redação da IN 30/2010). O campo aceita
// um ou outro e a conta não muda.
export const GERMINATION_TERM = "germinação";
export const FORAGE_GERMINATION_TERM = "germinação ou viabilidade";

export const germinationTerm = (forage: boolean) => (forage ? FORAGE_GERMINATION_TERM : GERMINATION_TERM);

export const germinationFieldLabel = (forage: boolean) => (forage ? "Germinação ou viabilidade (%)" : "Germinação (%)");

export const CONFORMITY_TERM_HINT =
  "Com o termo de conformidade (acompanha a nota fiscal), use a pureza e a germinação ou viabilidade dele.";

export const FORAGE_VIABILITY_NOTE =
  "Para braquiárias e Panicum maximum, a IN 30/2008 (Anexo I, IV, item 3, redação da IN 30/2010) permite comercializar com viabilidade (tetrazólio); nas demais forrageiras, use a germinação do termo de conformidade.";

export const FORAGE_VC_FORMULA = "VC = pureza × germinação ou viabilidade.";

/** Forrageira: análise do termo de conformidade. O tetrazólio já conta a semente dura viável. */
export type ForageAnalysis = "germination" | "viability";

export const FORAGE_ANALYSIS_LABEL: Record<ForageAnalysis, string> = {
  germination: "Germinação",
  viability: "Viabilidade (tetrazólio)",
};

export const MAPA_GERMINATION_WARNING =
  "Estimativa segura com a germinação mínima legal; com o lote faturado, geralmente será um pouco menos.";

export const PROMPTS = {
  population: "Informe a população desejada (plantas/ha).",
  germination: "Informe a germinação do lote.",
  germinationRange: "A germinação deve ficar entre 0 e 100%.",
  forageGermination: "Informe a germinação ou viabilidade do lote.",
  forageGerminationRange: "A germinação ou viabilidade deve ficar entre 0 e 100%.",
  purity: "Informe a pureza do lote.",
  puritySimple: "Esta cultura não tem pureza padrão: abra o modo Completo e informe a pureza do lote.",
  purityRange: "A pureza deve ficar entre 0 e 100%.",
  hardSeedsRange: "Sementes duras deve ficar entre 0 e 100%.",
  spacing: "Escolha o espaçamento.",
  spvDose: "Informe a dose de SPV desejada (kg/ha).",
  physicalDose: "Informe a dose física (kg/ha).",
} as const;

export const VC_NO_PURITY = "Informe a pureza do lote para ver o VC.";
export const VC_NO_PURITY_SIMPLE = "VC: esta cultura não tem pureza padrão; abra o modo Completo e informe a pureza do lote.";

export type RecommendationCulture = {
  label: string;
  category: string;
  defaultKgHaMin: number | null;
  defaultKgHaMax: number | null;
  goalsJson?: Record<string, unknown> | null;
  populationTargetDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  pmsDefault: number | null;
};

/** Campos digitados; vazio = padrão da cultura (população, germinação, pureza, PMS) ou zero (perda, duras). */
export type RecommendationForm = {
  goal: string;
  spacingCm: string;
  population: string;
  germination: string;
  purity: string;
  pms: string;
  hardSeeds: string;
  fieldLoss: string;
  spvDose: string;
  physicalDose: string;
  /** Forrageira, modo Completo: "physical" = "Já tenho a dose física". */
  forageDoseInput: "spv" | "physical";
  /** Forrageira, modo Completo: com "viability" as sementes duras não entram no VC. */
  forageAnalysis: ForageAnalysis;
};

export const EMPTY_RECOMMENDATION_FORM: RecommendationForm = {
  goal: "",
  spacingCm: "",
  population: "",
  germination: "",
  purity: "",
  pms: "",
  hardSeeds: "",
  fieldLoss: "0",
  spvDose: "",
  physicalDose: "",
  forageDoseInput: "spv",
  forageAnalysis: "germination",
};

export type UsedValue = { value: number; origin: ValueOrigin } | null;

export type SeedingRecommendation = {
  path: "seeds" | "forage";
  /** Texto do Copiar e do WhatsApp disponível: sementes por metro (ou, na forrageira, as duas doses). */
  ready: boolean;
  /** Pedidos dos campos que faltam, na ordem da tela. */
  prompts: string[];
  population: UsedValue;
  germination: UsedValue;
  purity: UsedValue;
  pms: UsedValue;
  /** Sementes duras usadas no VC (0 sem valor ou no modo Simples). */
  hardSeeds: number;
  rowSpacingCm: number | null;
  fieldLossApplied: number;
  fieldLossWarning: string | null;
  germinationWarning: string | null;
  plantsM2: number | null;
  seedsM2: number | null;
  seedsPerMeter: number | null;
  /** Sementes a cada 10 m, arredondado: o vendedor confere contando 10 m de linha. */
  seedsPer10m: number | null;
  kgHa: number | null;
  /** kg/ha sem a perda a campo (só quando há perda). */
  kgHaBase: number | null;
  kgHaUnavailableReason: string | null;
  range: KgHaRange | null;
  rangeCheck: KgHaRangeCheck | null;
  vc: number | null;
  correctionFactor: number | null;
  effectiveGermination: number | null;
  vcUnavailableReason: string | null;
  forageDoseInput: "spv" | "physical";
  spvDose: number | null;
  physicalDose: number | null;
  /** Pontos de VC = SPV × 100 (equivalência). */
  vcPoints: number | null;
};

export const isForageCulture = (culture: { category: string }) => culture.category.trim() === FORAGE_CATEGORY;

/** Sementes duras: leguminosas e forrageiras, só no VC. */
export const acceptsHardSeeds = (culture: { category: string }) =>
  isForageCulture(culture) || culture.category.trim() === LEGUME_CATEGORY;

/** Sementes duras no modo Completo: leguminosa e forrageira, exceto forrageira analisada por viabilidade. */
export const hardSeedsApply = (culture: { category: string }, form: Pick<RecommendationForm, "forageAnalysis">) =>
  acceptsHardSeeds(culture) && !(isForageCulture(culture) && form.forageAnalysis === "viability");

const positive = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

/** Percentual digitado: null vazio; "range" acima de 100. */
const typedPercent = (text: string): number | "range" | null => {
  const value = positive(parseDecimal(text));
  if (value == null) return null;
  return value > 100 ? "range" : value;
};

export function seedingRecommendation(
  culture: RecommendationCulture,
  form: RecommendationForm,
  options: { offline: boolean; mode: RecommendationMode }
): SeedingRecommendation {
  const { offline, mode } = options;
  const complete = mode === "complete";
  const forage = isForageCulture(culture);
  const prompts: string[] = [];

  // População (só no caminho de sementes por metro).
  let population: UsedValue = null;
  if (!forage) {
    const typed = positive(parseDecimal(form.population));
    const fallback = positive(culture.populationTargetDefault);
    if (typed != null) population = { value: typed, origin: "typed" };
    else if (fallback != null) population = { value: fallback, origin: offline ? "offline_list" : "catalog" };
  }

  // Dose da forrageira vem antes da germinação na tela.
  const forageDoseInput = forage && complete ? form.forageDoseInput : "spv";
  const typedSpv = positive(parseDecimal(form.spvDose));
  const typedPhysical = positive(parseDecimal(form.physicalDose));
  if (forage) {
    if (forageDoseInput === "spv" && typedSpv == null) prompts.push(PROMPTS.spvDose);
    if (forageDoseInput === "physical" && typedPhysical == null) prompts.push(PROMPTS.physicalDose);
  } else if (population == null) {
    prompts.push(PROMPTS.population);
  }

  // Germinação: digitada; sem ela, o mínimo legal do MAPA do catálogo. Sem conexão ou sem padrão, pede.
  let germination: UsedValue = null;
  const germinationTyped = typedPercent(form.germination);
  const germinationDefault = offline ? null : positive(culture.germinationDefault);
  if (germinationTyped === "range") prompts.push(forage ? PROMPTS.forageGerminationRange : PROMPTS.germinationRange);
  else if (germinationTyped != null) germination = { value: germinationTyped, origin: "typed" };
  else if (germinationDefault != null && germinationDefault <= 100) germination = { value: germinationDefault, origin: "mapa_minimum" };
  else prompts.push(forage ? PROMPTS.forageGermination : PROMPTS.germination);

  // Espaçamento (só no caminho de sementes por metro).
  const rowSpacingCm = forage ? null : positive(parseDecimal(form.spacingCm));
  if (!forage && rowSpacingCm == null) prompts.push(PROMPTS.spacing);

  // Lote: no modo Simples, pureza e PMS só do catálogo; perda e sementes duras ficam em zero.
  let purity: UsedValue = null;
  let purityRangeError = false;
  const purityTyped = complete ? typedPercent(form.purity) : null;
  const purityDefault = offline ? null : positive(culture.purityDefault);
  if (purityTyped === "range") purityRangeError = true;
  else if (purityTyped != null) purity = { value: purityTyped, origin: "typed" };
  else if (purityDefault != null && purityDefault <= 100) purity = { value: purityDefault, origin: "mapa_minimum" };

  let pms: UsedValue = null;
  const pmsTyped = complete ? positive(parseDecimal(form.pms)) : null;
  const pmsDefault = offline ? null : positive(culture.pmsDefault);
  if (pmsTyped != null) pms = { value: pmsTyped, origin: "typed" };
  else if (pmsDefault != null) pms = { value: pmsDefault, origin: "catalog" };

  let hardSeeds = 0;
  let hardSeedsRangeError = false;
  if (complete && hardSeedsApply(culture, form)) {
    const typed = typedPercent(form.hardSeeds);
    if (typed === "range") hardSeedsRangeError = true;
    else if (typed != null) hardSeeds = typed;
  }

  const fieldLossPercent = complete ? parseDecimal(form.fieldLoss) ?? 0 : 0;

  // Na forrageira a pureza é obrigatória (a dose depende do VC); no outro caminho só o VC e o kg/ha somem.
  if (purityRangeError) prompts.push(PROMPTS.purityRange);
  else if (forage && purity == null) prompts.push(complete ? PROMPTS.purity : PROMPTS.puritySimple);
  if (hardSeedsRangeError) prompts.push(PROMPTS.hardSeedsRange);

  const seeding = calculateSeeding({
    populationHa: population?.value ?? 0,
    rowSpacingCm: rowSpacingCm ?? 0,
    pms: pms?.value ?? 0,
    germination: germination?.value ?? 0,
    purity: purity?.value ?? 0,
    fieldLossPercent,
  });

  // VC = pureza × germinação efetiva (germinação, ou viabilidade na forrageira, + sementes duras, até 100%).
  const vcResult =
    germination != null && purity != null && !hardSeedsRangeError
      ? calculateVc({
          purity: purity.value,
          germination: germination.value,
          hardSeeds,
          considerHardSeeds: hardSeeds > 0,
          physicalDose: forage && forageDoseInput === "physical" ? typedPhysical : null,
          spvDose: forage && forageDoseInput === "spv" ? typedSpv : null,
          lastEditedDose: null,
        })
      : null;
  const vcReady = vcResult != null && vcResult.ready && vcResult.vc > 0;
  const vcUnavailableReason = vcReady || germination == null || purityRangeError || hardSeedsRangeError || forage ? null : complete ? VC_NO_PURITY : VC_NO_PURITY_SIMPLE;

  const seedsPerMeter = !forage && prompts.length === 0 ? seeding.seedsPerMeter : null;
  const seedsReady = !forage && germination != null && population != null && seeding.seedsReady;

  const kgHa = seedsPerMeter != null && seeding.ready ? seeding.kgHa : null;
  let kgHaUnavailableReason: string | null = null;
  if (seedsPerMeter != null && kgHa == null) {
    const missing = [purity ? null : "a pureza", pms ? null : "o PMS"].filter(Boolean).join(" e ");
    kgHaUnavailableReason = complete
      ? kgHaMissingHint({ pms: pms?.value ?? 0, purity: purity?.value ?? 0 }, seeding)
      : `kg/ha: abra o modo Completo e informe ${missing} do lote.`;
  }

  const range = forage ? null : resolveKgHaRange(culture, form.goal);
  const check = kgHa != null && range ? checkKgHaRange(kgHa, range) : null;

  let spvDose: number | null = null;
  let physicalDose: number | null = null;
  if (forage && vcReady && prompts.length === 0) {
    if (forageDoseInput === "spv") {
      spvDose = typedSpv;
      physicalDose = vcResult.physicalDoseNeeded;
    } else {
      physicalDose = typedPhysical;
      spvDose = vcResult.spvDose;
    }
  }

  const ready = forage ? spvDose != null && physicalDose != null : seedsPerMeter != null;

  return {
    path: forage ? "forage" : "seeds",
    ready,
    prompts,
    population,
    germination,
    purity,
    pms,
    hardSeeds,
    rowSpacingCm,
    fieldLossApplied: seeding.fieldLossApplied,
    fieldLossWarning: fieldLossWarningMessage(seeding.fieldLossWarning),
    germinationWarning: germination?.origin === "mapa_minimum" ? MAPA_GERMINATION_WARNING : null,
    plantsM2: population != null ? seeding.plantsM2 : null,
    seedsM2: seedsReady ? seeding.seedsM2 : null,
    seedsPerMeter,
    seedsPer10m: seedsPerMeter != null ? Math.round(seedsPerMeter * 10) : null,
    kgHa,
    kgHaBase: kgHa != null && seeding.fieldLossApplied > 0 ? seeding.kgHaBase : null,
    kgHaUnavailableReason,
    range,
    rangeCheck: check && check.status !== "no_range" ? check : null,
    vc: vcReady ? vcResult.vc : null,
    correctionFactor: vcReady ? vcResult.correctionFactor : null,
    effectiveGermination: vcReady ? vcResult.effectiveGermination : null,
    vcUnavailableReason,
    forageDoseInput,
    spvDose,
    physicalDose,
    vcPoints: spvDose != null ? spvDose * 100 : null,
  };
}

/** Número com até `digits` casas (sem zeros à direita). */
export const formatNumber = (value: number, digits: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Sementes por metro sempre com 1 casa: 5,98 → "6,0", 5,94 → "5,9". */
export const formatSeedsPerMeter = (value: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const withOrigin = (text: string, used: UsedValue) =>
  used && used.origin !== "typed" ? `${text} (${ORIGIN_LABEL[used.origin]})` : text;

const vcLine = (rec: SeedingRecommendation) => {
  if (rec.vc == null || rec.correctionFactor == null || rec.effectiveGermination == null) return null;
  const term = germinationTerm(rec.path === "forage");
  const germination = rec.hardSeeds > 0
    ? `${term} efetiva ${formatNumber(rec.effectiveGermination, 1)}% (${term} ${formatNumber(rec.germination?.value ?? 0, 1)}% + sementes duras ${formatNumber(rec.hardSeeds, 1)}%)`
    : withOrigin(`${term} ${formatNumber(rec.germination?.value ?? 0, 1)}%`, rec.germination);
  return `VC do lote ${formatNumber(rec.vc, 1)}% = ${withOrigin(`pureza ${formatNumber(rec.purity?.value ?? 0, 1)}%`, rec.purity)} × ${germination}; fator de correção ${formatNumber(rec.correctionFactor, 2)}.`;
};

/** Texto do Copiar e do WhatsApp. Vazio enquanto não há resultado. */
export function seedingRecommendationText(cultureLabel: string, goalLabel: string, rec: SeedingRecommendation) {
  if (!rec.ready) return "";
  const title = goalLabel ? `${cultureLabel} (${goalLabel})` : cultureLabel;
  const lines: string[] = [];

  if (rec.path === "forage") {
    if (rec.physicalDose == null || rec.spvDose == null || rec.vcPoints == null) return "";
    lines.push(`${title}: ${formatNumber(rec.physicalDose, 1)} kg/ha do lote (dose física)`);
    lines.push(`Dose de SPV ${formatNumber(rec.spvDose, 1)} kg/ha (${formatNumber(rec.vcPoints, 0)} pontos de VC).`);
  } else {
    if (rec.seedsPerMeter == null || rec.seedsPer10m == null) return "";
    lines.push(`${title}: ${formatSeedsPerMeter(rec.seedsPerMeter)} sementes por metro (≈ ${rec.seedsPer10m} a cada 10 m)`);
    lines.push(
      `Espaçamento ${formatNumber(rec.rowSpacingCm ?? 0, 1)} cm, ${withOrigin(`população ${formatNumber(rec.population?.value ?? 0, 0)} plantas/ha`, rec.population)}, ${withOrigin(`germinação ${formatNumber(rec.germination?.value ?? 0, 1)}%`, rec.germination)}, perda a campo ${formatNumber(rec.fieldLossApplied, 1)}%.`
    );
    if (rec.plantsM2 != null && rec.seedsM2 != null) {
      lines.push(`${formatNumber(rec.plantsM2, 1)} plantas/m², ${formatNumber(rec.seedsM2, 1)} sementes/m².`);
    }
    if (rec.kgHa != null && rec.pms && rec.purity) {
      lines.push(
        `${formatNumber(rec.kgHa, 2)} kg/ha com ${withOrigin(`PMS ${formatNumber(rec.pms.value, 2)} g`, rec.pms)} e ${withOrigin(`pureza ${formatNumber(rec.purity.value, 1)}%`, rec.purity)}.`
      );
    }
    if (rec.range) lines.push(`Faixa de referência: ${formatKgHaRange(rec.range)}.`);
  }

  const vc = vcLine(rec);
  if (vc) lines.push(vc);
  if (rec.germinationWarning) lines.push(rec.germinationWarning);
  lines.push("Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.");
  return lines.join("\n");
}

/** Link do WhatsApp sem número: o próprio WhatsApp pede para escolher o contato. */
export function whatsappShareUrl(text: string) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** Modo salvo no aparelho; "simple" quando não há ou o navegador bloqueia. */
export function readStoredMode(): RecommendationMode {
  try {
    return globalThis.localStorage?.getItem(MODE_STORAGE_KEY) === "complete" ? "complete" : "simple";
  } catch {
    return "simple";
  }
}

export function storeMode(mode: RecommendationMode) {
  try {
    globalThis.localStorage?.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Navegador sem armazenamento: o modo vale só nesta visita.
  }
}
