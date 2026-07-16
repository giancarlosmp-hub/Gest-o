import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { collectUltraFv3OrderIdentifierHits, normalizeUltraFv3OrderNumber, resolveSalesmenOrderContext, sanitizeErpOrderPayload, validateUltraFv3OrderPayload } from "../services/erpOrderService.js";

assert.equal(normalizeUltraFv3OrderNumber("0"), "", 'NUM_PEDIDO "0" é rejeitado');
assert.equal(normalizeUltraFv3OrderNumber(0), "", "NUM_PEDIDO 0 numérico é rejeitado");
assert.equal(normalizeUltraFv3OrderNumber("0000"), "", 'NUM_PEDIDO "0000" é rejeitado');
assert.equal(normalizeUltraFv3OrderNumber(undefined), "", "NUM_PEDIDO ausente é rejeitado");
assert.equal(normalizeUltraFv3OrderNumber(3812), "3812", "NUM_PEDIDO 3812 é aceito");


const bootstrapSource = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
assert.match(bootstrapSource, /import \{ ensureErpOrderNumberSequence \} from "\.\.\/services\/erpOrderNumberSequenceSetup\.js"/, "bootstrap deve importar o setup da sequence diretamente do service compilado");
assert.doesNotMatch(bootstrapSource, /npm run erp:ensure-order-sequence|tsx src\/scripts\/ensureErpOrderNumberSequence|node src\//, "bootstrap não pode chamar npm/tsx/src para setup da sequence");
assert.match(bootstrapSource, /runStep\("npm run prisma:migrate[\s\S]*await ensureErpOrderNumberSequence\(\)[\s\S]*validateDatabaseHealth/, "bootstrap deve executar db push, depois setup da sequence, antes de validar/abrir servidor");
const sequenceSetupSource = readFileSync(new URL("../services/erpOrderNumberSequenceSetup.ts", import.meta.url), "utf8");
assert.match(sequenceSetupSource, /export async function ensureErpOrderNumberSequence/, "setup da sequence deve ser função reutilizável sem efeito colateral no import");
const sequenceCliSource = readFileSync(new URL("./ensureErpOrderNumberSequence.ts", import.meta.url), "utf8");
assert.match(sequenceCliSource, /pathToFileURL\(process\.argv\[1\]\)/, "CLI manual deve ter guard ESM para não executar ao ser importada");

const sequenceServiceSource = readFileSync(new URL("../services/erpOrderNumberSequenceService.ts", import.meta.url), "utf8");
assert.match(sequenceServiceSource, /ERP_ORDER_NUMBER_SEQUENCE_START = 900_001/, "primeiro número da sequência CRM deve ser 900001");
assert.match(sequenceServiceSource, /nextval\('erp_order_number_seq'\)/, "reservas devem usar PostgreSQL sequence");
assert.doesNotMatch(sequenceServiceSource, /CREATE SEQUENCE|ALTER SEQUENCE|setval/i, "runtime não deve criar nem reinicializar a sequence");
const sequenceMigrationSource = readFileSync(new URL("../../prisma/migrations/20260716120000_add_erp_order_number_sequence/migration.sql", import.meta.url), "utf8");
assert.match(sequenceMigrationSource, /START WITH 900001/, "migration deve configurar primeira reserva como 900001");
assert.match(sequenceMigrationSource, /to_regclass\('public\."ErpOrderSync"'\)/, "migration deve consultar histórico somente se ErpOrderSync existir");
assert.match(sequenceMigrationSource, /MAXVALUE 999999999999999/, "sequence deve respeitar o limite de 15 dígitos");
assert.match(sequenceMigrationSource, /"numPedido" ~ '\^\[1-9\]\[0-9\]\{0,14\}\$'/, "históricos PMR/0/UUID devem ser ignorados antes de cast numérico");
assert.match(sequenceMigrationSource, /GREATEST\(900000, COALESCE\(max_reserved, 900000\), current_effective_last_value\)/, "migration nunca deve reduzir sequence já avançada");
assert.match(sequenceMigrationSource, /setval\('public\.erp_order_number_seq', desired_last_value, true\)/, "setval true deve fazer o próximo nextval retornar desired_last_value + 1");

const seller = { sellerErpCode: "7057" };
assert.deepEqual(resolveSalesmenOrderContext({ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }, seller), { numeroPedido: "3812", operador: 45, codVendedor: 7057, selectedPath: "body" });
assert.equal(resolveSalesmenOrderContext({ data: { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: "3812" } }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 0, OPERADOR: 1, NUMERO_PEDIDO: 0 }, { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }] }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ SALESMAN: [{ CODVENDEDOR: 0, OPERADOR: 1 }, { CODVENDEDOR: 7057, OPERADOR: 45 }], NUMERO_PEDIDO: 3812 }, seller).numeroPedido, "3812");
assert.equal(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 9999, OPERADOR: 1, NUMERO_PEDIDO: 3812 }, { CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3813 }] }, seller).numeroPedido, "3813");
assert.deepEqual(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 0 }] }, seller), { numeroPedido: "", operador: 45, codVendedor: 7057, selectedPath: "body.data[0]" }, "NUMERO_PEDIDO zero em /salesmen não bloqueia resolução de operador");
assert.deepEqual(resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 7057, OPERADOR: 45 }] }, seller), { numeroPedido: "", operador: 45, codVendedor: 7057, selectedPath: "body.data[0]" }, "ausência de NUMERO_PEDIDO em /salesmen não bloqueia resolução de operador");
assert.throws(() => resolveSalesmenOrderContext({ data: [{ CODVENDEDOR: 7057, OPERADOR: 45, NUMERO_PEDIDO: 3812 }, { CODVENDEDOR: 7057, OPERADOR: 46, NUMERO_PEDIDO: 3813 }] }, seller), /erp_ambiguous_salesman/);

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

const protocolHits = collectUltraFv3OrderIdentifierHits({
  data: {
    PEDIDO_ID: 6167,
    NUM_PEDIDO: "0",
    nested: { ORDERNUMBER: "3811", SEQUENCIA: 10 },
  },
});
assert(protocolHits.some((hit) => hit.path === "$.data.PEDIDO_ID" && hit.value === "6167"), "diagnóstico deve listar PEDIDO_ID como identificador encontrado");
assert(protocolHits.some((hit) => hit.field === "ORDERNUMBER" && hit.value === "3811"), "diagnóstico deve listar campos ORDER/NUMERO/SEQUENCIA sem classificar automaticamente");

const sanitized = JSON.stringify(sanitizeErpOrderPayload({
  SALESMAN: [{ CODVENDEDOR: 7057, OPERADOR: 45, NOME: "IZA MARIA COMPLETA", SENHA: "1234" }],
  cliente: { CNPJ: "12.345.678/0001-90", email: "cliente@example.com" },
  Authorization: "Bearer token-completo-ultra",
}));
assert.doesNotMatch(sanitized, /"SENHA":"1234"/, "sanitização não pode conter SENHA em claro");
assert.doesNotMatch(sanitized, /12\.345\.678\/0001-90/, "sanitização não pode conter CNPJ completo");
assert.doesNotMatch(sanitized, /token-completo-ultra/, "sanitização não pode conter token completo");
assert.doesNotMatch(sanitized, /IZA MARIA COMPLETA/, "sanitização não pode conter nome completo de vendedor");
console.log("UltraFV3 order number parser smoke passed");
