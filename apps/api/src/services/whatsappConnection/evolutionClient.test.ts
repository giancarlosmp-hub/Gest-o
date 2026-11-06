import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { EVOLUTION_WEBHOOK_SECRET_HEADER, EVOLUTION_WEBHOOK_URL } from "./config.js";
import { EvolutionClient, EvolutionUnavailableError, pickQrDataUrl } from "./evolutionClient.js";

// Cliente da Evolution API contra um Evolution falso em localhost. Chave, segredo e QR fictícios.
type Recorded = { method: string; url: string; headers: IncomingMessage["headers"]; body: any };
const recorded: Recorded[] = [];
const FAKE_QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let nextResponse: { status: number; body: unknown; delayMs?: number } = { status: 200, body: {} };

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  recorded.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
  const { status, body, delayMs } = nextResponse;
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const client = new EvolutionClient({
  baseUrl: `http://127.0.0.1:${address.port}/`,
  apiKey: "chave-ficticia",
  webhookSecret: "segredo-ficticio",
  timeoutMs: 300,
  createTimeoutMs: 300
});
const respond = (status: number, body: unknown, delayMs?: number) => {
  nextResponse = { status, body, delayMs };
};
const last = () => recorded[recorded.length - 1];

try {
  // 1) Criação: QR devolvido, webhook só de conexão no alias interno, segredo no header, sem histórico.
  respond(201, { instance: { instanceName: "crm-ficticio", status: "connecting" }, hash: "token-ficticio", qrcode: { base64: FAKE_QR, code: "x" } });
  const created = await client.createInstance("crm-ficticio");
  assert.equal(created.qrDataUrl, FAKE_QR);
  const create = last();
  assert.equal(create.method, "POST");
  assert.equal(create.url, "/instance/create");
  assert.equal(create.headers.apikey, "chave-ficticia");
  assert.equal(create.body.instanceName, "crm-ficticio");
  assert.equal(create.body.integration, "WHATSAPP-BAILEYS");
  assert.equal(create.body.qrcode, true);
  assert.equal(create.body.syncFullHistory, false, "sem sincronizar histórico");
  assert.equal(create.body.groupsIgnore, true);
  assert.equal(create.body.readMessages, false);
  assert.deepEqual(create.body.webhook, {
    enabled: true,
    url: EVOLUTION_WEBHOOK_URL,
    byEvents: false,
    base64: false,
    headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: "segredo-ficticio" },
    events: ["CONNECTION_UPDATE"]
  });
  assert.equal(EVOLUTION_WEBHOOK_URL, "http://crm-api-internal:4000/webhooks/communications/evolution", "alias interno, nunca domínio público");
  assert.doesNotMatch(JSON.stringify(create.body), /MESSAGES|CONTACTS|CHATS|SEND_MESSAGE/, "nenhum evento de mensagem");

  // 2) Connect: QR, conectado, inexistente (404 e 400 "does not exist").
  respond(200, { pairingCode: null, code: "x", base64: FAKE_QR, count: 1 });
  assert.deepEqual(await client.connect("crm-ficticio"), { kind: "qr", qrDataUrl: FAKE_QR });
  assert.equal(last().url, "/instance/connect/crm-ficticio");
  respond(200, { instance: { instanceName: "crm-ficticio", state: "open" } });
  assert.deepEqual(await client.connect("crm-ficticio"), { kind: "open" });
  respond(404, { status: 404, error: "Not Found", response: { message: ['The "crm-ficticio" instance does not exist'] } });
  assert.deepEqual(await client.connect("crm-ficticio"), { kind: "not_found" });
  respond(400, { response: { message: ['The "crm-ficticio" instance does not exist'] } });
  assert.deepEqual(await client.connect("crm-ficticio"), { kind: "not_found" });

  // 3) Estado e número conectado.
  respond(200, { instance: { instanceName: "crm-ficticio", state: "close" } });
  assert.equal(await client.connectionState("crm-ficticio"), "close");
  respond(200, [{ name: "crm-ficticio", ownerJid: "5511900000001@s.whatsapp.net", connectionStatus: "open" }]);
  assert.equal(await client.ownerJid("crm-ficticio"), "5511900000001@s.whatsapp.net");
  assert.equal(last().url, "/instance/fetchInstances?instanceName=crm-ficticio");
  respond(200, []);
  assert.equal(await client.ownerJid("crm-ficticio"), null);

  // 4) Apagar: sucesso e inexistente são aceitos; outro 4xx não.
  respond(200, { status: "SUCCESS" });
  await client.deleteInstance("crm-ficticio");
  assert.equal(last().method, "DELETE");
  assert.equal(last().url, "/instance/delete/crm-ficticio");
  respond(404, { response: { message: ['The "crm-ficticio" instance does not exist'] } });
  await client.deleteInstance("crm-ficticio");
  respond(400, { response: { message: ["outro erro"] } });
  await assert.rejects(client.deleteInstance("crm-ficticio"), EvolutionUnavailableError);

  // 5) Indisponível: chave errada, erro 5xx, timeout e rede.
  respond(401, { error: "Unauthorized" });
  await assert.rejects(client.connect("crm-ficticio"), (error: unknown) => error instanceof EvolutionUnavailableError && error.reason === "unauthorized");
  respond(500, {});
  await assert.rejects(client.connectionState("crm-ficticio"), (error: unknown) => error instanceof EvolutionUnavailableError && error.reason === "http_500");
  respond(200, {}, 1_000);
  await assert.rejects(client.connect("crm-ficticio"), (error: unknown) => error instanceof EvolutionUnavailableError && error.reason === "timeout");
  const offline = new EvolutionClient({ baseUrl: "http://127.0.0.1:1", apiKey: "x", webhookSecret: "y", timeoutMs: 300 });
  await assert.rejects(offline.connect("crm-ficticio"), (error: unknown) => error instanceof EvolutionUnavailableError && error.reason === "network");

  // 6) QR: só PNG em data URL.
  assert.equal(pickQrDataUrl({ base64: FAKE_QR }), FAKE_QR);
  assert.equal(pickQrDataUrl({ base64: "javascript:alert(1)" }), null);
  assert.equal(pickQrDataUrl({ base64: "data:text/html;base64,PGI+" }), null);
  assert.equal(pickQrDataUrl({ base64: `data:image/png;base64,${"A".repeat(70_000)}` }), null);
  assert.equal(pickQrDataUrl(null), null);

  // 7) O cliente não tem nenhum método de envio.
  const methods = Object.getOwnPropertyNames(EvolutionClient.prototype);
  assert.deepEqual(methods.filter((name) => /send|message|text|media/i.test(name)), []);

  console.log("evolutionClient.test.ts: ok");
} finally {
  server.close();
}
