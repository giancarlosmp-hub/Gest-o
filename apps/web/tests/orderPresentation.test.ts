import assert from "node:assert/strict";
import { formatOrderDate, formatOrderQuantity, orderSituationLabel } from "../src/pages/orderPresentation.js";

assert.equal(formatOrderDate(null), "Não informado");
assert.equal(formatOrderDate("payload-incompleto"), "Não informado");
assert.doesNotThrow(() => formatOrderDate("2026-99-99"));
assert.equal(formatOrderQuantity(null), "Não informado");
assert.equal(formatOrderQuantity(0), "0");

console.log("Orders presentation regression tests passed");

// Tentativa recusada (dados fictícios) com situação FINALIZADO falsa gravada.
assert.equal(
  orderSituationLabel({ syncStatus: "error", statusGroup: "error", operationalStatus: "FINALIZADO" }),
  "Recusado pelo ERP",
);
assert.equal(
  orderSituationLabel({ syncStatus: "error", statusGroup: "error", operationalStatus: "CANCELADO" }),
  "Recusado pelo ERP",
);
assert.equal(
  orderSituationLabel({ syncStatus: "sent", statusGroup: "finished", operationalStatus: "FINALIZADO" }),
  "FINALIZADO",
);
assert.equal(
  orderSituationLabel({ syncStatus: "sent", statusGroup: "cancelled", operationalStatus: null }),
  "CANCELADO",
);
console.log("Rejected attempt presentation tests passed");
