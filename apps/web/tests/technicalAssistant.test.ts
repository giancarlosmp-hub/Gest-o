import assert from "node:assert/strict";
import {
  MAX_FIELD_LOSS_PERCENT,
  calculateSeeding,
  calculateVc,
  checkKgHaRange,
  cultureGoalOptions,
  fieldLossWarningMessage,
  kgHaMissingHint,
  kgHaRangeMessage,
  parseDecimal,
  resolveKgHaRange,
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

// ---- Semeadura ----
// Lote fictício: 200.000 plantas/ha, 50 cm, PMS 25 g, germinação 80%, pureza 100%, sem perda.
// Sementes/ha = 200.000 ÷ 0,8 = 250.000 → kg/ha = 250.000 × 25 ÷ 1.000.000 = 6,25.
const base = { populationHa: 200000, rowSpacingCm: 50, pms: 25, germination: 80, purity: 100, fieldLossPercent: 0 };
const seeding = calculateSeeding(base);
assert.equal(seeding.ready, true);
close(seeding.plantsM2, 20, "plantas/m²");
close(seeding.seedsM2, 25, "sementes/m²");
close(seeding.seedsPerMeter ?? -1, 12.5, "sementes por metro (25/m² × 0,5 m)");
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
close(wider.seedsPerMeter ?? -1, 25, "sementes por metro dobram com o dobro do espaçamento");

// Sem espaçamento: o kg/ha sai igual, só sementes por metro fica sem valor.
const noSpacing = calculateSeeding({ ...base, rowSpacingCm: 0 });
assert.equal(noSpacing.ready, true, "espaçamento vazio não trava a conta");
close(noSpacing.kgHa, 6.25, "kg/ha sem espaçamento");
close(noSpacing.seedsM2, 25, "sementes/m² sem espaçamento");
assert.equal(noSpacing.seedsPerMeter, null, "sem espaçamento não há sementes por metro");

// População ou germinação zeradas → sem resultado nenhum.
for (const field of ["populationHa", "germination"] as const) {
  const result = calculateSeeding({ ...base, [field]: 0 });
  assert.equal(result.ready, false, `${field} = 0 não calcula kg/ha`);
  assert.equal(result.seedsReady, false, `${field} = 0 não calcula sementes`);
  assert.equal(result.kgHa, 0, `${field} = 0 dá kg/ha 0`);
  assert.equal(result.seedsPerMeter, null, `${field} = 0 não mostra sementes por metro`);
  assert.equal(kgHaMissingHint(base, result), null, `${field} = 0: os pedidos dos campos já aparecem`);
}

// Pureza ou PMS vazios → sementes por m² e por metro saem (não dependem deles); kg/ha não.
for (const field of ["pms", "purity"] as const) {
  const result = calculateSeeding({ ...base, [field]: 0 });
  assert.equal(result.seedsReady, true, `${field} = 0 ainda calcula sementes`);
  close(result.seedsM2, 25, `${field} = 0: sementes/m² iguais às do lote completo`);
  close(result.seedsPerMeter ?? -1, 12.5, `${field} = 0: sementes por metro iguais às do lote completo`);
  assert.equal(result.ready, false, `${field} = 0 não calcula kg/ha`);
  assert.equal(result.kgHa, 0, `${field} = 0 dá kg/ha 0`);
}
assert.equal(kgHaMissingHint({ pms: 25, purity: 0 }, calculateSeeding({ ...base, purity: 0 })), "Informe a pureza do lote para ver o kg/ha.");
assert.equal(kgHaMissingHint({ pms: 0, purity: 100 }, calculateSeeding({ ...base, pms: 0 })), "Informe o PMS do lote para ver o kg/ha.");
assert.equal(
  kgHaMissingHint({ pms: 0, purity: 0 }, calculateSeeding({ ...base, pms: 0, purity: 0 })),
  "Informe a pureza e o PMS do lote para ver o kg/ha."
);
assert.equal(kgHaMissingHint(base, seeding), null, "com o kg/ha calculado não há pedido");

// ---- Sementes por metro sem a pureza (Embrapa: só a germinação corrige a população) ----
// Lote fictício de sorgo: 155.000 plantas/ha, germinação 75%, pureza 98%, 45 cm.
// 155.000 ÷ 0,75 = 206.667 sementes/ha → 20,667/m² × 0,45 = 9,30 sementes/m (com a pureza dava 9,49).
const sorgo = { populationHa: 155000, rowSpacingCm: 45, pms: 30, germination: 75, purity: 98, fieldLossPercent: 0 };
const sorgoResult = calculateSeeding(sorgo);
close(sorgoResult.seedsM2, 20.6667, "sorgo: sementes/m² sem a pureza");
close(sorgoResult.seedsPerMeter ?? -1, 9.3, "sorgo: 9,30 sementes por metro");
// Com 10% de perda: 9,30 ÷ 0,9 = 10,33 (com a pureza dava 10,54).
const sorgoLoss = calculateSeeding({ ...sorgo, fieldLossPercent: 10 });
close(sorgoLoss.seedsPerMeter ?? -1, 10.3333, "sorgo com 10% de perda: 10,33 sementes por metro");
// kg/ha continua com germinação × pureza: 155.000 ÷ (0,75 × 0,98) ÷ 0,9 × 30 ÷ 1.000.000 = 7,03.
close(sorgoLoss.kgHa, (155000 / (0.75 * 0.98) / 0.9) * 30 / 1000000, "sorgo: kg/ha igual ao da conta com pureza");
close(sorgoLoss.kgHa, 7.0295, "sorgo: 7,03 kg/ha");
close(sorgoLoss.kgHaBase, 6.3265, "sorgo: kg/ha sem perda");
// Lote fictício de nabo forrageiro: 500.000, germinação 65%, pureza 95%, 40 cm → 500.000 ÷ 0,65 × 0,4 ÷ 10.000 = 30,77.
const nabo = calculateSeeding({ populationHa: 500000, rowSpacingCm: 40, pms: 12, germination: 65, purity: 95, fieldLossPercent: 0 });
close(nabo.seedsPerMeter ?? -1, 30.7692, "nabo: 30,8 sementes por metro (com a pureza dava 32,4)");

// Cultura fictícia sem PMS padrão: ao digitar o PMS do lote, a conta sai e o aviso de faixa aparece.
const typedPms = calculateSeeding({ ...base, pms: parseDecimal("32,0") ?? 0 });
assert.equal(typedPms.ready, true);
close(typedPms.kgHa, 8, "200.000 ÷ 0,8 × 32 g ÷ 1.000.000");
assert.deepEqual(checkKgHaRange(typedPms.kgHa, { min: 8, max: 18 }), { status: "within", range: { min: 8, max: 18 } });
const beforeTyping = calculateSeeding({ ...base, pms: parseDecimal("") ?? 0 });
assert.equal(beforeTyping.ready, false, "antes de digitar o PMS, não calcula");
assert.equal(checkKgHaRange(beforeTyping.ready ? beforeTyping.kgHa : null, { min: 8, max: 18 }), null, "antes de digitar, sem aviso de faixa");

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

console.log("technicalAssistant.test.ts: ok");
