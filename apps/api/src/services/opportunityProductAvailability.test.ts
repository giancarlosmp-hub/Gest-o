import assert from "node:assert/strict";
import { calculateOpportunityPriceForTable, isOpportunityProductSelectable } from "./opportunityPriceService.js";

const product = (overrides: Record<string, unknown> = {}) => ({
  erpProductCode: "1",
  erpProductClassCode: "9",
  defaultPrice: 999,
  rawErpPayload: { PRECO: 888, PRECO_TABELA_1: 777 },
  prices: [{ erpPriceId: "1", branchCode: "1", price: 128 }],
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
  const result = price(product({ prices: [{ erpPriceId: "1", branchCode: "1", price: invalidPrice }] }));
  assert.equal(result.priceTableMatched, false);
  assert.equal(result.price, 0);
}

// A current invalidation wins over duplicate historical positives and no legacy
// source may resurrect the value.
const staleThenZero = price(product({
  defaultPrice: 296,
  rawErpPayload: { PRECO: 296 },
  prices: [
    { erpPriceId: "1", branchCode: "1", price: 296 },
    { erpPriceId: "1", branchCode: "1", price: 0 },
  ],
}));
assert.equal(staleThenZero.price, 0);
assert.equal(staleThenZero.source, "missing");

// Missing selected-table price is unavailable; a price from another table or
// branch cannot cross the commercial boundary.
assert.equal(price(product(), "2").priceTableMatched, false);
assert.equal(price(product(), "1", "2").priceTableMatched, false);
assert.equal(price(product(), "1", "1").price, 128);

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
assert.equal(price(product({ erpProductClassCode: "19", prices: [{ erpPriceId: "1", branchCode: "1", price: 296 }] })).price, 296);
assert.equal(price(product({ erpProductClassCode: "12", prices: [{ erpPriceId: "1", branchCode: "1", price: 0 }] })).price, 0);
assert.equal(price(product({ erpProductClassCode: "13", prices: [{ erpPriceId: "1", branchCode: "1", price: 0 }] })).price, 0);

console.log("opportunity product availability regression: PASS");
