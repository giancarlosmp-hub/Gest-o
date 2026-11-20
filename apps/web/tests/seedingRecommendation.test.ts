import assert from "node:assert/strict";
import {
  EMPTY_RECOMMENDATION_FORM,
  MAPA_GERMINATION_WARNING,
  ORIGIN_LABEL,
  PROMPTS,
  SPACING_OPTIONS_CM,
  VC_NO_PURITY_SIMPLE,
  acceptsHardSeeds,
  formatSeedsPerMeter,
  readStoredMode,
  seedingRecommendation,
  seedingRecommendationText,
  whatsappShareUrl,
  type RecommendationCulture,
  type RecommendationForm,
} from "../src/lib/seedingRecommendation";

// "Recomendação de semeadura" do Assistente Técnico. Só culturas e lotes fictícios.
const close = (actual: number | null | undefined, expected: number, message: string, tolerance = 0.005) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${message}: esperado ${expected}, veio ${actual}`);

const culture = (overrides: Partial<RecommendationCulture> = {}): RecommendationCulture => ({
  label: "Cultura Teste A",
  category: "Grãos",
  defaultKgHaMin: 40,
  defaultKgHaMax: 60,
  goalsJson: { grao: { min: 50, max: 55 } },
  populationTargetDefault: 300000,
  germinationDefault: 80,
  purityDefault: 98,
  pmsDefault: null,
  ...overrides,
});

const forage = (overrides: Partial<RecommendationCulture> = {}) =>
  culture({
    label: "Forrageira Teste B",
    category: "Forrageiras",
    defaultKgHaMin: null,
    defaultKgHaMax: null,
    goalsJson: {},
    populationTargetDefault: null,
    germinationDefault: 60,
    purityDefault: 60,
    ...overrides,
  });

const form = (overrides: Partial<RecommendationForm> = {}): RecommendationForm => ({
  ...EMPTY_RECOMMENDATION_FORM,
  spacingCm: "45",
  ...overrides,
});
const simple = { offline: false, mode: "simple" } as const;
const complete = { offline: false, mode: "complete" } as const;

assert.deepEqual([...SPACING_OPTIONS_CM], [45, 50, 70, 90]);

// ---- Modo Simples com os padrões do catálogo ----
// 300.000 ÷ 0,8 = 375.000 sementes/ha → 37,5/m² × 0,45 = 16,875 sementes/m → ≈ 169 a cada 10 m.
const base = seedingRecommendation(culture(), form(), simple);
assert.equal(base.path, "seeds");
assert.equal(base.ready, true);
assert.deepEqual(base.prompts, []);
close(base.seedsPerMeter, 16.875, "sementes por metro");
assert.equal(base.seedsPer10m, 169);
close(base.plantsM2, 30, "plantas por m²");
close(base.seedsM2, 37.5, "sementes por m²");
assert.deepEqual(base.population, { value: 300000, origin: "catalog" });
assert.deepEqual(base.germination, { value: 80, origin: "mapa_minimum" });
assert.deepEqual(base.purity, { value: 98, origin: "mapa_minimum" });
assert.equal(base.germinationWarning, MAPA_GERMINATION_WARNING);
assert.equal(ORIGIN_LABEL.catalog, "catálogo");
assert.equal(ORIGIN_LABEL.mapa_minimum, "mínimo legal do MAPA");
assert.equal(ORIGIN_LABEL.typed, "digitado");
// VC = 98 × 80 ÷ 100 = 78,4%; fator 100 ÷ 78,4 = 1,2755.
close(base.vc, 78.4, "VC");
close(base.correctionFactor, 1.2755, "fator de correção", 0.0001);
// Sem PMS: kg/ha não aparece, com o pedido; o resultado (e o Copiar) sai mesmo assim.
assert.equal(base.kgHa, null);
assert.equal(base.kgHaUnavailableReason, "kg/ha: abra o modo Completo e informe o PMS do lote.");
assert.notEqual(seedingRecommendationText("Cultura Teste A", "", base), "", "Copiar funciona sem PMS");

// ---- 1 casa decimal: 5,98 aparece "6,0", não "6" ----
// 119.600 ÷ 1,0 = 119.600 sementes/ha → 11,96/m² × 0,5 = 5,98.
const rounding = seedingRecommendation(culture(), form({ population: "119.600", germination: "100", spacingCm: "50" }), simple);
close(rounding.seedsPerMeter, 5.98, "sementes por metro");
assert.equal(formatSeedsPerMeter(rounding.seedsPerMeter ?? 0), "6,0");
assert.equal(formatSeedsPerMeter(5.94), "5,9");
assert.equal(rounding.seedsPer10m, 60);
assert.match(seedingRecommendationText("Cultura Teste A", "", rounding), /^Cultura Teste A: 6,0 sementes por metro \(≈ 60 a cada 10 m\)/);

// ---- Valores digitados: origem "digitado" ----
const typed = seedingRecommendation(culture(), form({ population: "200.000", germination: "80" }), simple);
assert.deepEqual(typed.population, { value: 200000, origin: "typed" });
assert.deepEqual(typed.germination, { value: 80, origin: "typed" });
assert.equal(typed.germinationWarning, null);
close(typed.seedsPerMeter, 11.25, "sementes por metro digitadas");

// ---- Modo Simples ignora pureza, PMS, perda e sementes duras digitados no Completo ----
const lotTyped = form({ purity: "90", pms: "150", fieldLoss: "20", hardSeeds: "10" });
const simpleIgnores = seedingRecommendation(culture(), lotTyped, simple);
close(simpleIgnores.seedsPerMeter, 16.875, "perda ignorada no Simples");
assert.equal(simpleIgnores.pms, null);
assert.deepEqual(simpleIgnores.purity, { value: 98, origin: "mapa_minimum" });
assert.equal(simpleIgnores.fieldLossApplied, 0);
assert.equal(simpleIgnores.hardSeeds, 0);

// ---- Modo Completo: PMS digitado → kg/ha ----
// 375.000 ÷ 0,98 × 150 ÷ 1.000.000 = 57,40 kg/ha, dentro da faixa geral 40–60.
const withPms = seedingRecommendation(culture(), form({ pms: "150" }), complete);
close(withPms.kgHa, 57.398, "kg/ha");
assert.deepEqual(withPms.pms, { value: 150, origin: "typed" });
assert.equal(withPms.kgHaUnavailableReason, null);
assert.equal(withPms.kgHaBase, null, "sem perda, sem a linha do kg/ha sem perda");
assert.equal(withPms.rangeCheck?.status, "within");
// Objetivo "grao" (50–55): acima da faixa.
assert.equal(seedingRecommendation(culture(), form({ pms: "150", goal: "grao" }), complete).rangeCheck?.status, "above");

// PMS padrão do catálogo também dá kg/ha no Simples.
const catalogPms = seedingRecommendation(culture({ pmsDefault: 150 }), form(), simple);
close(catalogPms.kgHa, 57.398, "kg/ha com PMS do catálogo");
assert.deepEqual(catalogPms.pms, { value: 150, origin: "catalog" });

// Perda a campo 20%: 468.750 sementes/ha; kg/ha 71,75 e 57,40 sem a perda.
const withLoss = seedingRecommendation(culture(), form({ pms: "150", fieldLoss: "20" }), complete);
close(withLoss.seedsPerMeter, 21.094, "sementes por metro com perda");
close(withLoss.kgHa, 71.747, "kg/ha com perda");
close(withLoss.kgHaBase, 57.398, "kg/ha sem a perda");
assert.match(seedingRecommendation(culture(), form({ fieldLoss: "70" }), complete).fieldLossWarning ?? "", /acima de 50%/);

// Completo sem PMS: pedido no texto da lib (kgHaMissingHint).
assert.equal(seedingRecommendation(culture(), form(), complete).kgHaUnavailableReason, "Informe o PMS do lote para ver o kg/ha.");
assert.equal(
  seedingRecommendation(culture({ purityDefault: null }), form(), complete).kgHaUnavailableReason,
  "Informe a pureza e o PMS do lote para ver o kg/ha."
);

// ---- Sementes duras: leguminosas e forrageiras, só no VC ----
assert.equal(acceptsHardSeeds(culture()), false);
assert.equal(acceptsHardSeeds(culture({ category: "Leguminosas" })), true);
assert.equal(acceptsHardSeeds(forage()), true);
const legume = seedingRecommendation(culture({ category: "Leguminosas" }), form({ hardSeeds: "10" }), complete);
close(legume.seedsPerMeter, 16.875, "sementes duras não mudam sementes por metro");
close(legume.effectiveGermination, 90, "germinação efetiva");
close(legume.vc, 88.2, "VC com sementes duras");
// Grãos: sementes duras digitadas não entram.
close(seedingRecommendation(culture(), form({ hardSeeds: "10" }), complete).vc, 78.4, "grãos sem sementes duras");
assert.deepEqual(
  seedingRecommendation(culture({ category: "Leguminosas" }), form({ hardSeeds: "120" }), complete).prompts,
  [PROMPTS.hardSeedsRange]
);

// ---- Pedidos ----
const noGermination = seedingRecommendation(culture({ germinationDefault: null }), form(), simple);
assert.equal(noGermination.ready, false);
assert.deepEqual(noGermination.prompts, [PROMPTS.germination]);
assert.equal(seedingRecommendationText("Cultura Teste A", "", noGermination), "", "sem resultado, nada para copiar");
assert.deepEqual(seedingRecommendation(culture(), form({ germination: "120" }), simple).prompts, [PROMPTS.germinationRange]);
assert.deepEqual(
  seedingRecommendation(culture({ populationTargetDefault: null }), form({ spacingCm: "" }), simple).prompts,
  [PROMPTS.population, PROMPTS.spacing]
);
assert.deepEqual(seedingRecommendation(culture(), form({ purity: "101" }), complete).prompts, [PROMPTS.purityRange]);
close(seedingRecommendation(culture(), form({ spacingCm: "22,5" }), simple).seedsPerMeter, 8.4375, "outro espaçamento com vírgula");
// Sem pureza padrão no Simples: sementes por metro sai, VC pede o modo Completo.
const noPurity = seedingRecommendation(culture({ purityDefault: null }), form(), simple);
assert.equal(noPurity.ready, true);
assert.equal(noPurity.vc, null);
assert.equal(noPurity.vcUnavailableReason, VC_NO_PURITY_SIMPLE);

// ---- Sem conexão (lista reduzida): germinação pedida, pureza e PMS do catálogo não entram ----
const offline = { offline: true, mode: "complete" } as const;
assert.deepEqual(seedingRecommendation(culture({ pmsDefault: 150 }), form(), offline).prompts, [PROMPTS.germination]);
const offlineTyped = seedingRecommendation(culture({ pmsDefault: 150 }), form({ germination: "80" }), offline);
assert.equal(offlineTyped.ready, true);
assert.equal(offlineTyped.population?.origin, "offline_list");
assert.equal(offlineTyped.pms, null);
assert.equal(offlineTyped.purity, null);
assert.equal(offlineTyped.kgHa, null);
const offlineLot = seedingRecommendation(culture(), form({ germination: "80", purity: "98", pms: "150" }), offline);
close(offlineLot.kgHa, 57.398, "sem conexão, com o lote digitado");

// ---- Forrageira: dose física = SPV ÷ VC ----
// VC = 60 × 60 ÷ 100 = 36%; 3 kg SPV ÷ 0,36 = 8,33 kg/ha; 300 pontos de VC.
const spv = seedingRecommendation(forage(), form({ spvDose: "3" }), simple);
assert.equal(spv.path, "forage");
assert.equal(spv.ready, true);
assert.equal(spv.seedsPerMeter, null);
close(spv.vc, 36, "VC da forrageira");
close(spv.physicalDose, 8.3333, "dose física");
close(spv.vcPoints, 300, "pontos de VC");
assert.deepEqual(seedingRecommendation(forage(), form(), simple).prompts, [PROMPTS.spvDose], "SPV sem pré-preenchimento");
// Sementes duras no Completo: germinação efetiva 70% → VC 42% → 7,14 kg/ha.
close(seedingRecommendation(forage(), form({ spvDose: "3", hardSeeds: "10" }), complete).physicalDose, 7.1429, "com sementes duras");
// "Já tenho a dose física" (só no Completo): 10 kg/ha × 0,36 = 3,6 kg SPV, 360 pontos.
const physical = seedingRecommendation(forage(), form({ forageDoseInput: "physical", physicalDose: "10" }), complete);
close(physical.spvDose, 3.6, "SPV a partir da dose física");
close(physical.vcPoints, 360, "pontos de VC a partir da dose física");
assert.equal(physical.forageDoseInput, "physical");
// No Simples, a dose física guardada não vale: volta a pedir o SPV.
const physicalInSimple = seedingRecommendation(forage(), form({ forageDoseInput: "physical", physicalDose: "10" }), simple);
assert.equal(physicalInSimple.forageDoseInput, "spv");
assert.deepEqual(physicalInSimple.prompts, [PROMPTS.spvDose]);
// Forrageira sem pureza padrão: pede (no Simples, aponta o Completo).
assert.deepEqual(seedingRecommendation(forage({ purityDefault: null }), form({ spvDose: "3" }), simple).prompts, [PROMPTS.puritySimple]);
assert.deepEqual(seedingRecommendation(forage({ purityDefault: null }), form({ spvDose: "3" }), complete).prompts, [PROMPTS.purity]);

// ---- Texto do Copiar e do WhatsApp ----
assert.equal(
  seedingRecommendationText("Cultura Teste A", "", base),
  [
    "Cultura Teste A: 16,9 sementes por metro (≈ 169 a cada 10 m)",
    "Espaçamento 45 cm, população 300.000 plantas/ha (catálogo), germinação 80% (mínimo legal do MAPA), perda a campo 0%.",
    "30 plantas/m², 37,5 sementes/m².",
    "Faixa de referência: 40–60 kg/ha.",
    "VC do lote 78,4% = pureza 98% (mínimo legal do MAPA) × germinação 80% (mínimo legal do MAPA); fator de correção 1,28.",
    MAPA_GERMINATION_WARNING,
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.match(
  seedingRecommendationText("Cultura Teste A", "Grão", seedingRecommendation(culture(), form({ pms: "150", goal: "grao" }), complete)),
  /^Cultura Teste A \(Grão\): [\s\S]*57,4 kg\/ha com PMS 150 g e pureza 98% \(mínimo legal do MAPA\)\.\nFaixa de referência: 50–55 kg\/ha\./
);
assert.equal(
  seedingRecommendationText("Forrageira Teste B", "", spv),
  [
    "Forrageira Teste B: 8,3 kg/ha do lote (dose física)",
    "Dose de SPV 3 kg/ha (300 pontos de VC).",
    "VC do lote 36% = pureza 60% (mínimo legal do MAPA) × germinação 60% (mínimo legal do MAPA); fator de correção 2,78.",
    MAPA_GERMINATION_WARNING,
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.match(
  seedingRecommendationText("Cultura Teste C", "", legume),
  /germinação efetiva 90% \(germinação 80% \+ sementes duras 10%\)/
);

assert.equal(whatsappShareUrl("16,9 sementes & mais"), "https://wa.me/?text=16%2C9%20sementes%20%26%20mais");

// Modo no aparelho: sem localStorage (servidor), começa no Simples.
assert.equal(readStoredMode(), "simple");

console.log("seedingRecommendation.test.ts: ok");
