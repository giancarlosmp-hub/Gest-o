import assert from "node:assert/strict";
import { calculateOpportunityPriceForTable, isOpportunityProductSelectable } from "./opportunityPriceService.js";
import { assertUsefulProductPriceSync, opportunityProductRefreshFailureMessage, runProductAndPriceRefresh } from "./productPriceSyncOutcome.js";
import { catalogTenantIdForMode, isProductOwnedByTenant, productCatalogTenantWhere, selectProductCandidateForTenant } from "./productCatalogTenancy.js";
import { normalizeErpProductPriceObservation, selectCurrentErpPriceObservation, selectCurrentErpPriceObservationForBranch } from "./erpProductPriceObservation.js";

const product = (overrides: Record<string, unknown> = {}) => ({
  erpProductCode: "1",
  erpProductClassCode: "9",
  defaultPrice: 999,
  rawErpPayload: { PRECO: 888, PRECO_TABELA_1: 777 },
  prices: [{ erpPriceId: "1", branchCode: null, price: 128 }],
  ...overrides,
});

const price = (value: ReturnType<typeof product>, table = "1", branch?: string) =>
  calculateOpportunityPriceForTable({ product: value, priceTableCode: table, branchCode: branch });

assert.deepEqual(price(product()), {
  price: 128,
  priceTableCode: "1",
  priceTableMatched: true,
  priceWarning: null,
  source: "productPrice",
});

for (const invalidPrice of [0, Number.NaN, -1]) {
  const result = price(product({ prices: [{ erpPriceId: "1", branchCode: null, price: invalidPrice }] }));
  assert.equal(result.priceTableMatched, false);
  assert.equal(result.price, 0);
}

// A current invalidation wins over duplicate historical positives and no legacy
// source may resurrect the value.
const staleThenZero = price(product({
  defaultPrice: 296,
  rawErpPayload: { PRECO: 296 },
  prices: [
    { erpPriceId: "1", branchCode: null, price: 296 },
    { erpPriceId: "1", branchCode: null, price: 0 },
  ],
}));
assert.equal(staleThenZero.price, 0);
assert.equal(staleThenZero.source, "missing");

// PR #866 used a global absence sweep from /prices and erased the price just
// asserted by /products. Absence is source-local; it is not an explicit zero.
const productAuthoritySurvivesPricesAbsence = price(product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
  { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "absent", sourceChangedAt: new Date("2026-09-11T10:01:00Z") },
] }));
assert.equal(productAuthoritySurvivesPricesAbsence.price, 128);

const explicitZeroWins = price(product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
  { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero", sourceChangedAt: new Date("2026-09-11T10:01:00Z") },
] }));
assert.equal(explicitZeroWins.price, 0);

const laterPositiveRestoresAvailability = price(product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
  { erpPriceId: "1", branchCode: null, price: 296, source: "prices", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:01:00Z") },
] }));
assert.equal(laterPositiveRestoresAvailability.price, 296);

// A legacy catalogue observation can be newer because /products runs before
// /prices in every cycle. It still cannot override an authoritative tombstone.
const laterLegacyCannotRestoreAuthoritativeZero = price(product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
  { erpPriceId: "1", branchCode: null, price: 296, source: "products", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T11:00:00Z") },
] }));
assert.equal(laterLegacyCannotRestoreAuthoritativeZero.price, 0);
assert.equal(laterLegacyCannotRestoreAuthoritativeZero.source, "missing");

// Missing selected-table price is unavailable. PRECO_VENDA proves that an
// explicit requested branch may use the null-branch candidate.
assert.equal(price(product(), "2").priceTableMatched, false);
assert.equal(price(product(), "1", "2").price, 128);
assert.equal(price(product(), "1", "1").price, 128);

