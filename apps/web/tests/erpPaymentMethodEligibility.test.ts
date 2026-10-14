import assert from "node:assert/strict";
import { getPaymentMethodNotAllowedReason } from "../src/lib/erpPaymentMethodEligibility.js";

// Dados fictícios.
const allowed = [{ code: "1", value: "1" }, { code: "2", value: "2" }];

assert.equal(getPaymentMethodNotAllowedReason("", allowed), null, "sem forma selecionada: a regra de obrigatoriedade já cobre");
assert.equal(getPaymentMethodNotAllowedReason("1", allowed), null, "forma liberada pode ser enviada");

const reason = getPaymentMethodNotAllowedReason("91", allowed);
assert.ok(reason, "forma salva que não está mais na lista liberada bloqueia o envio");
assert.match(reason!, /forma de pagamento 91 não está liberada/);

assert.ok(getPaymentMethodNotAllowedReason("1", []), "lista vazia (nada liberado) bloqueia o envio: fail-closed");

console.log("ERP payment method eligibility tests passed");
