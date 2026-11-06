import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppTestHarness } from "../services/whatsappConnection/whatsappTestHarness.js";

// WhatsApp Fase A: rotas de conexão por QR. Prisma em memória, Evolution falso em localhost.
// Só dados fictícios: números 55 + DDD + 90000-000N, chave e segredo inventados.
const harness = createWhatsAppTestHarness(prisma);
const { users, connections, evolution, logs } = harness;

const evolutionServer = createServer(evolution.handler);
evolutionServer.listen(0, "127.0.0.1");
await once(evolutionServer, "listening");
const evolutionAddress = evolutionServer.address();
assert(evolutionAddress && typeof evolutionAddress === "object");

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const call = async (method: string, path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: user.email, role: user.role });
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // 404 padrão do Express (HTML)
  }
  return { status: response.status, json };
};
const rowOf = (userId: string) => connections.find((row) => row.userId === userId);

try {
  // 1) Desligado por padrão: o cartão some e as ações respondem 404.
  assert.equal(env.whatsappEvolutionEnabled, false, "WHATSAPP_EVOLUTION_ENABLED nasce false");
  assert.deepEqual((await call("GET", "/whatsapp/connection", "seller-a")).json, { enabled: false });
  assert.equal((await call("POST", "/whatsapp/connection", "seller-a")).status, 404);
  assert.equal((await call("DELETE", "/whatsapp/connection", "seller-a")).status, 404);
  assert.deepEqual((await call("GET", "/whatsapp/connections", "manager-a")).json, { enabled: false, data: [] });
  assert.equal((await call("GET", "/api/whatsapp/connection", "seller-a")).status, 200, "também com o prefixo /api");
  env.whatsappEvolutionEnabled = true;
  assert.deepEqual((await call("GET", "/whatsapp/connection", "seller-a")).json, { enabled: false }, "exige também COMMUNICATIONS_ENABLED");
  env.communicationsEnabled = true;

  // 2) Ligado sem chave/segredo: 503 sem chamar o Evolution.
  const notConfigured = await call("POST", "/whatsapp/connection", "seller-a");
  assert.equal(notConfigured.status, 503);
  assert.equal(notConfigured.json.code, "not_configured");
  assert.equal(evolution.requests.length, 0);
  env.whatsappEvolutionBaseUrl = `http://127.0.0.1:${evolutionAddress.port}`;
  env.whatsappEvolutionApiKey = "chave-ficticia-evolution";
  env.whatsappEvolutionWebhookSecret = "segredo-ficticio-webhook";

  // 3) Sem celular cadastrado não conecta.
  const noPhone = await call("POST", "/whatsapp/connection", "seller-nophone");
  assert.equal(noPhone.status, 422);
  assert.equal(noPhone.json.code, "phone_missing");

  // 4) Conectar: instância com nome opaco, QR devolvido e nunca gravado.
  const started = await call("POST", "/whatsapp/connection", "seller-a");
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.status, "PENDING_QR");
  assert.equal(started.json.qrDataUrl, harness.FAKE_QR);
  assert.equal(started.json.expectedPhone, "(11) 90000-0001");
  const rowA = rowOf("seller-a")!;
  assert.match(rowA.instanceName, /^crm-[0-9a-f]{24}$/, "nome opaco");
  assert.doesNotMatch(rowA.instanceName, /seller|900000/, "sem id nem telefone no nome");
  assert.equal(rowA.expectedPhone, "5511900000001");
  assert.equal(rowA.connectedPhone, null);
  assert.doesNotMatch(JSON.stringify(connections), /data:image|base64/, "QR nunca é gravado");
  const createRequest = evolution.requests.find((request) => request.url === "/instance/create")!;
  assert.equal(createRequest.headers.apikey, "chave-ficticia-evolution");
  assert.equal(createRequest.body.syncFullHistory, false);
  assert.equal(createRequest.body.webhook.url, "http://crm-api-internal:4000/webhooks/communications/evolution");
  assert.deepEqual(createRequest.body.webhook.events, ["CONNECTION_UPDATE"]);

  // 5) Consulta enquanto aguarda: QR atual; conectar de novo reaproveita a mesma instância.
  const pending = await call("GET", "/whatsapp/connection", "seller-a");
  assert.equal(pending.json.status, "PENDING_QR");
  assert.equal(pending.json.qrDataUrl, harness.FAKE_QR);
  assert.equal((await call("POST", "/whatsapp/connection", "seller-a")).json.status, "PENDING_QR");
  assert.equal(rowOf("seller-a")!.instanceName, rowA.instanceName, "mesma instância");

  // 6) Leu o QR com o número cadastrado: CONNECTED.
  evolution.open(rowA.instanceName, "5511900000001:3@s.whatsapp.net");
  const connected = await call("GET", "/whatsapp/connection", "seller-a");
  assert.equal(connected.json.status, "CONNECTED");
  assert.equal(connected.json.connectedPhone, "(11) 90000-0001");
  assert.equal(connected.json.qrDataUrl, null);
  assert.equal(rowOf("seller-a")!.connectedPhone, "5511900000001");
  assert.ok(rowOf("seller-a")!.connectedAt instanceof Date);
  assert.equal((await call("POST", "/whatsapp/connection", "seller-a")).json.code, "already_connected");

  // 7) Celular antigo de 8 dígitos no WhatsApp confere com o User.phone de 9 dígitos.
  const startedD = await call("POST", "/whatsapp/connection", "seller-d");
  assert.equal(startedD.json.status, "PENDING_QR");
  evolution.open(rowOf("seller-d")!.instanceName, "553180000004@s.whatsapp.net");
  assert.equal((await call("GET", "/whatsapp/connection", "seller-d")).json.status, "CONNECTED");

  // 8) Número diferente do cadastrado: recusa, desconecta e não grava o número lido.
  await call("POST", "/whatsapp/connection", "seller-b");
  const instanceB = rowOf("seller-b")!.instanceName;
  evolution.open(instanceB, "5541900000099@s.whatsapp.net");
  const rejected = await call("GET", "/whatsapp/connection", "seller-b");
  assert.equal(rejected.json.status, "REJECTED_WRONG_NUMBER");
  assert.equal(rejected.json.statusReason, "phone_mismatch");
  assert.equal(rejected.json.connectedPhone, null);
  assert.equal(evolution.instances.has(instanceB), false, "instância apagada (logout)");
  assert.doesNotMatch(JSON.stringify(connections), /900000099/, "número lido não é gravado");

  // 9) LID (sem número legível) também é recusado.
  await call("POST", "/whatsapp/connection", "seller-b");
  const instanceB2 = rowOf("seller-b")!.instanceName;
  assert.notEqual(instanceB2, instanceB, "nova tentativa usa nova instância");
  evolution.open(instanceB2, "123456789012345@lid");
  assert.equal((await call("GET", "/whatsapp/connection", "seller-b")).json.statusReason, "phone_unreadable");

  // 10) Mesmo número já conectado por outro usuário.
  const inUse = await call("POST", "/whatsapp/connection", "seller-c");
  assert.equal(inUse.status, 409);
  assert.equal(inUse.json.code, "phone_in_use");

  // 11) Diretor e gerente veem todos, com número mascarado; vendedor não.
  for (const viewer of ["manager-a", "director-a"]) {
    const list = await call("GET", "/whatsapp/connections", viewer);
    assert.equal(list.status, 200);
    const itemA = list.json.data.find((item: any) => item.userId === "seller-a");
    assert.equal(itemA.status, "CONNECTED");
    assert.equal(itemA.connectedPhone, "(11) 9****-0001");
    assert.equal(list.json.data.find((item: any) => item.userId === "seller-b").status, "REJECTED_WRONG_NUMBER");
  }
  assert.equal((await call("GET", "/whatsapp/connections", "seller-a")).status, 403);
  assert.equal((await call("DELETE", "/whatsapp/connections/seller-d", "seller-a")).status, 403, "vendedor não desconecta outro");

  // 12) Gerente desconecta um vendedor.
  const byManager = await call("DELETE", "/whatsapp/connections/seller-a", "manager-a");
  assert.equal(byManager.status, 200);
  assert.equal(byManager.json.status, "DISCONNECTED");
  assert.equal(rowOf("seller-a")!.disconnectedById, "manager-a");
  assert.equal(rowOf("seller-a")!.statusReason, "disconnected_by_manager");
  assert.equal(rowOf("seller-a")!.connectedPhone, null);
  assert.equal(evolution.instances.has(rowA.instanceName), false);
  assert.equal((await call("DELETE", "/whatsapp/connections/sem-conexao", "director-a")).status, 404);

  // 13) O próprio usuário desconecta.
  const own = await call("DELETE", "/whatsapp/connection", "seller-d");
  assert.equal(own.json.status, "DISCONNECTED");
  assert.equal(rowOf("seller-d")!.statusReason, "disconnected_by_user");

  // 14) Sessão encerrada pelo celular: a próxima consulta mostra DISCONNECTED.
  await call("POST", "/whatsapp/connection", "seller-a");
  evolution.open(rowOf("seller-a")!.instanceName, "5511900000001@s.whatsapp.net");
  assert.equal((await call("GET", "/whatsapp/connection", "seller-a")).json.status, "CONNECTED");
  evolution.close(rowOf("seller-a")!.instanceName);
  const closed = await call("GET", "/whatsapp/connection", "seller-a");
  assert.equal(closed.json.status, "DISCONNECTED");
  assert.equal(closed.json.statusReason, "session_closed");

  // 15) Evolution fora do ar: ações respondem 503, a consulta continua respondendo e o CRM segue.
  assert.equal((await call("POST", "/whatsapp/connection", "seller-a")).json.status, "PENDING_QR");
  evolution.down = true;
  const down = await call("POST", "/whatsapp/connection", "seller-a");
  assert.equal(down.status, 503);
  assert.equal(down.json.code, "evolution_unavailable");
  const ownWhileDown = await call("GET", "/whatsapp/connection", "seller-a");
  assert.equal(ownWhileDown.status, 200);
  assert.equal(ownWhileDown.json.serviceAvailable, false);
  assert.equal((await call("GET", "/whatsapp/connections", "manager-a")).status, 200, "lista não depende do Evolution");
  assert.equal((await call("DELETE", "/whatsapp/connection", "seller-a")).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
  evolution.down = false;

  // 16) Nenhuma rota de envio existe sob /whatsapp.
  for (const path of ["/whatsapp/send", "/whatsapp/messages", "/whatsapp/connection/send", "/whatsapp/message"]) {
    assert.equal((await call("POST", path, "director-a")).status, 404, `${path} não existe`);
  }
  assert.equal(evolution.requests.some((request) => /message|send|chat/i.test(request.url)), false, "nenhuma chamada de envio ao Evolution");

  // 17) Logs sem QR, número, chave ou segredo.
  const logged = logs.join("\n");
  for (const secret of ["data:image", "chave-ficticia-evolution", "segredo-ficticio-webhook", "900000001", "900000099", "80000004"]) {
    assert.equal(logged.includes(secret), false, `log sem ${secret}`);
  }

  console.log("whatsappConnection.http.test.ts: ok");
} finally {
  harness.restoreConsole();
  server.close();
  evolutionServer.close();
}
