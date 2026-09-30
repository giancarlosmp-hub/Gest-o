import assert from "node:assert/strict";
import { isErpReferenceEligible } from "../../apps/api/src/utils/erpReferenceValidation.js";

console.log("[smoke:liberar-internet] Starting safety test suite...");

// 1. Test Operation 99 (ATIVO=S, LIBERAR_INTERNET=N, VENDAS=S) -> Ineligible
const op99 = { CODOPER: "99", DESCRICAO: "VENDA CONDICIONAL", ATIVO: "S", LIBERAR_INTERNET: "N", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", op99), false, "Op 99 with LIBERAR_INTERNET=N must be ineligible");

// 2. Test Operation 100 (ATIVO=S, LIBERAR_INTERNET=S, VENDAS=S) -> Eligible
const op100 = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", LIBERAR_INTERNET: "S", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", op100), true, "Op 100 with LIBERAR_INTERNET=S, ATIVO=S, VENDAS=S must be eligible");

// 3. Test Operation 320/340 (ATIVO=S, LIBERAR_INTERNET=S, VENDAS=N) -> Ineligible for sales operations
const op320 = { CODOPER: "320", DESCRICAO: "OUTRA OPERACAO", ATIVO: "S", LIBERAR_INTERNET: "S", VENDAS: "N" };
assert.equal(isErpReferenceEligible("operations", op320), false, "Op 320 with VENDAS=N must be ineligible for sales operations");

// 4. Test missing, null, empty, or invalid fields -> Fail closed
const opNull = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", LIBERAR_INTERNET: null, VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", opNull), false, "Null LIBERAR_INTERNET must fail closed");

const opMissing = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", opMissing), false, "Missing LIBERAR_INTERNET must fail closed");

const opEmpty = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", LIBERAR_INTERNET: "", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", opEmpty), false, "Empty LIBERAR_INTERNET must fail closed");

const opInvalidAtivo = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "N", LIBERAR_INTERNET: "S", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", opInvalidAtivo), false, "ATIVO=N must fail closed");

// 5. Test Receiving Conditions
const rcEligible = { CODCONDREC: "1", DESCRICAO: "A VISTA", ATIVO: "S", LIBERAR_INTERNET: "S" };
assert.equal(isErpReferenceEligible("receivingConditions", rcEligible), true, "ReceivingCondition with LIBERAR_INTERNET=S must be eligible");

const rcIneligible = { CODCONDREC: "2", DESCRICAO: "A PRAZO BLOQUEADO", ATIVO: "S", LIBERAR_INTERNET: "N" };
assert.equal(isErpReferenceEligible("receivingConditions", rcIneligible), false, "ReceivingCondition with LIBERAR_INTERNET=N must be ineligible");

const rcNull = { CODCONDREC: "3", DESCRICAO: "A PRAZO", ATIVO: "S", LIBERAR_INTERNET: null };
assert.equal(isErpReferenceEligible("receivingConditions", rcNull), false, "ReceivingCondition with null LIBERAR_INTERNET must fail closed");

// 6. Test Payment Methods (paymentMethods)
const pmEligible = { FORMA: "1", DESCRICAO: "DINHEIRO", ATIVO: "S", LIBERAR_INTERNET: "S" };
assert.equal(isErpReferenceEligible("paymentMethods", pmEligible), true, "Payment method with LIBERAR_INTERNET=S must be eligible");

const pmIneligible = { FORMA: "2", DESCRICAO: "CHEQUE INATIVO", ATIVO: "S", LIBERAR_INTERNET: "N" };
assert.equal(isErpReferenceEligible("paymentMethods", pmIneligible), false, "Payment method with LIBERAR_INTERNET=N must be ineligible");

const pmAbsentLiberarInternetAtivo = { FORMA: "3", DESCRICAO: "BOLETO", ATIVO: "S" };
assert.equal(isErpReferenceEligible("paymentMethods", pmAbsentLiberarInternetAtivo), true, "Payment method without LIBERAR_INTERNET but ATIVO=S falls back to eligible");

const pmAbsentLiberarInternetInativo = { FORMA: "4", DESCRICAO: "CARTAO BLOQUEADO", ATIVO: "N" };
assert.equal(isErpReferenceEligible("paymentMethods", pmAbsentLiberarInternetInativo), false, "Payment method without LIBERAR_INTERNET and ATIVO=N fails closed");

// 7. Test strict fail-closed ATIVO check (non-"S" values like "X" or "INVALID")
const opInvalidAtivoUnknown = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "X", LIBERAR_INTERNET: "S", VENDAS: "S" };
assert.equal(isErpReferenceEligible("operations", opInvalidAtivoUnknown), false, "ATIVO='X' (non-'S') must fail closed");

// 8. Test case-insensitivity and whitespace resilience
const opCaseSpaced = { CODOPER: "100", DESCRICAO: "VENDA", ATIVO: " s ", LIBERAR_INTERNET: " s ", VENDAS: " s " };
assert.equal(isErpReferenceEligible("operations", opCaseSpaced), true, "Padded lowercase ' s ' should be normalized and accepted");

console.log("[smoke:liberar-internet] LIBERAR_INTERNET safety test passed successfully.");
