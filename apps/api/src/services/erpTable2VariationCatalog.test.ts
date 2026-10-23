import assert from "node:assert/strict";
import { prisma } from "../config/prisma.js";
import { calculatePriceFromErpVariation, classifyErpPriceVariationRule, resolveErpPriceVariationPercent, resolveVariationBasePrice } from "./erpPriceVariationPolicy.js";
import { calculateOpportunityPriceForTable } from "./opportunityPriceService.js";
import { reconcileCalculatedVariationPrices } from "./ultraFv3SyncService.js";

// Tabela 2 = variação por grupo sobre a Tabela 1. Dados fictícios; Prisma simulado. Hoje = 2026-10-23 (Brasília).
type Row = Record<string, any>;

const RealDate = Date;
const NOW = RealDate.parse("2026-10-23T15:00:00.000Z");
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length) super(...(args as [any]));
    else super(NOW);
  }
  static now() { return NOW; }
}
globalThis.Date = FixedDate as DateConstructor;

// Regra no formato do /priceVariations: prazo médio 999 = sem restrição de prazo; campos de contexto nulos.
const rule = (group: string, percent: number, extra: Row = {}): Row => ({
  TABELA: 2, CODGRUPO: group, PER_VARIACAO: percent, PRAZO_MEDIO: 999, ACRESCIMO_PESO: 0, OPERADOR: 2,
  PRODUTO: null, PRODUTO_CLAS: null, MARCA: null, PARCEIRO: null, FORMA: null, GRUPO_FISCAL: null, CODCONDREC: null,
  CODFILIAL: null, CODCIDADE: null, UF: null, DTA_VIGENCIA_INI: null, DTA_VIGENCIA_FIN: null, ...extra,
});
const rules = [
  rule("13", 25), rule("14", 25), rule("26", 25), rule("24", 25, { ACRESCIMO_PESO: null }), rule("27", 20),
  rule("29", 20, { DTA_VIGENCIA_INI: "2026-02-24", DTA_VIGENCIA_FIN: "2029-02-28" }),
];

