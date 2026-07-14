import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeUltraFv3OrderNumber, resolveSalesmenOrderContext, validateUltraFv3OrderPayload } from "../services/erpOrderService.js";

assert.equal(normalizeUltraFv3OrderNumber("0"), "", 'NUM_PEDIDO "0" é rejeitado');
assert.equal(normalizeUltraFv3OrderNumber(0), "", "NUM_PEDIDO 0 numérico é rejeitado");
assert.equal(normalizeUltraFv3OrderNumber("0000"), "", 'NUM_PEDIDO "0000" é rejeitado');
assert.equal(normalizeUltraFv3OrderNumber(undefined), "", "NUM_PEDIDO ausente é rejeitado");
assert.equal(normalizeUltraFv3OrderNumber(3812), "3812", "NUM_PEDIDO 3812 é aceito");

const seller = { sellerErpCode: "7057" };
assert.deepEqual(resolveSalesmenOrderContext({ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }, seller), { numeroPedido: "3812", operador: 45, codVendedor: 7057, selectedPath: "body" });
assert.equal(resolveSalesmenOrderContext({ data: { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: "3812" } }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 0, OPERADOR: 1, NUMERO_PEDIDO: 0 }, { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }] }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ SALESMAN: [{ CODVENDEDOR: 0, OPERADOR: 1 }, { CODVENDEDOR: 7057, OPERADOR: 45 }], NUMERO_PEDIDO: 3812 }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 9999, OPERADOR: 1, NUMERO_PEDIDO: 3812 }, { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3813 }] }, seller).numeroPedido, "3813");
assert.throws(() => resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 0 }] }, seller), /erp_invalid_order_number/);
assert.throws(() => resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }, { CODVENDEDOR: 7057, OPERADOR: 46, NUMERO_PEDIDO: 3813 }] }, seller), /erp_ambiguous_salesman_order_number/);

const basePayload = {
  PEDIDO_ID: null,
  PARCEIRO: 4000,
  NUM_PEDIDO: "3812",
  DATA_PEDIDO: "13.07.2026",
  DATA_PREV_ENTREGA: "14.07.2026",
  VENDEDOR: 7057,
  OPERADOR: 45,
  CODOPER: 1,
  CODFILIAL: 1,
  TABELA_PRECO: 1,
  CODCONDREC: 1,
  FORMA: 1,
  VALOR_BRUTO: 10,
  VALOR_ACRESCIMO: 0,
  VALOR_DESCONTO: 0,
  VALOR_LIQUIDO: 10,
  QTD_PEDIDO: 1,
  PRIORIDADE: 9,
  TIPO_MOVIMENTO: "PEDIDO",
  PEDIDO_ID_IMPORTACAO: randomUUID(),
  DATA_CANCELAMENTO: "",
  OBS_PEDIDO: "",
  OBSERVACAO_INTERNA: null,
  ITENS: [{ PEDIDO_ID: null, ITEM: 1, CODPRODUTO: 273, CODPRODUTO_CLAS: 1, QTD_PEDIDO: 1, PRECO: 10, PRECO_LISTA: 10, VALOR_BRUTO: 10, VALOR_ACRESCIMO: 0, VALOR_DESCONTO: 0, VALOR_LIQUIDO: 10, DESCRICAO_UNMED: "SACO", UND_MEDIDA: "SC", QTD_UNMED: 1, PESO_EMBALAGEM: 0, PESO_PRODUTO: null, MOTIVO_CANCELAMENTO: "", OBS: "", VALOR_ICMS_DESON: 0, ICMS_DESON_DESCTO_FINANCEIRO: "N" }],
};
assert.deepEqual(validateUltraFv3OrderPayload(basePayload), []);
assert(validateUltraFv3OrderPayload({ ...basePayload, NUM_PEDIDO: "0" }).some((error) => /maior que zero/.test(error)));
assert(validateUltraFv3OrderPayload({ ...basePayload, NUM_PEDIDO: 0 } as any).some((error) => /deve ser string/.test(error)));
assert(validateUltraFv3OrderPayload({ ...basePayload, NUM_PEDIDO: "0000" }).some((error) => /maior que zero/.test(error)));
assert.notEqual(basePayload.NUM_PEDIDO, basePayload.PEDIDO_ID_IMPORTACAO, "pedidoIdImportacao permanece UUID separado");
console.log("UltraFV3 order number parser smoke passed");
