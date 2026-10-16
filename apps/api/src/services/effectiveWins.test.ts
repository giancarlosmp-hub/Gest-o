import assert from "node:assert/strict";
import test from "node:test";
import { effectiveWonContribution } from "./effectiveWins.js";
const order = (status: string, value: number | null = 100, tenantId = "t1", id = `${status}-${value}`) => ({ id, tenantId, status: "sent", operationalOrderStatus: status, pedidoIdImportacao: id, erpOrderNumber: id, payloadSent: value === null ? {} : { VALOR_LIQUIDO: value } });
test("unique fully cancelled order contributes zero, is idempotent, and preserves input history", () => {
  const opportunity = { tenantId: "t1", value: 369.86, erpOrderSyncs: [order("CANCELADO", 369.86, "t1", "900169")] };
  const first = effectiveWonContribution(opportunity); const second = effectiveWonContribution(opportunity);
  assert.deepEqual(first, second); assert.equal(first.value, 0); assert.equal(first.count, 0); assert.match(first.reason!, /Ganho desconsiderado/); assert.equal(opportunity.erpOrderSyncs.length, 1);
});
test("no order and valid orders preserve prior commercial amount/count", () => {
  assert.deepEqual(effectiveWonContribution({ tenantId: "t1", value: 80 }), { value: 80, count: 1, disregarded: false, partialCancellation: false, reason: null, originalValue: 80 });
  assert.equal(effectiveWonContribution({ tenantId: "t1", value: 300, erpOrderSyncs: [order("FINALIZADO", 275)] }).value, 300);
});
test("multiple orders preserve the explicit amount of remaining valid orders without proportional allocation", () => {
  const result = effectiveWonContribution({ tenantId: "t1", value: 300, erpOrderSyncs: [order("CANCELADO", 100, "t1", "cancelled"), order("FINALIZADO", 200, "t1", "valid")] });
  assert.equal(result.value, 200); assert.equal(result.count, 1); assert.equal(result.partialCancellation, true);
});
test("opportunity value differing from order sum uses explicit valid order amount and flags mismatch", () => {
  const result = effectiveWonContribution({ tenantId: "t1", value: 500, erpOrderSyncs: [order("CANCELADO", 100, "t1", "cancelled"), order("FINALIZADO", 200, "t1", "valid")] });
  assert.equal(result.value, 200); assert.equal(result.count, 1); assert.match(result.reason!, /diverge/);
});
test("missing remaining order value is signalled and never proportionally estimated", () => {
  const result = effectiveWonContribution({ tenantId: "t1", value: 300, erpOrderSyncs: [order("CANCELADO", 100), order("FINALIZADO", null)] });
  assert.equal(result.value, 300); assert.equal(result.count, 1); assert.match(result.reason!, /não confirmado/);
});
test("ERP PARCIAL alone is fulfillment, not proof of cancellation", () => {
  const result = effectiveWonContribution({ tenantId: "t1", value: 450, erpOrderSyncs: [order("PARCIAL", 120)] });
  assert.equal(result.value, 450); assert.equal(result.count, 1); assert.equal(result.partialCancellation, false);
});
test("tenant isolation and explicit replacement links only", () => {
  const original = order("CANCELADO", 100, "t1", "original");
  const replacement = { ...order("FINALIZADO", 100, "t1", "replacement"), supersedesErpOrderSyncId: "original" };
  assert.equal(effectiveWonContribution({ tenantId: "t1", value: 100, erpOrderSyncs: [original, replacement, order("CANCELADO", 999, "t2", "foreign")] }).value, 100);
});
test("only valid (sent) orders affect the won contribution; rejected and unconfirmed attempts never do", () => {
  const rejectedCancelled = { ...order("CANCELADO", 100, "t1", "rejected"), status: "error" };
  const unconfirmedCancelled = { ...order("CANCELADO", 100, "t1", "unconfirmed"), status: "pending" };
  const alone = effectiveWonContribution({ tenantId: "t1", value: 100, erpOrderSyncs: [rejectedCancelled, unconfirmedCancelled] });
  assert.deepEqual(alone, { value: 100, count: 1, disregarded: false, partialCancellation: false, reason: null, originalValue: 100 });
  assert.doesNotMatch(alone.reason ?? "", /Ganho desconsiderado/);
  const withSent = effectiveWonContribution({ tenantId: "t1", value: 300, erpOrderSyncs: [rejectedCancelled, order("FINALIZADO", 300, "t1", "accepted")] });
  assert.equal(withSent.value, 300); assert.equal(withSent.count, 1); assert.equal(withSent.partialCancellation, false);
  const realCancel = effectiveWonContribution({ tenantId: "t1", value: 300, erpOrderSyncs: [{ ...order("FINALIZADO", 300, "t1", "rejected-final"), status: "error" }, order("CANCELADO", 300, "t1", "accepted")] });
  assert.equal(realCancel.count, 0); assert.equal(realCancel.disregarded, true);
});