const results: string[] = [];
try {
  // 1. Regra de catálogo: prazo médio 999 aplica; prazo 30 não; produto, filial ou UF preenchidos não; vigência fora não.
  assert.equal(resolveErpPriceVariationPercent(rules, "2", "24"), 25, "PRAZO_MEDIO 999, ACRESCIMO_PESO nulo e OPERADOR 2 não descartam");
  assert.equal(resolveErpPriceVariationPercent(rules, "2", "13"), 25, "ACRESCIMO_PESO 0 não descarta");
  for (const group of ["13", "14", "24", "26"]) assert.equal(resolveErpPriceVariationPercent(rules, "2", group), 25, `grupo ${group} = 25%`);
  for (const group of ["27", "29"]) assert.equal(resolveErpPriceVariationPercent(rules, "2", group), 20, `grupo ${group} = 20%`);
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { PRAZO_MEDIO: null })], "2", "24"), 25, "prazo médio vazio = sem restrição");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { PRAZO_MEDIO: 0 })], "2", "24"), 25, "prazo médio 0 = sem restrição");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { PRAZO_MEDIO: 30 })], "2", "24"), null, "prazo médio 30 só vale no pedido, não no catálogo");
  assert.equal(classifyErpPriceVariationRule(rule("24", 25, { PRAZO_MEDIO: 30 })), "payment_term");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { PRODUTO: 777 })], "2", "24"), null, "regra de outro produto fica fora");
  for (const key of ["CODFILIAL", "PARCEIRO", "CODCIDADE", "UF", "FORMA", "MARCA"]) {
    assert.equal(classifyErpPriceVariationRule(rule("24", 25, { [key]: "X1" })), "restricted", `${key} preenchido continua fora do catálogo`);
  }
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { DTA_VIGENCIA_INI: "2026-11-01" })], "2", "24"), null, "vigência futura não aplica");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { DTA_VIGENCIA_FIN: "2026-10-22" })], "2", "24"), null, "vigência vencida não aplica");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { DTA_VIGENCIA_FIN: "2026-10-23" })], "2", "24"), 25, "último dia da vigência ainda vale");
  assert.equal(resolveErpPriceVariationPercent([rule("24", 25, { DTA_VIGENCIA_INI: "24/02/2026", DTA_VIGENCIA_FIN: "28/02/2029" })], "2", "24"), 25, "datas dd/mm/aaaa");
  assert.equal(classifyErpPriceVariationRule(rule("24", 25, { DTA_VIGENCIA_FIN: "sem data" })), "invalid", "data ilegível falha fechada");
  assert.equal(calculatePriceFromErpVariation(128, 25), 160);
  assert.equal(calculatePriceFromErpVariation(296, 25), 370);
  assert.equal(calculatePriceFromErpVariation(100, 20), 120);
  results.push("catalog_rule=PASS");

  // 2. Base: Tabela 1 sem filial, sem legacy, com a precedência da busca; duplicatas e linha de filial não confundem.
  const at = (iso: string) => new Date(iso);
  const duplicated: Row[] = [
    { erpPriceId: null, branchCode: null, source: "legacy", availabilityState: "available", price: 999 },
    { erpPriceId: null, branchCode: null, source: "legacy", availabilityState: "available", price: 0 },
    { erpPriceId: null, branchCode: "1", source: "legacy", availabilityState: "available", price: 700 },
    { erpPriceId: null, branchCode: "1", source: "prices", availabilityState: "available", price: 700, validFrom: at("2022-08-26T00:00:00Z"), sourceChangedAt: at("2022-08-26T16:00:00Z") },
    { erpPriceId: null, branchCode: null, source: "prices", availabilityState: "available", price: 128, validFrom: at("2026-09-30T00:00:00Z"), sourceChangedAt: at("2026-09-30T12:00:00Z") },
    { erpPriceId: null, branchCode: null, source: "prices", availabilityState: "available", price: 120, validFrom: at("2026-09-24T00:00:00Z"), sourceChangedAt: at("2026-09-24T19:00:00Z") },
    { erpPriceId: null, branchCode: null, source: "prices", availabilityState: "available", price: 110 },
    { erpPriceId: "1", branchCode: null, source: "legacy", availabilityState: "available", price: 0 },
    { erpPriceId: "1", branchCode: null, source: "products", availabilityState: "available", price: 128 },
  ];
  assert.equal(resolveVariationBasePrice(duplicated as any), 128, "explícito da Tabela 1 (catálogo) como na busca; legacy e filial ignorados");
  const structuralZero: Row[] = [
    { erpPriceId: "1", branchCode: null, source: "products", availabilityState: "explicit_zero", price: 0 },
    ...duplicated.filter((row) => row.erpPriceId === null),
  ];
  assert.equal(resolveVariationBasePrice(structuralZero as any), 128, "zero estrutural do catálogo cai para o /prices sem tabela mais recente");
  assert.equal(resolveVariationBasePrice(duplicated.filter((row) => row.source === "legacy" || row.branchCode) as any), 0, "só legacy e filial: sem base");
  const explicitZero: Row[] = [
    ...duplicated,
    { erpPriceId: null, branchCode: null, source: "prices", availabilityState: "explicit_zero", price: 0, validFrom: at("2026-10-20T00:00:00Z"), sourceChangedAt: at("2026-10-20T10:00:00Z") },
  ];
  assert.equal(resolveVariationBasePrice(explicitZero as any), 0, "zero explícito mais novo de /prices bloqueia");
  results.push("base_selection=PASS");

  // 3. Reconciliação: a linha "absent" volta a "available" com o preço derivado; base zerada não ganha Tabela 2.
  const products: Row[] = [
    { id: "prod-a", erpProductCode: "9001", erpProductClassCode: "1", isActive: true, rawErpPayload: { CODGRUPO: "24" }, prices: [
      ...duplicated.map((row, index) => ({ id: `a-${index}`, productId: "prod-a", validFrom: null, sourceChangedAt: null, erpSourcePriceId: null, ...row })),
      { id: "a-derived", productId: "prod-a", erpPriceId: "2", branchCode: null, source: "calculated_from_variation", availabilityState: "absent", price: 0, validFrom: null, sourceChangedAt: null },
    ] },
    { id: "prod-b", erpProductCode: "9002", erpProductClassCode: "1", isActive: true, rawErpPayload: { CODGRUPO: "29" }, prices: [
      { id: "b-0", productId: "prod-b", erpPriceId: null, branchCode: null, source: "prices", availabilityState: "available", price: 100, validFrom: at("2026-09-30T00:00:00Z"), sourceChangedAt: null },
    ] },
    { id: "prod-zero", erpProductCode: "9003", erpProductClassCode: "1", isActive: true, rawErpPayload: { CODGRUPO: "24" }, prices: [
      { id: "z-0", productId: "prod-zero", erpPriceId: "1", branchCode: null, source: "products", availabilityState: "explicit_zero", price: 0, validFrom: null, sourceChangedAt: null },
      { id: "z-1", productId: "prod-zero", erpPriceId: null, branchCode: null, source: "prices", availabilityState: "explicit_zero", price: 0, validFrom: at("2026-10-01T00:00:00Z"), sourceChangedAt: null },
      { id: "z-derived", productId: "prod-zero", erpPriceId: "2", branchCode: null, source: "calculated_from_variation", availabilityState: "absent", price: 0, validFrom: null, sourceChangedAt: null },
    ] },
  ];
  const updates: Row[] = [];
  const creates: Row[] = [];
  const config: Record<string, string> = {
    "erp.ultrafv3.priceTables": JSON.stringify([{ CODTABELA: 1 }, { CODTABELA: 2 }]),
    "erp.ultrafv3.priceVariations": JSON.stringify(rules),
  };
  Object.assign((prisma as any).appConfig, { findUnique: async ({ where }: any) => (config[where.key] ? { key: where.key, value: config[where.key] } : null) });
  Object.assign((prisma as any).product, { findMany: async () => products });
  Object.assign((prisma as any).productPrice, {
    update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); return { id: where.id, ...data }; },
    create: async ({ data }: any) => { creates.push(data); return { id: `new-${creates.length}`, ...data }; },
  });
  const diagnostics = await reconcileCalculatedVariationPrices("correlacao-ficticia");
  assert.deepEqual(updates.find((row) => row.id === "a-derived"), { id: "a-derived", price: 160, availabilityState: "available" }, "absent volta a available a 128 + 25%");
  assert.deepEqual(creates.map((row) => [row.productId, row.erpPriceId, row.price, row.source, row.availabilityState]), [["prod-b", "2", 120, "calculated_from_variation", "available"]], "grupo 29 a 20% cria a linha derivada");
  assert(!updates.some((row) => row.id === "z-derived"), "base zerada não ganha preço na Tabela 2");
  assert.equal(diagnostics.derivedVariationPricesRestored, 1);
  assert.equal(diagnostics.variationRulesCatalog, 6);
  assert.equal(diagnostics.variationRulesPaymentTerm + diagnostics.variationRulesRestricted + diagnostics.variationRulesOutOfValidity + diagnostics.variationRulesInvalid, 0);
  results.push("reconcile_restores_absent=PASS");

  // 4. Busca: Tabela 2 mostra o derivado; produto com Tabela 1 zerada não aparece em nenhuma das duas.
  const searchA = { ...products[0], prices: products[0].prices.map((row: Row) => (row.id === "a-derived" ? { ...row, price: 160, availabilityState: "available" } : row)) };
  const table2 = calculateOpportunityPriceForTable({ product: searchA as any, priceTableCode: "2" });
  assert.equal(table2.price, 160);
  assert.equal(table2.priceTableMatched, true);
  for (const table of ["1", "2"]) assert.equal(calculateOpportunityPriceForTable({ product: products[2] as any, priceTableCode: table }).priceTableMatched, false, `produto com Tabela 1 zerada fora da Tabela ${table}`);
  results.push("search_table2=PASS");

  console.log(`ERP_TABLE2_VARIATION_CATALOG=PASS ${results.join(" ")}`);
} finally {
  globalThis.Date = RealDate;
}
