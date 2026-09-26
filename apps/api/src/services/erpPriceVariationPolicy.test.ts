import assert from "node:assert/strict";
import { calculatePriceFromErpVariation, orderPriceAuthoritySteps, resolveErpPriceVariationPercent, shouldSweepAbsentPrices } from "./erpPriceVariationPolicy.js";

const rules = [
  { CODTABELA: "2", CODGRUPO: "10", PER_VARIACAO: "10" },
  { CODTABELA: "3", CODGRUPO: "10", PER_VARIACAO: "25" },
  { CODTABELA: "4", CODGRUPO: "10", PER_VARIACAO: "-5" },
];

assert.equal(calculatePriceFromErpVariation(100, resolveErpPriceVariationPercent(rules, "2", "10")!), 110);
assert.equal(calculatePriceFromErpVariation(100, resolveErpPriceVariationPercent(rules, "3", "10")!), 125);
assert.equal(calculatePriceFromErpVariation(100, resolveErpPriceVariationPercent(rules, "4", "10")!), 95);
assert.equal(resolveErpPriceVariationPercent(rules, "5", "10"), null, "Tabela sem regra ERP não recebe percentual inventado");

const changedRules = rules.map((rule) => rule.CODTABELA === "3" ? { ...rule, PER_VARIACAO: "30" } : rule);
assert.equal(calculatePriceFromErpVariation(100, resolveErpPriceVariationPercent(changedRules, "3", "10")!), 130,
  "Novo ciclo deve refletir alteração percentual recebida do ERP");

const calls: string[] = [];
const unordered = ["connection", "products", "prices", "priceVariations", "priceTables", "orders"]
  .map((scope) => ({ scope, run: () => calls.push(scope) }));
for (const step of orderPriceAuthoritySteps(unordered)) step.run();
assert.deepEqual(calls, ["connection", "products", "priceTables", "priceVariations", "prices", "orders"],
  "Entradas manual e automática devem executar a mesma precedência comercial");

assert.equal(shouldSweepAbsentPrices(false), false, "Resposta parcial não pode invalidar registro ausente");
assert.equal(shouldSweepAbsentPrices(true), true, "Somente snapshot integral permite sweep de ausência");

console.log("ERP price variation policy regression: PASS");
