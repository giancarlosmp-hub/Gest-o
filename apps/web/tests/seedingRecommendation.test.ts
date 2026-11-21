import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SeedingRecommendation from "../src/components/technical/SeedingRecommendation";
import type { TechnicalCulture } from "../src/lib/technicalCultures";
import {
  CONFORMITY_TERM_HINT,
  EMPTY_RECOMMENDATION_FORM,
  FORAGE_VC_FORMULA,
  FORAGE_VIABILITY_NOTE,
  MAPA_GERMINATION_WARNING,
  ORIGIN_LABEL,
  PROMPTS,
  SPACING_OPTIONS_CM,
  VC_NO_PURITY_SIMPLE,
  acceptsHardSeeds,
  hardSeedsApply,
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
    "VC do lote 36% = pureza 60% (mínimo legal do MAPA) × germinação ou viabilidade 60% (mínimo legal do MAPA); fator de correção 2,78.",
    MAPA_GERMINATION_WARNING,
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.match(
  seedingRecommendationText("Cultura Teste C", "", legume),
  /germinação efetiva 90% \(germinação 80% \+ sementes duras 10%\)/
);
assert.doesNotMatch(seedingRecommendationText("Cultura Teste C", "", legume), /viabilidade/, "leguminosa só com germinação");
// Forrageira com sementes duras: o texto usa "germinação ou viabilidade".
assert.match(
  seedingRecommendationText(
    "Forrageira Teste B",
    "",
    seedingRecommendation(forage(), form({ spvDose: "3", germination: "70", purity: "80", hardSeeds: "10" }), complete)
  ),
  /× germinação ou viabilidade efetiva 80% \(germinação ou viabilidade 70% \+ sementes duras 10%\);/
);

// Forrageira: pedidos com "germinação ou viabilidade"; a conta é a mesma da germinação.
assert.deepEqual(
  seedingRecommendation(forage({ germinationDefault: null }), form({ spvDose: "3" }), simple).prompts,
  [PROMPTS.forageGermination]
);
assert.deepEqual(
  seedingRecommendation(forage(), form({ spvDose: "3", germination: "120" }), simple).prompts,
  [PROMPTS.forageGerminationRange]
);
// Análise do termo na forrageira (modo Completo). Germinação: sementes duras entram no VC (80 × 0,8 = 64%).
const byGermination = seedingRecommendation(
  forage(),
  form({ spvDose: "3", germination: "70", purity: "80", hardSeeds: "10", forageAnalysis: "germination" }),
  complete
);
assert.equal(byGermination.hardSeeds, 10);
close(byGermination.effectiveGermination, 80, "germinação + duras");
close(byGermination.vc, 64, "VC com germinação e duras");
// Viabilidade (tetrazólio): sementes duras digitadas não entram (80 × 0,7 = 56%).
const byViability = seedingRecommendation(
  forage(),
  form({ spvDose: "3", germination: "70", purity: "80", hardSeeds: "10", forageAnalysis: "viability" }),
  complete
);
assert.equal(byViability.hardSeeds, 0, "viabilidade ignora sementes duras");
close(byViability.effectiveGermination, 70, "só a viabilidade");
close(byViability.vc, 56, "VC com viabilidade");
assert.deepEqual(byViability.prompts, []);
assert.doesNotMatch(seedingRecommendationText("Forrageira Teste B", "", byViability), /sementes duras/);
// Viabilidade só vale para forrageira: leguminosa continua com sementes duras.
assert.equal(hardSeedsApply({ category: "Forrageiras" }, { forageAnalysis: "germination" }), true);
assert.equal(hardSeedsApply({ category: "Forrageiras" }, { forageAnalysis: "viability" }), false);
assert.equal(hardSeedsApply({ category: "Leguminosas" }, { forageAnalysis: "viability" }), true);
assert.equal(hardSeedsApply({ category: "Grãos" }, { forageAnalysis: "germination" }), false);
assert.equal(EMPTY_RECOMMENDATION_FORM.forageAnalysis, "germination", "começa em Germinação");

const forageTyped = seedingRecommendation(forage(), form({ spvDose: "3", germination: "60" }), simple);
assert.equal(forageTyped.vc, spv.vc, "viabilidade digitada dá o mesmo VC que a germinação");

assert.equal(whatsappShareUrl("16,9 sementes & mais"), "https://wa.me/?text=16%2C9%20sementes%20%26%20mais");

// Modo no aparelho: sem localStorage (servidor), começa no Simples.
assert.equal(readStoredMode(), "simple");

// ---- Cartão (render no servidor; sem localStorage, começa no modo Simples) ----
const card = (overrides: Partial<TechnicalCulture> = {}): TechnicalCulture => ({
  id: "cultura-a",
  slug: "cultura-a",
  isActive: true,
  notes: "Observação fictícia da cultura.",
  rowSpacingCmDefault: 50,
  tags: [],
  ...culture(),
  goalsJson: { grao: { min: 50, max: 55 } },
  ...overrides,
});
const render = (cultures: TechnicalCulture[], offlineList = false) =>
  renderToStaticMarkup(createElement(SeedingRecommendation, { cultures, offline: offlineList, canConfigureCatalog: false }));

const html = render([card()]);
assert.match(html, /Recomendação de semeadura/);
assert.match(html, /aria-pressed="true"[^>]*>Simples<\/button>/, "modo Simples por padrão");
// Espaçamento padrão 50 cm: 37,5/m² × 0,5 = 18,75 → "18,8" e ≈ 188 a cada 10 m.
assert.match(html, />18,8<\/p>/, "sementes por metro em destaque, 1 casa");
assert.match(html, /≈ 188 a cada 10 m/);
for (const option of ["45", "50", "70", "90", "outro"]) assert.match(html, new RegExp(`>${option}</button>`));
assert.match(html, /aria-pressed="true"[^>]*>50<\/button>/, "começa no espaçamento padrão da cultura");
assert.match(html, /Orientações da cultura/);
assert.match(html, /40–60 kg\/ha/, "faixa nas orientações");
assert.match(html, /300\.000 plantas\/ha/, "população recomendada");
assert.match(html, /Observação fictícia da cultura\./);
assert.match(html, /Objetivo/);
assert.match(html, />catálogo</);
assert.match(html, />mínimo legal do MAPA</);
assert.match(html, /78,4%/, "VC do lote");
assert.match(html, /kg\/ha: abra o modo Completo e informe o PMS do lote\./, "kg/ha — com o pedido");
assert.match(html, />Copiar<\/button>/, "Copiar sem PMS");
assert.match(html, />WhatsApp<\/button>/, "WhatsApp sem PMS");
for (const hidden of ["Pureza (%)", "PMS (g)", "Perda a campo (%)", "Sementes duras (%)"]) {
  assert.ok(!html.includes(hidden), `modo Simples esconde ${hidden}`);
}
assert.equal((html.match(/>Copiar<\/button>/g) ?? []).length, 1, "um só Copiar");

// Forrageira: caminho por SPV, sem espaçamento nem população; sem SPV digitado, pede e não mostra Copiar.
const forageHtml = render([card({ id: "forrageira", ...forage(), notes: "Dose fictícia de 3 kg SPV/ha." })]);
assert.match(forageHtml, /Dose de SPV desejada \(kg\/ha\)/);
assert.match(forageHtml, /Pontos de VC = SPV × 100/);
assert.match(forageHtml, /Dose fictícia de 3 kg SPV\/ha\./, "texto de SPV das observações");
assert.ok(forageHtml.includes(PROMPTS.spvDose), "pede a dose de SPV");
assert.ok(!forageHtml.includes("População (plantas/ha)"));
assert.ok(!forageHtml.includes(">outro</button>"));
assert.ok(!forageHtml.includes(">Copiar</button>"));
assert.ok(!forageHtml.includes("Já tenho a dose física"), "dose física só no Completo");
assert.ok(!forageHtml.includes("Análise do termo"), "seletor da análise só no Completo");
assert.match(forageHtml, /Germinação ou viabilidade \(%\)/, "rótulo da forrageira");
assert.match(forageHtml, /placeholder="Mínimo MAPA: 60%"/, "placeholder do mínimo MAPA continua");
assert.ok(forageHtml.includes(CONFORMITY_TERM_HINT), "dica do termo de conformidade na forrageira");
assert.ok(forageHtml.includes(FORAGE_VC_FORMULA), "VC = pureza × germinação ou viabilidade");
assert.ok(forageHtml.includes(FORAGE_VIABILITY_NOTE), "nota da IN 30/2008");
assert.match(forageHtml, /Germinação ou viabilidade 60%/, "linha do resultado com o termo da forrageira");

// Não forrageira: rótulo "Germinação (%)", mesma dica, sem viabilidade.
assert.match(html, />Germinação \(%\)<input/, "rótulo da não forrageira");
assert.match(html, /placeholder="Mínimo MAPA: 80%"/);
assert.ok(html.includes(CONFORMITY_TERM_HINT), "dica do termo de conformidade");
assert.ok(!html.includes(FORAGE_VIABILITY_NOTE));
assert.ok(!html.includes("Germinação ou viabilidade"));

// Sem conexão: aviso de fonte e germinação pedida.
const offlineHtml = render([card()], true);
assert.match(offlineHtml, /Lista reduzida, sem conexão/);
assert.ok(offlineHtml.includes(PROMPTS.germination), "sem conexão, pede a germinação");
assert.equal(render([]), "", "sem culturas, sem cartão");

// Modo Completo lembrado no aparelho: campos do lote aparecem; sementes duras só em leguminosa e forrageira.
const stored = new Map<string, string>([["technical_assistant_seeding_mode", "complete"]]);
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
};
assert.equal(readStoredMode(), "complete");
const completeHtml = render([card()]);
assert.match(completeHtml, /aria-pressed="true"[^>]*>Completo<\/button>/);
for (const field of ["Pureza (%)", "PMS (g)", "Perda a campo (%)"]) assert.ok(completeHtml.includes(field), `Completo mostra ${field}`);
assert.ok(!completeHtml.includes("Sementes duras (%)"), "grãos sem sementes duras");
assert.ok(render([card({ category: "Leguminosas" })]).includes("Sementes duras (%)"), "leguminosa com sementes duras");
const forageCompleteHtml = render([card({ id: "forrageira", ...forage() })]);
assert.ok(forageCompleteHtml.includes("Já tenho a dose física"), "dose física no Completo da forrageira");
assert.ok(forageCompleteHtml.includes("Sementes duras (%)"), "Germinação (padrão): campo de sementes duras");
assert.match(forageCompleteHtml, /Análise do termo/);
assert.match(forageCompleteHtml, /aria-pressed="true"[^>]*>Germinação<\/button>/, "começa em Germinação");
assert.match(forageCompleteHtml, /aria-pressed="false"[^>]*>Viabilidade \(tetrazólio\)<\/button>/);
assert.ok(!completeHtml.includes("Análise do termo"), "grãos sem seletor da análise");
assert.ok(!render([card({ category: "Leguminosas" })]).includes("Análise do termo"), "leguminosa sem seletor da análise");
assert.ok(!forageCompleteHtml.includes("PMS (g)"), "forrageira sem PMS");
delete (globalThis as { localStorage?: unknown }).localStorage;

// ---- Celular e computador ----
const source = readFileSync(new URL("../src/components/technical/SeedingRecommendation.tsx", import.meta.url), "utf8");
assert.doesNotMatch(source, /w-\[\d+px\]|min-w-\[\d+px\]/, "sem largura fixa em px");
assert.match(source, /min-h-11/, "botões com pelo menos 44 px de altura");
assert.match(source, /grid grid-cols-1 gap-6 lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,380px\)\]/, "uma coluna no celular, resultado ao lado no computador");
assert.match(source, /lg:sticky lg:top-4 lg:self-start/, "resultado fixo ao rolar no computador");
assert.match(source, /inputMode: "decimal"/, "teclado numérico no celular");
assert.match(source, /aria-expanded=\{guidanceOpen\}/, "orientações recolhíveis no celular");
assert.match(source, /hardSeedsVisible = complete && hardSeedsApply\(culture, form\)/, "com Viabilidade o campo de sementes duras some");

console.log("seedingRecommendation.test.ts: ok");
