import assert from "node:assert/strict";
import { classifyUltraFv3OrderLookup, sanitizeErpOrderPayload } from "./erpOrderService.js";

const expected = { pedidoIdImportacao: "6f5edc8a-55a7-4502-a816-a8b94b8e67c2", numPedido: "3657" };

assert.deepEqual(
  classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, NUM_PEDIDO: "3657", STATUS: "ACEITO" }, expected),
  { outcome: "confirmed", matched: true, erpOrderNumber: "3657", orderStatus: "pendente" },
  "pedido criado e resposta recebida/perdida deve ser reconciliado pelo identificador preservado",
);
assert.equal(classifyUltraFv3OrderLookup([{ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, STATUS: "PROCESSANDO" }], expected).outcome, "processing", "aceite assíncrono deve continuar bloqueado");
assert.equal(classifyUltraFv3OrderLookup({ items: [] }, expected).outcome, "unknown", "não encontrado não prova não criação");
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: "outra-chave", STATUS: "REJEITADO" }, expected).outcome, "unknown", "resposta de outro pedido não pode liberar reenvio");
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, STATUS: "REJEITADO" }, expected).outcome, "rejected", "rejeição só é autoritativa quando vinculada ao identificador");

const redacted = sanitizeErpOrderPayload({ authorization: "Bearer secret", password: "secret", cliente: "Pessoa", nested: { token: "secret" } }) as Record<string, unknown>;
assert.equal(redacted.authorization, "[REDACTED]");
assert.equal(redacted.password, "[REDACTED]");
assert.equal(redacted.cliente, "[REDACTED]");
assert.deepEqual(redacted.nested, { token: "[REDACTED]" });

console.log("ERP order reconciliation tests passed");
