import assert from "node:assert/strict";
import test from "node:test";
import { classifyUltraFv3OrderLookup, extractMatchedOperationalStatus, normalizeOperationalOrderStatus } from "./erpOrderService.js";
import { orderStatusGroup } from "./orderStatusProjection.js";
import { effectiveWonContribution } from "./effectiveWins.js";

test("representative ERP payload crosses normalization, persisted projection, API group and effective metrics", () => {
  const expected = { pedidoIdImportacao: "synthetic-900169", erpOrderNumber: "900169" };
  const payload = { status: "FINALIZADO", data: [{ PEDIDO_ID_IMPORTACAO: "synthetic-900169", NUM_PEDIDO: "900169", CODFILIAL: 1, SITUACAO_PEDIDO: "CANCELADO", VALOR_LIQUIDO: 369.86 }] };
  const classification = classifyUltraFv3OrderLookup(payload, expected);
  const raw = extractMatchedOperationalStatus(payload, expected);
  const persisted = { id: "order-900169", tenantId: "tenant-a", pedidoIdImportacao: expected.pedidoIdImportacao, erpOrderNumber: "900169", operationalOrderStatus: normalizeOperationalOrderStatus(raw), payloadSent: { VALOR_LIQUIDO: 369.86 } };
  assert.equal(classification.orderStatus, "cancelado");
  assert.equal(raw, "CANCELADO");
  assert.equal(orderStatusGroup("sent", raw, classification.orderStatus), "cancelled");
  const metric = effectiveWonContribution({ tenantId: "tenant-a", value: 369.86, erpOrderSyncs: [persisted] });
  assert.equal(metric.count, 0); assert.equal(metric.value, 0); assert.match(metric.reason!, /Ganho desconsiderado/);
});
test("finalized and unknown remain exact and never share a fallback", () => {
  assert.equal(orderStatusGroup("sent", "FINALIZADO", "entregue"), "finished");
  assert.equal(orderStatusGroup("sent", "NOVO_ESTADO", null), "unknown");
});
