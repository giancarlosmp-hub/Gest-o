import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { createWhatsAppTestHarness } from "../services/whatsappConnection/whatsappTestHarness.js";
import { isValidWebhookSecret } from "./whatsappEvolutionWebhookRoutes.js";

// Webhook interno do Evolution (WhatsApp Fase A). Prisma em memória, Evolution falso, dados fictícios.
// Garante também que o corpo (com o apikey da instância e o número) nunca vai para log.
const harness = createWhatsAppTestHarness(prisma);
const { connections, evolution, logs } = harness;
const INSTANCE_TOKEN = "apikey-instancia-ficticia-7f3a";
const SECRET = "segredo-ficticio-webhook";

const evolutionServer = createServer(evolution.handler);
evolutionServer.listen(0, "127.0.0.1");
await once(evolutionServer, "listening");
const evolutionAddress = evolutionServer.address();
assert(evolutionAddress && typeof evolutionAddress === "object");
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const post = async (body: unknown, headers: Record<string, string> = { "x-crm-webhook-secret": SECRET }, path = "/webhooks/communications/evolution") => {
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};
// Formato do Evolution v2.3.7: event, instance, data, ..., apikey (token da instância).
const event = (instance: string, type: string, data: Record<string, unknown>) => ({
  event: type,
  instance,
  data: { instance, ...data },
  destination: "http://crm-api-internal:4000/webhooks/communications/evolution",
  date_time: "2026-11-06T12:00:00.000Z",
  sender: data.wuid ?? null,
  server_url: "http://crm-evolution-api:8080",
  apikey: INSTANCE_TOKEN
});
const seedPending = (userId: string, instanceName: string, expectedPhone: string) => {
  const now = new Date();
  connections.push({
    id: `conn-${userId}`, userId, tenantId: null, provider: "evolution", instanceName, expectedPhone, connectedPhone: null,
    status: "PENDING_QR", statusReason: null, connectedAt: null, disconnectedAt: null, disconnectedById: null, lastSeenAt: null,
    createdAt: now, updatedAt: now
  });
  evolution.instances.set(instanceName, { state: "connecting", ownerJid: null });
};
const rowOf = (userId: string) => connections.find((row) => row.userId === userId)!;

