import assert from "node:assert/strict";
import {
  canConfirmErpManualResolution,
  ERP_MANUAL_RESOLUTION_PHRASE,
  type ManualResolutionConfirmation,
} from "../../apps/web/src/lib/erpManualResolution";

const valid: ManualResolutionConfirmation = {
  checked: true,
  consequenceAccepted: true,
  importIdSuffix: "12345678",
  justification: "Conferência realizada no ERP",
  confirmationPhrase: ERP_MANUAL_RESOLUTION_PHRASE,
};

assert.equal(canConfirmErpManualResolution({ ...valid, checked: false, consequenceAccepted: false }), false, "starts blocked with both confirmations unchecked");
assert.equal(canConfirmErpManualResolution({ ...valid, consequenceAccepted: false }), false, "remains blocked with only the first confirmation checked");
assert.equal(canConfirmErpManualResolution({ ...valid, checked: false }), false, "remains blocked with only the second confirmation checked");
assert.equal(canConfirmErpManualResolution(valid), true, "is enabled with both confirmations and valid fields");
assert.equal(canConfirmErpManualResolution({ ...valid, importIdSuffix: "1234567" }), false);
assert.equal(canConfirmErpManualResolution({ ...valid, justification: "curta" }), false);
assert.equal(canConfirmErpManualResolution({ ...valid, confirmationPhrase: "incorreta" }), false);

console.log("ERP manual resolution business rules: PASS");