// Production regression: an unscoped /prices row for one branch cannot
// override the explicit table/global row when opportunity search has no
// commercial branch context.
const maranduPost898 = product({ prices: [
  { erpPriceId: null, branchCode: null, price: 128, source: "prices", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:00:00Z") },
  { erpPriceId: null, branchCode: "1", price: 252.08, source: "prices", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:01:00Z") },
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:02:00Z") },
  { erpPriceId: "2", branchCode: null, price: 160, source: "calculated_from_variation", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:03:00Z") },
] });
assert.equal(price(maranduPost898, "1").price, 128);
assert.equal(price(maranduPost898, "2").price, 160);
assert.equal(price(maranduPost898, "1", "1").price, 128, "Vigência aplicável sem filial pode atender filial explícita segundo PRECO_VENDA");

const branchPolicy = product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available" },
  { erpPriceId: "1", branchCode: "2", price: 140, source: "prices", availabilityState: "available" },
] });
assert.equal(price(branchPolicy, "1").price, 128, "Sem filial, somente o mesmo contexto sem filial é comparável");
assert.equal(price(branchPolicy, "1", "2").price, 140, "Filial explícita deve preferir correspondência exata");
assert.equal(price(branchPolicy, "1", "3").price, 128, "Filial solicitada admite candidato de filial nula segundo PRECO_VENDA");
const validityBeforeBranch = product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "prices", availabilityState: "available", validFrom: new Date("2026-06-09T00:00:00Z") },
  { erpPriceId: "1", branchCode: "1", price: 252.08, source: "prices", availabilityState: "available", validFrom: new Date("2022-08-26T00:00:00Z") },
] });
assert.equal(price(validityBeforeBranch, "1", "1").price, 128,
  "Preço histórico da filial não pode vencer preço geral de vigência posterior");

const explicitTableAuthority = product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:00:00Z") },
  { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero", sourceChangedAt: new Date("2026-09-26T22:01:00Z") },
] });
assert.equal(price(explicitTableAuthority, "1").price, 0, "Zero de /prices deve vencer /products somente após equivalência explícita de tabela e filial");
const explicitTableRestored = product({ prices: [
  ...explicitTableAuthority.prices,
  { erpPriceId: "1", branchCode: null, price: 130, source: "prices", availabilityState: "available", sourceChangedAt: new Date("2026-09-26T22:02:00Z") },
] });
assert.equal(price(explicitTableRestored, "1").price, 130, "Positivo posterior de /prices deve restaurar o mesmo contexto explícito");

