import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { createWhatsAppTestHarness } from "../services/whatsappConnection/whatsappTestHarness.js";
import { whatsappMessageIngestion } from "../services/whatsappMessages/whatsappMessageIngestion.js";
import { createMemoryWhatsAppMessageStore } from "../services/whatsappMessages/whatsappMessagesTestStore.js";

// Eventos de mensagem pelo webhook interno do Evolution (WhatsApp Fase B), com armazenamento em memória.
// Garante: rate limit próprio, 503 sem detalhes em falha e nenhum log com texto, legenda, nome do contato,
// número, JID, id da mensagem ou apikey. Só dados fictícios.
const harness = createWhatsAppTestHarness(prisma);
const { logs } = harness;
const memory = createMemoryWhatsAppMessageStore();
const originalStore = whatsappMessageIngestion.store;
whatsappMessageIngestion.store = memory.store;

const SECRET = "segredo-ficticio-webhook-b";
const INSTANCE = "crm-cccccccccccccccccccccccc";
const INSTANCE_TOKEN = "apikey-instancia-ficticia-b";
const CONTACT = "5511900000201";
const KEY_ID = "3EB0FICTICIOKEYID0001";
const TEXT = "Texto ficticio sigiloso";
const CAPTION = "Legenda ficticia sigilosa";
const PUSH_NAME = "Nome Ficticio Sigiloso";

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const post = async (body: unknown) => {
  const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/communications/evolution`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-crm-webhook-secret": SECRET },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const upsert = (id: string, message: unknown, fromMe = false) => ({
  event: "messages.upsert",
  instance: INSTANCE,
  data: { key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe, id }, pushName: PUSH_NAME, message, messageTimestamp: 1_794_000_000 },
  destination: "http://crm-api-internal:4000/webhooks/communications/evolution",
  date_time: "2026-11-07T12:00:00.000Z",
  sender: "5511900000001@s.whatsapp.net",
  server_url: "http://crm-evolution-api:8080",
  apikey: INSTANCE_TOKEN
});

try {
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionWebhookSecret = SECRET;
  memory.instances.set(INSTANCE, { userId: "seller-a", account: "5511900000001" });
  memory.phoneIndex.set(CONTACT, ["client-a"]);

  // 1) Gravação desligada: o evento de mensagem é aceito e ignorado, nada gravado.
  assert.deepEqual((await post(upsert(KEY_ID, { conversation: TEXT }))).json, { status: "ignored" });
  assert.equal(memory.messages.length, 0);

  // 2) Ligada: gravada; reentrega é duplicada.
  env.whatsappEvolutionMessagesEnabled = true;
  const first = await post(upsert(KEY_ID, { conversation: TEXT }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { status: "stored" });
  assert.deepEqual((await post(upsert(KEY_ID, { conversation: TEXT }))).json, { status: "duplicate" });
  assert.equal(memory.messages.length, 1);
  assert.deepEqual((await post(upsert(`${KEY_ID}-IMG`, { imageMessage: { caption: CAPTION, url: "https://mmg.invalid/x" } }))).json, { status: "stored" });
  assert.deepEqual((await post({ event: "messages.delete", instance: INSTANCE, data: { remoteJid: `${CONTACT}@s.whatsapp.net`, id: KEY_ID, status: "DELETED" } })).json, { status: "updated" });

  // 3) Instância desconhecida: 202 (o Evolution não repete), nada gravado.
  assert.equal((await post({ ...upsert("OUTRO-ID", { conversation: TEXT }), instance: "crm-desconhecida" })).status, 202);

  // 4) Rajada (reconexão): o limite do webhook do Evolution é próprio; o de comunicações (120) seria estourado.
  const burst = await Promise.all(Array.from({ length: 150 }, (_, index) => post(upsert(`RAJADA-${index}`, { conversation: TEXT }))));
  assert.equal(burst.filter((item) => item.status === 429).length, 0, "nenhum 429 na rajada");
  assert.equal(burst.every((item) => item.status === 200), true);
  const routeSource = readFileSync(new URL("./whatsappEvolutionWebhookRoutes.ts", import.meta.url), "utf8");
  assert.match(routeSource, /whatsappEvolutionWebhookRateLimit/);
  assert.doesNotMatch(routeSource, /communicationsWebhookRateLimit/, "não divide o limite com o webhook da Meta");

  // 5) Falha ao gravar: 503 sem detalhes (o Evolution repete) e log só com nome e código do erro.
  memory.failNextWith(Object.assign(new Error(`falha com ${TEXT} ${CONTACT} ${PUSH_NAME}`), { name: "PrismaClientKnownRequestError", code: "P2024" }));
  const failed = await post(upsert("FALHA-ID", { conversation: TEXT }));
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.json, { message: "Temporarily unavailable" });

  // 6) Logs: há registro de cada evento, sem nenhum dado da mensagem.
  const logged = logs.join("\n");
  assert.match(logged, /\[whatsapp\] message event/);
  assert.match(logged, /"status":"stored"/);
  assert.match(logged, /\[whatsapp\] message event failed/);
  assert.match(logged, /P2024/);
  for (const forbidden of [TEXT, CAPTION, PUSH_NAME, CONTACT, "900000201", `${CONTACT}@s.whatsapp.net`, "s.whatsapp.net", KEY_ID, "FALHA-ID", "RAJADA-", INSTANCE_TOKEN, SECRET, "mmg.invalid", "5511900000001"]) {
    assert.equal(logged.includes(forbidden), false, `log sem ${forbidden}`);
  }

  console.log("whatsappEvolutionMessages.http.test.ts: ok");
} finally {
  whatsappMessageIngestion.store = originalStore;
  harness.restoreConsole();
  server.close();
}
