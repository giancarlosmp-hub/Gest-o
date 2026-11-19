import assert from "node:assert/strict";
import {
  MAX_FIELD_LOSS_PERCENT,
  calculateSeeding,
  calculateVc,
  checkKgHaRange,
  cultureGoalOptions,
  cultureSeedingDefaults,
  fieldLossWarningMessage,
  kgHaRangeMessage,
  parseDecimal,
  resolveKgHaRange,
  seedingSummaryText,
} from "../src/lib/technicalAssistant";

// Contas do Assistente Técnico (src/lib/technicalAssistant.ts). Só culturas e lotes fictícios.
const close = (actual: number, expected: number, message: string, tolerance = 0.005) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: esperado ${expected}, veio ${actual}`);

// ---- Leitura de números ----
assert.equal(parseDecimal("12,5"), 12.5);
assert.equal(parseDecimal(" 98 "), 98);
assert.equal(parseDecimal(""), null);
assert.equal(parseDecimal("abc"), null);
assert.equal(parseDecimal("12.5"), 12.5, "ponto decimal continua valendo");
assert.equal(parseDecimal("180.000"), 180000, "ponto de milhar (3 dígitos depois do ponto)");
assert.equal(parseDecimal("1.234,5"), 1234.5, "milhar com vírgula decimal");
assert.equal(parseDecimal("1.250.000"), 1250000);
assert.equal(parseDecimal("0,85"), 0.85);

// ---- Padrões da cultura: trocar de cultura substitui todos os campos, inclusive os já preenchidos ----
const cultureA = { populationTargetDefault: 100000, rowSpacingCmDefault: 40, pmsDefault: 20, germinationDefault: 85, purityDefault: 97 };
const cultureB = { populationTargetDefault: 300000, rowSpacingCmDefault: null, pmsDefault: 150, germinationDefault: null, purityDefault: 99 };
assert.deepEqual(cultureSeedingDefaults(cultureA), { populacaoHa: "100000", espacamentoCm: "40", pms: "20", germinacao: "85", pureza: "97" });
assert.deepEqual(
  { ...cultureSeedingDefaults(cultureA), ...cultureSeedingDefaults(cultureB) },
  { populacaoHa: "300000", espacamentoCm: "", pms: "150", germinacao: "", pureza: "99" },
  "campo sem padrão na cultura nova fica vazio, não com o valor da anterior"
);

// ---- Semeadura ----
// Lote fictício: 200.000 plantas/ha, 50 cm, PMS 25 g, germinação 80%, pureza 100%, sem perda.
// Sementes/ha = 200.000 ÷ 0,8 = 250.000 → kg/ha = 250.000 × 25 ÷ 1.000.000 = 6,25.
const base = { populationHa: 200000, rowSpacingCm: 50, pms: 25, germination: 80, purity: 100, fieldLossPercent: 0 };
const seeding = calculateSeeding(base);
assert.equal(seeding.ready, true);
close(seeding.plantsM2, 20, "plantas/m²");
close(seeding.seedsM2, 25, "sementes/m²");
close(seeding.seedsPerMeter, 12.5, "sementes por metro (25/m² × 0,5 m)");
close(seeding.kgHa, 6.25, "kg/ha");
close(seeding.kgHaBase, 6.25, "kg/ha base sem correção");

assert.equal(seeding.fieldLossApplied, 0);
assert.equal(seeding.fieldLossWarning, null);

// Perda a campo divide por (1 − perda): 20% → 6,25 ÷ 0,8 = 7,8125 (25% a mais, não 20%).
const withLoss = calculateSeeding({ ...base, fieldLossPercent: 20 });
close(withLoss.kgHa, 7.8125, "kg/ha com 20% de perda");
close(withLoss.kgHaBase, 6.25, "kg/ha sem perda continua o mesmo");
close(withLoss.seedsM2, 31.25, "sementes/m² com perda");
assert.equal(withLoss.fieldLossApplied, 20);

// Limite de 50%: acima disso a conta usa 50% e avisa.
assert.equal(MAX_FIELD_LOSS_PERCENT, 50);
const atMax = calculateSeeding({ ...base, fieldLossPercent: 50 });
close(atMax.kgHa, 12.5, "50% de perda dobra a dose");
assert.equal(atMax.fieldLossWarning, null, "50% exato não avisa");
const overMax = calculateSeeding({ ...base, fieldLossPercent: 80 });
close(overMax.kgHa, 12.5, "acima de 50% usa 50%");
assert.equal(overMax.fieldLossApplied, 50);
assert.equal(overMax.fieldLossWarning, "above_max");
assert.equal(fieldLossWarningMessage("above_max"), "Perda a campo acima de 50%: a conta usa 50%. Confira o valor.");
const negative = calculateSeeding({ ...base, fieldLossPercent: -10 });
close(negative.kgHa, 6.25, "perda negativa usa 0%");
assert.equal(negative.fieldLossWarning, "negative");
assert.equal(fieldLossWarningMessage("negative"), "Perda a campo não pode ser negativa: a conta usa 0%.");
assert.equal(fieldLossWarningMessage(null), null);

// Espaçamento muda só sementes por metro, não o kg/ha.
const wider = calculateSeeding({ ...base, rowSpacingCm: 100 });
close(wider.kgHa, 6.25, "kg/ha não depende do espaçamento");
close(wider.seedsPerMeter, 25, "sementes por metro dobram com o dobro do espaçamento");

// Campos obrigatórios zerados → sem resultado.
for (const field of ["populationHa", "rowSpacingCm", "pms", "germination", "purity"] as const) {
  const result = calculateSeeding({ ...base, [field]: 0 });
  assert.equal(result.ready, false, `${field} = 0 não calcula`);
  assert.equal(result.kgHa, 0, `${field} = 0 dá kg/ha 0`);
}

// ---- Valor Cultural ----
const vcBase = { purity: 80, germination: 50, hardSeeds: null, considerHardSeeds: false, physicalDose: null, spvDose: null, lastEditedDose: null } as const;
const vc = calculateVc(vcBase);
assert.equal(vc.ready, true);
close(vc.vc, 40, "VC = 80 × 50 ÷ 100");
close(vc.correctionFactor, 2.5, "fator = 100 ÷ 40");

const vcHard = calculateVc({ ...vcBase, hardSeeds: 20, considerHardSeeds: true });
close(vcHard.effectiveGermination, 70, "germinação + duras");
close(vcHard.vc, 56, "VC com duras = 80 × 70 ÷ 100");
close(calculateVc({ ...vcBase, germination: 90, hardSeeds: 30, considerHardSeeds: true }).effectiveGermination, 100, "germinação + duras limitada a 100");
close(calculateVc({ ...vcBase, hardSeeds: 20, considerHardSeeds: false }).vc, 40, "duras ignoradas se a caixa não estiver marcada");

const fromPhysical = calculateVc({ ...vcBase, physicalDose: 10, lastEditedDose: "fisica" });
close(fromPhysical.spvDose ?? -1, 4, "SPV = 10 kg × 40%");
assert.equal(fromPhysical.physicalDoseNeeded, null);

const fromSpv = calculateVc({ ...vcBase, spvDose: 4, lastEditedDose: "spv" });
close(fromSpv.physicalDoseNeeded ?? -1, 10, "física = 4 kg SPV ÷ 40%");
assert.equal(fromSpv.spvDose, null);

// As duas doses preenchidas: vale a última editada.
const bothSpv = calculateVc({ ...vcBase, physicalDose: 99, spvDose: 4, lastEditedDose: "spv" });
assert.equal(bothSpv.spvDose, null);
close(bothSpv.physicalDoseNeeded ?? -1, 10, "última editada = SPV");
const bothPhysical = calculateVc({ ...vcBase, physicalDose: 10, spvDose: 99, lastEditedDose: "fisica" });
close(bothPhysical.spvDose ?? -1, 4, "última editada = física");
assert.equal(bothPhysical.physicalDoseNeeded, null);

assert.equal(calculateVc({ ...vcBase, purity: null }).ready, false, "sem pureza não calcula");
assert.deepEqual(calculateVc({ ...vcBase, purity: 120 }).errors, ["Pureza deve estar entre 0 e 100%."]);
assert.deepEqual(calculateVc({ ...vcBase, physicalDose: -1 }).errors, ["As doses devem ser valores iguais ou maiores que zero."]);
assert.equal(calculateVc({ ...vcBase, purity: 0 }).physicalDoseNeeded, null, "VC 0 não converte dose");

// ---- Aviso de faixa ----
const range = { min: 8, max: 18 };
assert.deepEqual(checkKgHaRange(6.05, range), { status: "below", range });
assert.deepEqual(checkKgHaRange(8, range), { status: "within", range }, "limite mínimo conta como dentro");
assert.deepEqual(checkKgHaRange(18, range), { status: "within", range }, "limite máximo conta como dentro");
assert.deepEqual(checkKgHaRange(7.996, range), { status: "within", range }, "compara o valor mostrado (8,00)");
assert.deepEqual(checkKgHaRange(18.01, range), { status: "above", range });
assert.equal(checkKgHaRange(null, range), null, "sem resultado não avisa");
assert.equal(checkKgHaRange(0, range), null, "kg/ha 0 (campos faltando) não avisa");
assert.deepEqual(checkKgHaRange(6, null), { status: "no_range" });
assert.deepEqual(checkKgHaRange(null, null), { status: "no_range" }, "sem faixa avisa mesmo sem resultado");

assert.equal(
  kgHaRangeMessage({ status: "below", range }),
  "Abaixo da faixa de referência (8–18 kg/ha). Confira PMS, população e perda a campo."
);
assert.equal(
  kgHaRangeMessage({ status: "above", range: { min: 2.5, max: 4 } }),
  "Acima da faixa de referência (2,5–4 kg/ha). Confira PMS, população e perda a campo."
);
assert.equal(kgHaRangeMessage({ status: "no_range" }), "Sem faixa de referência cadastrada para esta cultura.");
assert.ok(!kgHaRangeMessage({ status: "no_range" }).includes("Configurações"), "texto do vendedor não manda ajustar Configurações");

// ---- Objetivos (goalsJson) ----
const fakeCulture = {
  defaultKgHaMin: 8,
  defaultKgHaMax: 18,
  goalsJson: { grao: { min: 8, max: 12 }, silagem: { min: 12, max: 18 }, adubacao_verde: { min: 20, max: 30 }, quebrado: { min: 5, max: 2 } },
};
assert.deepEqual(
  cultureGoalOptions(fakeCulture.goalsJson).map((option) => `${option.key}:${option.label}`),
  ["grao:Grão", "silagem:Silagem", "adubacao_verde:Adubacao verde"],
  "faixa inválida (máx < mín) fica de fora; chave desconhecida vira texto"
);
assert.deepEqual(cultureGoalOptions({}), []);
assert.deepEqual(cultureGoalOptions(null), []);
assert.deepEqual(resolveKgHaRange(fakeCulture, ""), { min: 8, max: 18 }, "sem objetivo usa a faixa geral");
assert.deepEqual(resolveKgHaRange(fakeCulture, "grao"), { min: 8, max: 12 }, "objetivo troca a faixa");
assert.deepEqual(resolveKgHaRange(fakeCulture, "inexistente"), { min: 8, max: 18 });
assert.equal(resolveKgHaRange({ defaultKgHaMin: null, defaultKgHaMax: 10, goalsJson: {} }, ""), null, "faixa incompleta = sem faixa");
assert.deepEqual(checkKgHaRange(10, resolveKgHaRange(fakeCulture, "silagem")), { status: "below", range: { min: 12, max: 18 } });

// ---- Texto do "Copiar resultado" ----
const summary = seedingSummaryText({
  cultureLabel: "Cultura Teste",
  goalLabel: "Grão",
  input: { ...base, fieldLossPercent: 20 },
  result: withLoss,
  range: { min: 6, max: 9 },
});
assert.equal(
  summary,
  [
    "Cultura Teste (Grão): 7,81 kg/ha",
    "População 200.000 plantas/ha, espaçamento 50 cm, PMS 25 g, germinação 80%, pureza 100%, perda a campo 20%.",
    "15,6 sementes por metro.",
    "Faixa de referência: 6–9 kg/ha.",
    "Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.",
  ].join("\n")
);
assert.equal(
  seedingSummaryText({ cultureLabel: "Cultura Teste", input: base, result: calculateSeeding({ ...base, pms: 0 }), range: null }),
  "",
  "sem resultado não há o que copiar"
);
assert.ok(
  !seedingSummaryText({ cultureLabel: "Cultura Teste", input: base, result: seeding, range: null }).includes("Faixa"),
  "sem faixa, o texto não inventa uma"
);

console.log("technicalAssistant.test.ts: ok");