const unscopedZeroIsNotEquivalent = product({ prices: [
  { erpPriceId: "1", branchCode: null, price: 128, source: "products", availabilityState: "available" },
  { erpPriceId: null, branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero" },
] });
assert.equal(price(unscopedZeroIsNotEquivalent, "1").price, 128, "Tabela ausente não pode invalidar Tabela 1 sem equivalência contratual");

for (const entryPoint of ["manual", "automatic", "opportunity-products"]) {
  assert.throws(
    () => assertUsefulProductPriceSync({ received: 501, productFoundRows: 0, matchedProducts: 0, explicitZeroRows: 0, invalidPrice: 0, missingProduct: 501, persistedPriceRows: 0, rejectedRows: 501, updatedPrices: 0, createdPrices: 0 }),
    /nenhum produto foi encontrado/,
    `${entryPoint} não pode declarar sucesso quando recebeu preços e processou zero produtos`,
  );
  assert.throws(
    () => assertUsefulProductPriceSync({ received: 501, productFoundRows: 181, matchedProducts: 181, explicitZeroRows: 0, invalidPrice: 0, missingProduct: 320, persistedPriceRows: 181, rejectedRows: 320, updatedPrices: 181, createdPrices: 0 }),
    /320 sem produto.*possíveis gravações parciais/,
    `${entryPoint} deve sinalizar produtos realmente ausentes sem inferir pela diferença received/matchedProducts`,
  );
  assert.equal(assertUsefulProductPriceSync({
    received: 501,
    productFoundRows: 501,
    matchedProducts: 181,
    explicitZeroRows: 320,
    invalidPrice: 0,
    missingProduct: 0,
    persistedPriceRows: 501,
    rejectedRows: 0,
    updatedPrices: 181,
    createdPrices: 0,
  }), 501, `${entryPoint} deve processar positivos e zeros explícitos sem confundir zero com inválido`);
}

assert.deepEqual(productCatalogTenantWhere("tenant-a"), { tenantId: "tenant-a" });
assert.equal(isProductOwnedByTenant("tenant-a", "tenant-a"), true);
assert.equal(isProductOwnedByTenant("tenant-b", "tenant-a"), false);
assert.equal(isProductOwnedByTenant(null, "tenant-a"), false, "NULL não pode ser promovido a compartilhado sem contrato arquitetural");
assert.deepEqual(productCatalogTenantWhere(), {}, "Job global permanece separado do escopo autenticado");
assert.equal(catalogTenantIdForMode("tenant-a", "disabled"), undefined,
  "catálogo global da produção disabled deve continuar alcançando produtos tenantId=NULL");
assert.equal(catalogTenantIdForMode("tenant-a", "default-only"), "tenant-a",
  "default-only deve preservar a fronteira autenticada do catálogo");
const collidingCatalogCandidates = [
  { id: "shared", tenantId: null, erpProductCode: "1", erpProductClassCode: "9" },
  { id: "a", tenantId: "tenant-a", erpProductCode: "1", erpProductClassCode: "9" },
  { id: "b", tenantId: "tenant-b", erpProductCode: "1", erpProductClassCode: "9" },
];
assert.equal(selectProductCandidateForTenant(collidingCatalogCandidates, "tenant-a", "1", "9")?.id, "a");
assert.equal(selectProductCandidateForTenant(collidingCatalogCandidates, "tenant-b", "1", "9")?.id, "b");
assert.equal(selectProductCandidateForTenant(collidingCatalogCandidates, "tenant-c", "1", "9"), null);
assert.equal(selectProductCandidateForTenant(collidingCatalogCandidates, undefined, "1", "9"), null,
  "Job global deve falhar fechado diante de colisão impossível pelo schema, não escolher a primeira linha");

const historical128 = normalizeErpProductPriceObservation({
  CODPRODUTO: 1, CODPRODUTO_CLAS: 9, PRECOS_ID: 2776, PRECO: 128, CODFILIAL: null,
  DATA_VIGENCIA: "2026-06-09", DTAALTER: "2026-06-09T11:10:53.516Z",
});
const historical252 = normalizeErpProductPriceObservation({
  CODPRODUTO: 1, CODPRODUTO_CLAS: 9, PRECOS_ID: 2166, PRECO: 252.08, CODFILIAL: 1,
  DATA_VIGENCIA: "2022-08-26", DTAALTER: "2022-08-26T16:59:58.214Z",
});
assert.equal(historical128.sourcePriceId, "2776");
assert.equal(historical128.sourceValidFrom?.toISOString(), "2026-06-09T00:00:00.000Z");
assert.equal(historical128.sourceChangedAt?.toISOString(), "2026-06-09T11:10:53.516Z");
assert.equal(historical252.sourcePriceId, "2166");
for (const ordered of [[historical252, historical128], [historical128, historical252]]) {
  assert.equal(selectCurrentErpPriceObservation(ordered, new Date("2026-09-27T00:00:00Z"))?.sourcePriceId, "2776",
    "Ordem de recebimento/coleta não pode substituir vigência e alteração da origem");
}
for (const ordered of [[historical252, historical128], [historical128, historical252]]) {
  assert.equal(selectCurrentErpPriceObservationForBranch(ordered, "1", new Date("2026-09-27T00:00:00Z"))?.sourcePriceId, "2776",
    "PRECO_VENDA ordena vigência antes da preferência pela filial exata");
}
assert.equal(selectCurrentErpPriceObservationForBranch([historical252, historical128], null), undefined,
  "Sem filial solicitada não há contexto suficiente para aplicar a precedência PRECO_VENDA");
const sameValidityGlobal = { ...historical128, sourcePriceId: "global-same", sourceValidFrom: new Date("2026-06-09T00:00:00Z"), branchCode: null };
const sameValidityBranch = { ...historical128, sourcePriceId: "branch-same", sourceValidFrom: new Date("2026-06-09T00:00:00Z"), branchCode: "1" };
assert.equal(selectCurrentErpPriceObservationForBranch([sameValidityGlobal, sameValidityBranch], "1")?.sourcePriceId, "branch-same",
  "Filial exata só desempata observações com a mesma vigência");
const future = { ...historical128, sourcePriceId: "future", sourceValidFrom: new Date("2027-01-01T00:00:00Z") };
assert.equal(selectCurrentErpPriceObservation([future, historical128], new Date("2026-09-27T00:00:00Z"))?.sourcePriceId, "2776");
const olderZero = { ...historical252, sourcePriceId: "zero-old", price: 0 };
assert.equal(selectCurrentErpPriceObservation([historical128, olderZero], new Date("2026-09-27T00:00:00Z"))?.sourcePriceId, "2776",
  "Zero antigo não pode vencer positivo de vigência posterior por ter sido recoletado");
const currentZero = { ...historical128, sourcePriceId: "zero-current", price: 0, sourceChangedAt: new Date("2026-06-10T00:00:00Z") };
assert.equal(selectCurrentErpPriceObservation([historical128, currentZero], new Date("2026-09-27T00:00:00Z"))?.sourcePriceId, "zero-current",
  "Zero da mesma vigência e versão posterior deve permanecer candidato autoritativo");
assert.match(opportunityProductRefreshFailureMessage(501, "prices rejected"),
  /Estoque processado \(501\).*preços falhou.*gravações parciais/,
  "Atualizar estoque deve preservar e relatar a etapa de estoque quando preços falham");
const refreshCalls: string[] = [];
const refreshResult = await runProductAndPriceRefresh(
  async () => { refreshCalls.push("products"); return { syncedCount: 501, stockUpdated: 501 }; },
  async () => { refreshCalls.push("prices"); return { syncedCount: 501, persistedPriceRows: 501 }; },
);
assert.deepEqual(refreshCalls, ["products", "prices"], "Atualizar estoque deve atualizar catálogo/estoque antes de preços");
assert.equal(refreshResult.products.stockUpdated, 501);
assert.equal(refreshResult.prices.persistedPriceRows, 501);
await assert.rejects(
  runProductAndPriceRefresh(
    async () => ({ syncedCount: 501, stockUpdated: 501 }),
    async () => { throw new Error("prices rejected"); },
  ),
  /Estoque processado \(501\).*preços falhou.*gravações parciais/,
);

const eligible = (overrides: Partial<Parameters<typeof isOpportunityProductSelectable>[0]> = {}) => isOpportunityProductSelectable({
  isActive: true,
  isSuspended: false,
  isSynchronized: true,
  price: 128,
  priceTableMatched: true,
  ...overrides,
});
assert.equal(eligible(), true);
assert.equal(eligible({ isActive: false }), false);
assert.equal(eligible({ isSuspended: true }), false);
assert.equal(eligible({ isSynchronized: false }), false);
// Stock is intentionally absent from the policy: zero stock does not hide.
assert.equal(eligible(), true);

// Composite product/class identities remain independent.
assert.equal(price(product({ erpProductClassCode: "19", prices: [{ erpPriceId: "1", branchCode: null, price: 296 }] })).price, 296);
assert.equal(price(product({ erpProductClassCode: "12", prices: [{ erpPriceId: "1", branchCode: null, price: 0 }] })).price, 0);
assert.equal(price(product({ erpProductClassCode: "13", prices: [{ erpPriceId: "1", branchCode: null, price: 0 }] })).price, 0);

// Derived prices from priceVariations (Camada 2) match for Table 2 and are selectable
const calculatedVariationPrice = price(product({
  prices: [
    { erpPriceId: "1", branchCode: null, price: 100, source: "prices", availabilityState: "available" },
    { erpPriceId: "2", branchCode: null, price: 115, source: "calculated_from_variation", availabilityState: "available" },
  ],
}), "2");
assert.equal(calculatedVariationPrice.priceTableMatched, true);
assert.equal(calculatedVariationPrice.price, 115);
assert.equal(calculatedVariationPrice.source, "productPrice");

// Explicit price from /prices for Table 2 wins over calculated_from_variation if present
const explicitOverDerived = price(product({
  prices: [
    { erpPriceId: "2", branchCode: null, price: 115, source: "calculated_from_variation", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
    { erpPriceId: "2", branchCode: null, price: 120, source: "prices", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:05:00Z") },
  ],
}), "2");
assert.equal(explicitOverDerived.price, 120);

// Explicit zero for Table 2 blocks calculated variation
const zeroBlocksDerived = price(product({
  prices: [
    { erpPriceId: "2", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero", sourceChangedAt: new Date("2026-09-11T10:05:00Z") },
    { erpPriceId: "2", branchCode: null, price: 115, source: "calculated_from_variation", availabilityState: "available", sourceChangedAt: new Date("2026-09-11T10:00:00Z") },
  ],
}), "2");
assert.equal(zeroBlocksDerived.priceTableMatched, false);
assert.equal(zeroBlocksDerived.price, 0);

// --- INCIDENT REGRESSION TESTS: Unscoped Prices & Fallback Rules ---

// 1. Unscoped price (erpPriceId = null) for Table 1 search
const unscopedPriceProduct = product({
  prices: [
    { erpPriceId: null, branchCode: null, price: 181.50, source: "prices", availabilityState: "available" }
  ]
});
const unscopedResult = price(unscopedPriceProduct, "1");
assert.equal(unscopedResult.price, 181.50);
assert.equal(unscopedResult.priceTableMatched, true);
assert.equal(unscopedResult.source, "productPrice");
assert.equal(isOpportunityProductSelectable({
  isActive: true,
  isSuspended: false,
  isSynchronized: true,
  price: unscopedResult.price,
  priceTableMatched: unscopedResult.priceTableMatched
}), true, "Produto com preço sem tabela sincronizado de /prices deve ficar visível na busca de Nova Oportunidade para Tabela 1");

// 2. Unscoped price (erpPriceId = null) does not match secondary tables (Table 2)
const unscopedTable2Result = price(unscopedPriceProduct, "2");
assert.equal(unscopedTable2Result.priceTableMatched, false);
assert.equal(unscopedTable2Result.price, 0);
assert.equal(unscopedTable2Result.source, "missing");

// 3. Precedence: Explicit Table 1 takes precedence over unscoped fallback
const explicitOverUnscopedProduct = product({
  prices: [
    { erpPriceId: null, branchCode: null, price: 181.50, source: "prices", availabilityState: "available" },
    { erpPriceId: "1", branchCode: null, price: 128.00, source: "products", availabilityState: "available" }
  ]
});
const explicitOverUnscopedResult = price(explicitOverUnscopedProduct, "1");
assert.equal(explicitOverUnscopedResult.price, 128.00, "Preço explícito de Tabela 1 deve ter precedência sobre fallback de preço sem tabela");

// 4. Precedence: Explicit Table 1 zero takes precedence over unscoped positive fallback
const explicitZeroOverUnscopedPositiveProduct = product({
  prices: [
    { erpPriceId: null, branchCode: null, price: 181.50, source: "prices", availabilityState: "available" },
    { erpPriceId: "1", branchCode: null, price: 0, source: "prices", availabilityState: "explicit_zero" }
  ]
});
const explicitZeroOverUnscopedResult = price(explicitZeroOverUnscopedPositiveProduct, "1");
assert.equal(explicitZeroOverUnscopedResult.price, 0, "Zero explícito da Tabela 1 não pode ser substituído por fallback de preço sem tabela");
assert.equal(explicitZeroOverUnscopedResult.priceTableMatched, false);

// 5. Explicit table matching for Tables 1, 2, 3, and 4
const multiTableProduct = product({
  prices: [
    { erpPriceId: "1", branchCode: null, price: 100, source: "prices", availabilityState: "available" },
    { erpPriceId: "2", branchCode: null, price: 110, source: "prices", availabilityState: "available" },
    { erpPriceId: "3", branchCode: null, price: 120, source: "calculated_from_variation", availabilityState: "available" },
    { erpPriceId: "4", branchCode: null, price: 130, source: "prices", availabilityState: "available" },
  ]
});
assert.equal(price(multiTableProduct, "1").price, 100);
assert.equal(price(multiTableProduct, "2").price, 110);
assert.equal(price(multiTableProduct, "3").price, 120);
assert.equal(price(multiTableProduct, "4").price, 130);

// 6. Historical vigência vs future validity filtering
const futureValidityProduct = product({
  prices: [
    { erpPriceId: null, branchCode: null, price: 500, source: "prices", availabilityState: "available", validFrom: new Date("2099-01-01T00:00:00Z") },
    { erpPriceId: null, branchCode: null, price: 180, source: "prices", availabilityState: "available", validFrom: new Date("2026-01-01T00:00:00Z") }
  ]
});
assert.equal(price(futureValidityProduct, "1").price, 180, "Vigência futura deve ser ignorada em favor da vigência atual válida");

// 7. Branch matching with unscoped prices
const branchUnscopedProduct = product({
  prices: [
    { erpPriceId: null, branchCode: null, price: 181.50, source: "prices", availabilityState: "available" },
    { erpPriceId: null, branchCode: "FILIAL-02", price: 200.00, source: "prices", availabilityState: "available" }
  ]
});
assert.equal(price(branchUnscopedProduct, "1").price, 181.50, "Busca sem filial deve selecionar linha com filial nula");
assert.equal(price(branchUnscopedProduct, "1", "FILIAL-02").price, 200.00, "Busca com filial específica deve preferir a filial correspondente");
assert.equal(price(branchUnscopedProduct, "1", "FILIAL-99").price, 181.50, "Filial solicitada sem correspondência exata admite candidato de filial nula");

// 8. Full Sync, Automatic Sync, and Update Stock outcome assertions
const unscopedSyncDiagnostics = {
  received: 501,
  productFoundRows: 501,
  matchedProducts: 181,
  explicitZeroRows: 320,
  invalidPrice: 0,
  missingProduct: 0,
  persistedPriceRows: 501,
  rejectedRows: 0,
  updatedPrices: 181,
  createdPrices: 0,
};
assert.equal(assertUsefulProductPriceSync(unscopedSyncDiagnostics), 501, "Sincronização com 501 linhas (incluindo preços sem tabela e zeros explícitos) deve ser validada com sucesso");

console.log("opportunity product availability regression: PASS");
