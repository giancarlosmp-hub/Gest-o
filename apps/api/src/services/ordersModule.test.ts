import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyUltraFv3OrderLookup, extractOperationalStatus, normalizeOperationalOrderStatus, sanitizeErpOrderErrorMessage } from "./erpOrderService.js";

const expected = { pedidoIdImportacao: "import-123", numPedido: "42" };
for (const [raw, mapped] of [["DIGITADO", "pendente"], ["ACEITO", "pendente"], ["PARCIAL", "parcial"], ["FINALIZADO", "entregue"], ["CANCELADO", "cancelado"]] as const) {
  const result = classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, NUM_PEDIDO: "42", SITUACAO_PEDIDO: raw }, expected);
  assert.equal(result.matched, true); assert.equal(result.orderStatus, mapped); assert.equal(extractOperationalStatus({ SITUACAO_PEDIDO: raw }), raw);
  assert.equal(normalizeOperationalOrderStatus(raw), raw);
}
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: "other", SITUACAO_PEDIDO: "FINALIZADO" }, expected).matched, false);
assert.equal(classifyUltraFv3OrderLookup({ PEDIDO_ID_IMPORTACAO: expected.pedidoIdImportacao, SITUACAO_PEDIDO: "ESTADO_NOVO" }, expected).orderStatus, "pendente");
assert.equal(normalizeOperationalOrderStatus("ESTADO_NOVO"), "UNKNOWN");
assert.doesNotMatch(sanitizeErpOrderErrorMessage("token=secret password=hunter2 CPF 123.456.789-00"), /secret|hunter2|456[.]789/);

const routes = fs.readFileSync(new URL("../routes/orderRoutes.ts", import.meta.url), "utf8");
assert.match(routes, /client:\s*\{ tenantId \}/, "listagem deve restringir pelo tenant do cliente");
assert.match(routes, /role === "vendedor"[\s\S]*ownerSellerId: req\.user!\.id/, "vendedor deve ser restrito ao próprio escopo");
assert.doesNotMatch(routes, /req\.(body|query)\.tenantId/, "tenant nunca pode vir do navegador");
assert.match(routes, /requestAuthorizationStatus/, "autorização de solicitações deve permanecer separada do status operacional");
assert.match(routes, /reduce\(\(acc, item\)/, "agregação deve operar uma vez por pedido projetado");

console.log("Orders module regression tests passed");
