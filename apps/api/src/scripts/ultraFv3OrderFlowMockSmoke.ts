import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const calls: string[] = [];
let lastOrderPayload: Record<string, unknown> | null = null;

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.method === "POST" && req.url === "/auth/login") {
    const body = await readBody(req);
    assert.equal(body.document, "123.456.789-01", "login deve enviar documento formatado sem expor senha em logs do teste");
    sendJson(res, 200, { token: "mock-token", expiresIn: 3600 });
    return;
  }
  if (req.method === "GET" && req.url === "/salesmen") {
    assert.equal(req.headers.authorization, "Bearer mock-token", "GET /salesmen deve ocorrer autenticado");
    sendJson(res, 200, { NUMERO_PEDIDO: 3657, SALESMAN: [{ CODVENDEDOR: 7057, OPERADOR: 45, NOME: "Vendedor Mock" }] });
    return;
  }
  if (req.method === "POST" && req.url === "/orders") {
    assert.equal(req.headers.authorization, "Bearer mock-token", "POST /orders deve ocorrer autenticado");
    lastOrderPayload = await readBody(req);
    sendJson(res, 200, { success: true, NUM_PEDIDO: lastOrderPayload.NUM_PEDIDO, status: "accepted" });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

process.env.ULTRAFV3_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.ULTRAFV3_USERNAME = "12345678901";
process.env.ULTRAFV3_PASSWORD = "secret";

try {
  const { ultraFv3Client } = await import("../services/ultraFv3Client.js");
  const { validateUltraFv3OrderPayload } = await import("../services/erpOrderService.js");
  const credentials = { username: "12345678901", password: "secret" };
  const salesmen = await ultraFv3Client.requestWithCredentials<{ NUMERO_PEDIDO: number }>("/salesmen", credentials, { correlationId: "mock-salesmen" });
  const pedidoIdImportacao = randomUUID();
  const payload = {
    PEDIDO_ID: null,
    PARCEIRO: 4000,
    NUM_PEDIDO: String(salesmen.NUMERO_PEDIDO),
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
    PEDIDO_ID_IMPORTACAO: pedidoIdImportacao,
    DATA_CANCELAMENTO: "",
    OBS_PEDIDO: "",
    OBSERVACAO_INTERNA: null,
    ITENS: [{ PEDIDO_ID: null, ITEM: 1, CODPRODUTO: 273, CODPRODUTO_CLAS: 1, QTD_PEDIDO: 1, PRECO: 10, PRECO_LISTA: 10, VALOR_BRUTO: 10, VALOR_ACRESCIMO: 0, VALOR_DESCONTO: 0, VALOR_LIQUIDO: 10, DESCRICAO_UNMED: "SACO", UND_MEDIDA: "SC", QTD_UNMED: 1, PESO_EMBALAGEM: 0, PESO_PRODUTO: null, MOTIVO_CANCELAMENTO: "", OBS: "", VALOR_ICMS_DESON: 0, ICMS_DESON_DESCTO_FINANCEIRO: "N" }],
  };
  assert.deepEqual(validateUltraFv3OrderPayload(payload), [], "payload mock deve cumprir contrato UltraFV3");
  await ultraFv3Client.requestWithCredentials("/orders", credentials, { method: "POST", body: payload, correlationId: pedidoIdImportacao });
  assert.deepEqual(calls, ["POST /auth/login", "GET /salesmen", "POST /orders"], "ordem esperada: login → salesmen → orders");
  assert(lastOrderPayload, "mock deve receber POST /orders");
  const receivedOrderPayload = lastOrderPayload as Record<string, unknown>;
  assert.equal(receivedOrderPayload.NUM_PEDIDO, "3657", "POST /orders deve receber NUM_PEDIDO do /salesmen");
  assert.equal(receivedOrderPayload.PEDIDO_ID_IMPORTACAO, pedidoIdImportacao, "PEDIDO_ID_IMPORTACAO deve ser UUID separado preservado");
  assert.notEqual(receivedOrderPayload.NUM_PEDIDO, receivedOrderPayload.PEDIDO_ID_IMPORTACAO, "NUM_PEDIDO e PEDIDO_ID_IMPORTACAO não podem ser iguais");
  assert.doesNotMatch(String(receivedOrderPayload.NUM_PEDIDO), /^PMR/i, "POST /orders não pode receber PMR como NUM_PEDIDO");

  const invalidPayload = { ...payload, NUM_PEDIDO: "PMRANWP4PFOFX7" };
  assert(validateUltraFv3OrderPayload(invalidPayload).some((error) => /PMR|string numérica/.test(error)), "NUM_PEDIDO inválido deve bloquear antes de /orders");
  console.log("UltraFV3 order flow mock smoke passed");
} finally {
  server.close();
}