try {
  // 0) Comparação do segredo.
  assert.equal(isValidWebhookSecret(SECRET, SECRET), true);
  assert.equal(isValidWebhookSecret("outro", SECRET), false);
  assert.equal(isValidWebhookSecret(`${SECRET}x`, SECRET), false, "tamanho diferente não quebra a comparação");
  assert.equal(isValidWebhookSecret(undefined, SECRET), false);
  assert.equal(isValidWebhookSecret("", ""), false, "sem segredo configurado nada passa");

  seedPending("seller-a", "crm-aaaaaaaaaaaaaaaaaaaaaaaa", "5511900000001");
  seedPending("seller-b", "crm-bbbbbbbbbbbbbbbbbbbbbbbb", "5521900000002");
  const openA = event("crm-aaaaaaaaaaaaaaaaaaaaaaaa", "connection.update", { state: "open", statusReason: 200, wuid: "5511900000001@s.whatsapp.net", profileName: "Perfil Ficticio" });

  // 1) Desligado: 404, nada muda.
  assert.equal((await post(openA)).status, 404);
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionBaseUrl = `http://127.0.0.1:${evolutionAddress.port}`;
  env.whatsappEvolutionApiKey = "chave-ficticia-evolution";
  env.whatsappEvolutionWebhookSecret = SECRET;

  // 2) Veio pelo proxy (domínio público): 404 mesmo com o segredo certo.
  for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
    assert.equal((await post(openA, { "x-crm-webhook-secret": SECRET, [header]: "203.0.113.10" })).status, 404, header);
  }
  // 3) Segredo ausente ou errado: 401.
  assert.equal((await post(openA, {})).status, 401);
  assert.equal((await post(openA, { "x-crm-webhook-secret": "errado" })).status, 401);
  assert.equal(rowOf("seller-a").status, "PENDING_QR", "nada mudou antes do segredo");

  // 4) Corpo inválido ou grande demais.
  assert.equal((await post("{nao-e-json")).status, 400);
  assert.equal((await post({ event: "connection.update", padding: "x".repeat(70 * 1024) })).status, 413);

  // 5) QR e outros eventos: ignorados, nada gravado.
  const qr = await post(event("crm-aaaaaaaaaaaaaaaaaaaaaaaa", "qrcode.updated", { qrcode: { base64: harness.FAKE_QR, code: "x" } }));
  assert.deepEqual(qr.json, { status: "ignored" });
  assert.deepEqual((await post(event("crm-aaaaaaaaaaaaaaaaaaaaaaaa", "messages.upsert", { message: { conversation: "texto ficticio" } }))).json, { status: "ignored" });
  assert.doesNotMatch(JSON.stringify(connections), /data:image|texto ficticio/);

  // 6) Instância desconhecida: 202, nada gravado.
  assert.equal((await post(event("crm-desconhecida", "connection.update", { state: "open", wuid: "5511900000001@s.whatsapp.net" }))).status, 202);

  // 7) Conectou com o número cadastrado (também pelo prefixo /api): CONNECTED.
  const opened = await post(openA, undefined, "/api/webhooks/communications/evolution");
  assert.equal(opened.status, 200);
  assert.equal(rowOf("seller-a").status, "CONNECTED");
  assert.equal(rowOf("seller-a").connectedPhone, "5511900000001");

  // 8) Número diferente: recusa, apaga a instância e não grava o número lido.
  const openWrong = event("crm-bbbbbbbbbbbbbbbbbbbbbbbb", "CONNECTION_UPDATE", { state: "open", wuid: "5541900000099@s.whatsapp.net" });
  assert.equal((await post(openWrong)).status, 200);
  assert.equal(rowOf("seller-b").status, "REJECTED_WRONG_NUMBER");
  assert.equal(rowOf("seller-b").connectedPhone, null);
  assert.equal(evolution.instances.has("crm-bbbbbbbbbbbbbbbbbbbbbbbb"), false);
  assert.doesNotMatch(JSON.stringify(connections), /900000099/);
  // O "close" que o próprio logout gera não sobrescreve a recusa.
  await post(event("crm-bbbbbbbbbbbbbbbbbbbbbbbb", "connection.update", { state: "close", statusReason: 401 }));
  assert.equal(rowOf("seller-b").status, "REJECTED_WRONG_NUMBER");

  // 9) Sessão encerrada no celular: DISCONNECTED.
  await post(event("crm-aaaaaaaaaaaaaaaaaaaaaaaa", "connection.update", { state: "close", statusReason: 401 }));
  assert.equal(rowOf("seller-a").status, "DISCONNECTED");
  assert.equal(rowOf("seller-a").statusReason, "session_closed");
  assert.equal(rowOf("seller-a").connectedPhone, null);

  // 10) Falha interna ao processar: o handler de erro registra o corpo como redigido.
  seedPending("seller-d", "crm-dddddddddddddddddddddddd", "5531980000004");
  const originalUpdate = (prisma as any).whatsAppConnection.update;
  (prisma as any).whatsAppConnection.update = async () => {
    throw new Error("falha ficticia de banco");
  };
  const failed = await post(event("crm-dddddddddddddddddddddddd", "connection.update", { state: "open", wuid: "5531980000004@s.whatsapp.net" }));
  (prisma as any).whatsAppConnection.update = originalUpdate;
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.json, { message: "Webhook processing error" }, "resposta sem detalhes");
  const logged = logs.join("\n");
  assert.match(logged, /falha ficticia de banco/, "o erro foi de fato registrado");
  assert.match(logged, /raw-body-redacted/, "o corpo aparece só como redigido");

  // 11) Nenhum log traz o corpo, o apikey da instância, o segredo, o número ou o QR.
  for (const forbidden of [INSTANCE_TOKEN, SECRET, "chave-ficticia-evolution", "900000001", "900000099", "80000004", "data:image", "Perfil Ficticio", "texto ficticio", "padding"]) {
    assert.equal(logged.includes(forbidden), false, `log sem ${forbidden}`);
  }

  console.log("whatsappEvolutionWebhook.http.test.ts: ok");
} finally {
  harness.restoreConsole();
  server.close();
  evolutionServer.close();
}
