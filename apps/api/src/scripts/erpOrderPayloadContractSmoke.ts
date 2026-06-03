import assert from "node:assert/strict";
import { validateUltraFv3OrderPayload, type UltraFv3OrderPayload } from "../services/erpOrderService.js";

const payload: UltraFv3OrderPayload = {
  PEDIDO_ID_IMPORTACAO: "11111111-1111-4111-8111-111111111111",
  PARCEIRO: "123456",
  NUM_PEDIDO: "987654",
  DATA_PEDIDO: "03.06.2026",
  DATA_PREV_ENTREGA: "03.06.2026",
  VENDEDOR: 2585,
  OPERADOR: 16,
  CODOPER: "1",
  CODFILIAL: "1",
  TABELA_PRECO: "1",
  CODCONDREC: "30",
  FORMA: "1",
  VALOR_BRUTO: 100,
  VALOR_DESCONTO: 0,
  VALOR_LIQUIDO: 100,
  QTD_PEDIDO: 2,
  TIPO_MOVIMENTO: "PEDIDO",
  ITENS: [
    {
      CODPRODUTO: "1000",
      CODPRODUTO_CLAS: "1000-01",
      ITEM: 1,
      QTD_PEDIDO: 2,
      PRECO: 50,
      PRECO_LISTA: 50,
      VALOR_BRUTO: 100,
      VALOR_DESCONTO: 0,
      VALOR_LIQUIDO: 100,
      DESCRICAO_UNMED: "UN",
      UND_MEDIDA: "UN",
      QTD_UNMED: 1,
      MOTIVO_CANCELAMENTO: "",
      OBS: "",
      ICMS_DESON_DESCTO_FINANCEIRO: "N",
    },
  ],
};

for (const key of ["VENDEDOR", "CODFILIAL", "CODOPER", "FORMA", "CODCONDREC"] as const) {
  assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `payload final deve conter ${key}`);
}

for (const key of ["CODVENDEDOR", "FILIAL", "OPERACAO", "FORMA_PAGAMENTO", "CONDICAO_RECEBIMENTO"] as const) {
  assert.equal(Object.prototype.hasOwnProperty.call(payload, key), false, `payload final não deve conter ${key}`);
}

assert.deepEqual(validateUltraFv3OrderPayload(payload), []);
assert.ok(
  validateUltraFv3OrderPayload({ ...payload, CODVENDEDOR: 2585 }).some((error) => error.includes("CODVENDEDOR")),
  "validação deve rejeitar CODVENDEDOR no POST /orders",
);

console.log("UltraFV3 /orders payload contract smoke passed");
