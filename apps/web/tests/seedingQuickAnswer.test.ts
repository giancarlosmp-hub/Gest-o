import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SeedingQuickAnswer from "../src/components/technical/SeedingQuickAnswer";
import {
  QUICK_KG_HA_NO_PMS,
  QUICK_KG_HA_OFFLINE,
  QUICK_MAPA_GERMINATION_WARNING,
  QUICK_ORIGIN_LABEL,
  QUICK_PROMPTS,
  QUICK_SPACING_OPTIONS_CM,
  isQuickAnswerCulture,
  quickAnswerText,
  quickSeedingAnswer,
  whatsappShareUrl,
} from "../src/lib/seedingQuickAnswer";
import type { TechnicalCulture } from "../src/lib/technicalCultures";

// "Resposta rápida" do Assistente Técnico. Só culturas e lotes fictícios.
const close = (actual: number | null, expected: number, message: string, tolerance = 0.005) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${message}: esperado ${expected}, veio ${actual}`);

const culture = (overrides: Partial<TechnicalCulture> = {}): TechnicalCulture => ({
  id: "cultura-teste",
  slug: "cultura-teste",
  label: "Cultura Teste",
  category: "Grãos",
  isActive: true,
  defaultKgHaMin: null,
  defaultKgHaMax: null,
  notes: null,
  pmsDefault: null,
  germinationDefault: 75,
  purityDefault: 98,
  populationTargetDefault: 155000,
  rowSpacingCmDefault: 50,
  goalsJson: {},
  tags: [],
  ...overrides,
});

const emptyForm = { populacaoHa: "", germinacao: "", perdaCampo: "0", espacamentoCm: "45" };
const online = { offline: false };

assert.deepEqual([...QUICK_SPACING_OPTIONS_CM], [45, 50, 70, 90]);

// ---- Sem germinação digitada: mínimo legal do MAPA do Catálogo Técnico, com aviso ----
// 155.000 ÷ 0,75 = 206.667 sementes/ha → 20,667/m² × 0,45 = 9,30 sementes/m → ≈ 93 a cada 10 m.
const mapa = quickSeedingAnswer(culture(), emptyForm, online);
assert.equal(mapa.ready, true);
assert.deepEqual(mapa.prompts, []);
close(mapa.seedsPerMeter, 9.3, "sementes por metro com o mínimo do MAPA");
assert.equal(mapa.seedsPer10m, 93);
assert.equal(mapa.populationOrigin, "culture_default");
assert.equal(mapa.germinationOrigin, "mapa_minimum");
assert.equal(QUICK_ORIGIN_LABEL.mapa_minimum, "mínimo legal do MAPA (Catálogo Técnico)");
assert.equal(
  mapa.germinationWarning,
  "Estimativa segura com a germinação mínima legal; com o lote faturado, geralmente será um pouco menos."
);
// Sem PMS: kg/ha não aparece e diz por quê.
assert.equal(mapa.kgHa, null);
assert.equal(mapa.kgHaUnavailableReason, QUICK_KG_HA_NO_PMS);
assert.match(QUICK_KG_HA_NO_PMS, /PMS varia por lote e peneira/);

// ---- Germinação e população digitadas: origem "digitado por você", sem aviso ----
const typed = quickSeedingAnswer(culture(), { ...emptyForm, populacaoHa: "200.000", germinacao: "80" }, online);
// 200.000 ÷ 0,8 = 250.000 → 25/m² × 0,45 = 11,25.
close(typed.seedsPerMeter, 11.25, "sementes por metro com valores digitados");
assert.equal(typed.seedsPer10m, 113, "11,25 × 10 = 112,5 → 113");
assert.equal(typed.populationOrigin, "typed");
assert.equal(typed.germinationOrigin, "typed");
assert.equal(typed.germinationWarning, null);

// Perda a campo divide por (1 − perda): 9,30 ÷ 0,9 = 10,33.
const withLoss = quickSeedingAnswer(culture(), { ...emptyForm, perdaCampo: "10" }, online);
close(withLoss.seedsPerMeter, 10.3333, "sementes por metro com 10% de perda");
assert.equal(withLoss.fieldLossApplied, 10);

// ---- Cultura sem germinação padrão (ex.: sem mínimo do MAPA): pede e não calcula ----
const noGermination = quickSeedingAnswer(culture({ germinationDefault: null }), emptyForm, online);
assert.equal(noGermination.ready, false);
assert.equal(noGermination.seedsPerMeter, null);
assert.deepEqual(noGermination.prompts, ["Informe a germinação do lote."]);
assert.equal(quickAnswerText("Cultura Teste", noGermination), "", "sem resultado, nada para copiar");
const afterTyping = quickSeedingAnswer(culture({ germinationDefault: null }), { ...emptyForm, germinacao: "70" }, online);
assert.equal(afterTyping.ready, true, "calcula assim que a germinação é digitada");
assert.equal(afterTyping.germinationOrigin, "typed");

// Germinação acima de 100: pede valor válido.
assert.deepEqual(quickSeedingAnswer(culture(), { ...emptyForm, germinacao: "120" }, online).prompts, [QUICK_PROMPTS.germinationRange]);

// Sem espaçamento e sem população padrão: pede os dois.
assert.deepEqual(
  quickSeedingAnswer(culture({ populationTargetDefault: null }), { ...emptyForm, espacamentoCm: "" }, online).prompts,
  [QUICK_PROMPTS.population, QUICK_PROMPTS.spacing]
);

// "outro" espaçamento aceita vírgula.
close(quickSeedingAnswer(culture(), { ...emptyForm, espacamentoCm: "22,5" }, online).seedsPerMeter, 4.65, "espaçamento 22,5 cm");

// ---- Com PMS padrão: kg/ha aparece com PMS e pureza da cultura ----
// 155.000 ÷ (0,75 × 0,98) × 30 ÷ 1.000.000 = 6,33 kg/ha.
const withPms = quickSeedingAnswer(culture({ pmsDefault: 30 }), emptyForm, online);
close(withPms.kgHa, 6.3265, "kg/ha com PMS padrão");
assert.equal(withPms.kgHaUnavailableReason, null);
assert.equal(withPms.pmsOrigin, "culture_default");
assert.equal(withPms.purityOrigin, "mapa_minimum");

// ---- Sem conexão (lista reduzida): germinação pedida, kg/ha nunca aparece ----
const offline = quickSeedingAnswer(culture({ pmsDefault: 30 }), emptyForm, { offline: true });
assert.deepEqual(offline.prompts, ["Informe a germinação do lote."], "lista reduzida não é mínimo do MAPA");
const offlineTyped = quickSeedingAnswer(culture({ pmsDefault: 30 }), { ...emptyForm, germinacao: "80" }, { offline: true });
assert.equal(offlineTyped.ready, true);
assert.equal(offlineTyped.populationOrigin, "offline_list");
assert.equal(offlineTyped.kgHa, null);
assert.equal(offlineTyped.kgHaUnavailableReason, QUICK_KG_HA_OFFLINE);

// ---- Forrageiras ficam fora (semeadura por SPV) ----
assert.equal(isQuickAnswerCulture(culture({ category: "Forrageiras" })), false);
assert.equal(isQuickAnswerCulture(culture()), true);

// ---- Texto do Copiar e do WhatsApp ----
assert.equal(
  quickAnswerText("Cultura Teste", mapa),
  [
    "Cultura Teste: 9,3 sementes por metro (≈ 93 a cada 10 m)",
    "Espaçamento 45 cm, população 155.000 plantas/ha, germinação 75% (mínimo legal do MAPA), perda a campo 0%.",
    QUICK_MAPA_GERMINATION_WARNING,
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.equal(
  quickAnswerText("Cultura Teste", typed),
  [
    "Cultura Teste: 11,3 sementes por metro (≈ 113 a cada 10 m)",
    "Espaçamento 45 cm, população 200.000 plantas/ha, germinação 80%, perda a campo 0%.",
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.match(quickAnswerText("Cultura Teste", withPms), /Cerca de 6,33 kg\/ha com PMS 30 g e pureza 98% \(padrões da cultura\)\./);

// Link do WhatsApp sem número, texto codificado.
assert.equal(whatsappShareUrl("9,3 sementes & mais"), "https://wa.me/?text=9%2C3%20sementes%20%26%20mais");
assert.ok(!whatsappShareUrl(quickAnswerText("Cultura Teste", mapa)).includes("\n"), "quebra de linha codificada");

// ---- Tela (render no servidor) ----
const forage = culture({ id: "forrageira", label: "Forrageira Teste", category: "Forrageiras" });
const html = renderToStaticMarkup(createElement(SeedingQuickAnswer, { cultures: [forage, culture()], offline: false }));
assert.match(html, /Resposta rápida: sementes por metro/);
assert.ok(!html.includes("Forrageira Teste"), "forrageira fora da lista");
// Espaçamento padrão da cultura (50 cm): 20,667/m² × 0,5 = 10,3 sementes por metro, ≈ 103 a cada 10 m.
assert.match(html, />10,3<\/p>/, "resultado em destaque");
assert.match(html, /≈ 103 a cada 10 m/);
for (const option of ["45", "50", "70", "90", "outro"]) assert.match(html, new RegExp(`>${option}</button>`));
assert.match(html, /aria-pressed="true"[^>]*>50<\/button>/, "começa no espaçamento padrão da cultura");
assert.match(html, /mínimo legal do MAPA \(Catálogo Técnico\)/);
assert.match(html, /Copiar/);
assert.match(html, /WhatsApp/);
assert.equal(renderToStaticMarkup(createElement(SeedingQuickAnswer, { cultures: [forage], offline: false })), "", "só forrageiras: sem cartão");

// ---- Celular: sem largura fixa, botões com altura de toque ----
const source = readFileSync(new URL("../src/components/technical/SeedingQuickAnswer.tsx", import.meta.url), "utf8");
assert.doesNotMatch(source, /\bw-\[\d+px\]|min-w-\[\d+px\]/, "sem largura fixa em px");
assert.match(source, /min-h-11/, "botões com pelo menos 44 px de altura");
assert.match(source, /grid-cols-1 gap-4 sm:grid-cols-2/, "uma coluna no celular");
assert.match(source, /inputMode: "decimal"/, "teclado numérico no celular");

console.log("seedingQuickAnswer.test.ts: ok");
