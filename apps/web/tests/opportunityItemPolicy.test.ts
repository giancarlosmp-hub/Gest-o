import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Item de oportunidade na tela com a política comercial: preço do ERP somente leitura, desconto só em %, limite do
// perfil, aviso sempre que houver desconto e item antigo sinalizado. Só números fictícios.
const { DEFAULT_COMMERCIAL_POLICY } = await import("@salesforce-pro/shared");
const {
  OPPORTUNITY_ITEM_ERP_PRICE_DIFFERS_LABEL,
  opportunityItemAmounts,
  opportunityItemDiscountError,
  opportunityItemDiscountWarning,
  opportunityItemDraftForEdit,
  parseDiscountPercentInput
} = await import("../src/lib/opportunityItemPolicy");

const WARNING = DEFAULT_COMMERCIAL_POLICY.discountWarning;
const item = (overrides: Record<string, unknown> = {}) => ({ quantity: "3", unitPrice: "140", discountType: "percent" as const, discountValue: "0", ...overrides });

assert.equal(parseDiscountPercentInput("2,5"), 2.5);
assert.equal(parseDiscountPercentInput("2.5"), 2.5);
assert.equal(parseDiscountPercentInput(""), 0);
assert.ok(Number.isNaN(parseDiscountPercentInput("abc")));

// Mesma conta da API: desconto arredondado para baixo no centavo.
assert.deepEqual(opportunityItemAmounts(item({ discountValue: "3" })), { grossTotal: 420, discountTotal: 12.6, netTotal: 407.4 });
assert.deepEqual(opportunityItemAmounts(item({ quantity: "3", unitPrice: "33.33", discountValue: "3" })), { grossTotal: 99.99, discountTotal: 2.99, netTotal: 97 });
assert.deepEqual(opportunityItemAmounts(item({ discountType: "value", discountValue: "20" })), { grossTotal: 420, discountTotal: 20, netTotal: 400 }, "item antigo em R$ só exibido");

// Limite do perfil (padrão 3% para todos) e aviso.
assert.equal(opportunityItemDiscountError(DEFAULT_COMMERCIAL_POLICY, "vendedor", item({ discountValue: "3" })), null);
assert.equal(opportunityItemDiscountError(DEFAULT_COMMERCIAL_POLICY, "vendedor", item({ discountValue: "3,5" })), `Desconto máximo permitido: 3%. ${WARNING}`);
assert.equal(opportunityItemDiscountError(DEFAULT_COMMERCIAL_POLICY, "diretor", item({ discountValue: "4" })), `Desconto máximo permitido: 3%. ${WARNING}`);
assert.equal(opportunityItemDiscountError(DEFAULT_COMMERCIAL_POLICY, "vendedor", item({ discountValue: "x" })), "Informe o desconto em %.");
assert.equal(opportunityItemDiscountError(DEFAULT_COMMERCIAL_POLICY, "vendedor", item({ discountType: "value", discountValue: "5" })), "Desconto só em %: informe o percentual de desconto.");
const managerPolicy = { ...DEFAULT_COMMERCIAL_POLICY, maxDiscountPercent: { vendedor: 3, gerente: 5, diretor: 5 } };
assert.equal(opportunityItemDiscountError(managerPolicy, "gerente", item({ discountValue: "5" })), null);
assert.equal(opportunityItemDiscountError({ ...managerPolicy, enabled: false }, "vendedor", item({ discountValue: "9" })), null);
assert.equal(opportunityItemDiscountWarning(DEFAULT_COMMERCIAL_POLICY, item({ discountValue: "0" })), null);
assert.equal(opportunityItemDiscountWarning(DEFAULT_COMMERCIAL_POLICY, item({ discountValue: "1" })), WARNING);

// Edição: o preço volta ao do ERP atual e o desconto passa a %.
const stale = { ...item({ unitPrice: "130", discountValue: "2" }), erpUnitPrice: 140, erpPriceDiffers: true };
assert.deepEqual(opportunityItemDraftForEdit(stale), { ...stale, unitPrice: "140", discountType: "percent", discountValue: "2", legacyValueDiscount: false });
const legacyValue = { ...item({ discountType: "value", discountValue: "15" }), erpUnitPrice: 140 };
assert.deepEqual(opportunityItemDraftForEdit(legacyValue), { ...legacyValue, unitPrice: "140", discountType: "percent", discountValue: "0", legacyValueDiscount: true });
assert.equal(opportunityItemDraftForEdit({ ...item(), erpUnitPrice: null }).unitPrice, "140", "sem preço do ERP, mantém o gravado (a API recusa ao salvar)");

// Tela: preço somente leitura, desconto só em %, selo nos itens antigos e tabela travada no pedido ERP.
const page = readFileSync(new URL("../src/pages/OpportunitiesPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(page, /<option value="value">R\$<\/option>/, "sem desconto em R$");
assert.doesNotMatch(page, /unitPrice: sanitizeNumericInput/, "preço não é digitável");
assert.match(page, /Preço unitário \(ERP\)/);
assert.match(page, /Desconto \(%\)/);
assert.match(page, /api\.get<CommercialPolicy>\("\/settings\/commercial-policy"\)/);
assert.match(page, /&& !itemDraftDiscountError;/, "acima do limite não adiciona");
assert.equal((page.match(/OPPORTUNITY_ITEM_ERP_PRICE_DIFFERS_LABEL\}/g) ?? []).length, 2, "selo no celular e no desktop");
assert.equal(OPPORTUNITY_ITEM_ERP_PRICE_DIFFERS_LABEL, "Preço diferente do ERP atual");
const details = readFileSync(new URL("../src/pages/OpportunityDetailsPage.tsx", import.meta.url), "utf8");
assert.match(details, /priceTableCode: item\.priceTableCode \|\| "1",/, "pedido com a tabela da oportunidade");
assert.doesNotMatch(details, /setErpOrderField\("priceTableCode"/, "tabela do pedido não é escolhida");

console.log("opportunityItemPolicy.test: ok");
