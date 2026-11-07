import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { env } from "../../config/env.js";
import { EvolutionClient } from "../whatsappConnection/evolutionClient.js";
import { ensureInstanceWebhookEvents, reconcileWebhookSubscriptions, resetAppliedWebhookEventsForTests } from "./whatsappWebhookSubscriptions.js";

// Assinatura dos eventos nas instâncias já conectadas (WhatsApp Fase B), contra um Evolution falso.
// Instâncias, chave e segredo fictícios.

const calls: Array<{ url: string; body: any }> = [];
const missing = new Set<string>(["crm-sumiu"]);
let down = false;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const name = decodeURIComponent(req.url!.split("/").pop() || "");
  calls.push({ url: req.url!, body: raw ? JSON.parse(raw) : null });
  const send = (status: number, payload: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  if (down) return send(500, {});
  if (missing.has(name)) return send(404, { response: { message: [`The "${name}" instance does not exist`] } });
  return send(201, { webhook: { enabled: true } });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const clientFactory = () => new EvolutionClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "chave-ficticia", webhookSecret: "segredo-ficticio", timeoutMs: 500 });
const connections = [{ instanceName: "crm-aaaaaaaaaaaaaaaaaaaaaaaa" }, { instanceName: "crm-bbbbbbbbbbbbbbbbbbbbbbbb" }, { instanceName: "crm-sumiu" }];
const queried: any[] = [];
const db: any = { whatsAppConnection: { findMany: async (args: any) => { queried.push(args); return connections; } } };
const deps = { db, clientFactory, isReady: () => true };

try {
  // 1) Integração desligada ou sem configuração: nada é chamado.
  assert.equal(await ensureInstanceWebhookEvents("crm-aaaaaaaaaaaaaaaaaaaaaaaa", { ...deps, isReady: () => false }), "skipped");
  assert.equal(calls.length, 0);

  // 2) Fase B ligada: cada instância CONNECTED recebe as mensagens, numa lista explícita.
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionMessagesEnabled = true;
  const on = await reconcileWebhookSubscriptions(deps);
  assert.deepEqual(on, { instances: 3, updated: 2, unchanged: 0, notFound: 1, failed: 0, skipped: 0 });
  assert.deepEqual(queried[0], { where: { status: "CONNECTED" }, select: { instanceName: true } });
  assert.deepEqual(calls.map((call) => call.url), ["/webhook/set/crm-aaaaaaaaaaaaaaaaaaaaaaaa", "/webhook/set/crm-bbbbbbbbbbbbbbbbbbbbbbbb", "/webhook/set/crm-sumiu"]);
  for (const call of calls) {
    assert.deepEqual(call.body.webhook.events, ["CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_EDITED", "MESSAGES_DELETE"]);
    assert.ok(call.body.webhook.events.length > 0, "nunca vazia (vazia assinaria todos os eventos)");
    assert.equal(call.body.webhook.enabled, true);
    assert.equal(call.body.webhook.base64, false);
  }

  // 3) Mesma lista: não chama de novo neste processo (a consulta do status não repete a cada abertura).
  const before = calls.length;
  assert.equal(await ensureInstanceWebhookEvents("crm-aaaaaaaaaaaaaaaaaaaaaaaa", deps), "unchanged");
  assert.equal(calls.length, before);

  // 4) Gravação desligada: volta para só conexão.
  env.whatsappEvolutionMessagesEnabled = false;
  assert.equal(await ensureInstanceWebhookEvents("crm-aaaaaaaaaaaaaaaaaaaaaaaa", deps), "ok");
  assert.deepEqual(calls[calls.length - 1].body.webhook.events, ["CONNECTION_UPDATE"]);

  // 5) Evolution fora do ar: conta como falha e não derruba a rodada.
  resetAppliedWebhookEventsForTests();
  down = true;
  const offline = await reconcileWebhookSubscriptions(deps);
  assert.equal(offline.failed, 3);
  down = false;

  console.log("whatsappWebhookSubscriptions.test.ts: ok");
} finally {
  server.close();
}
