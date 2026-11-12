import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { env } from "../../config/env.js";
import { EVOLUTION_MESSAGE_WEBHOOK_EVENTS, EVOLUTION_WEBHOOK_SECRET_HEADER, EVOLUTION_WEBHOOK_URL, evolutionWebhookEvents } from "./config.js";
import { CLIENT_SEND_TIMEOUT_MS, EvolutionClient, EvolutionUnavailableError, explicitWebhookEvents, MAX_SEND_TEXT_LENGTH, pickQrDataUrl } from "./evolutionClient.js";
import { CRM_USER_RECIPIENT_TTL_MS, isCrmUserRecipient, resolveCrmUserRecipient, type CrmUserRecipient } from "./crmUserRecipient.js";
import { CLIENT_RECIPIENT_TTL_MS, isClientRecipient, resolveClientRecipient, type ClientRecipient } from "../whatsappConversations/clientRecipient.js";
import { createWhatsAppConversationsTestDb } from "../whatsappMessages/whatsappConversationsTestDb.js";

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
  createTimeoutMs: 300,
  mediaTimeoutMs: 300,
  sendTimeoutMs: 300,
  clientSendTimeoutMs: 300
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

  // 7) Fase B: lista de eventos conforme as flags, sempre explícita (vazia assinaria todos no Evolution).
  assert.deepEqual([...evolutionWebhookEvents()], ["CONNECTION_UPDATE"], "flags desligadas: só conexão");
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionMessagesEnabled = true;
  assert.deepEqual([...evolutionWebhookEvents()], ["CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_EDITED", "MESSAGES_DELETE"]);
  respond(201, { instance: { instanceName: "crm-ficticio-b", status: "connecting" }, qrcode: { base64: FAKE_QR } });
  await client.createInstance("crm-ficticio-b");
  assert.deepEqual(last().body.webhook.events, [...EVOLUTION_MESSAGE_WEBHOOK_EVENTS], "instância nova já nasce com as mensagens");
  respond(201, { webhook: { enabled: true } });
  assert.equal(await client.setWebhook("crm-ficticio", evolutionWebhookEvents()), "ok");
  assert.equal(last().method, "POST");
  assert.equal(last().url, "/webhook/set/crm-ficticio");
  assert.equal(last().headers.apikey, "chave-ficticia");
  assert.deepEqual(last().body, {
    webhook: {
      enabled: true,
      url: EVOLUTION_WEBHOOK_URL,
      byEvents: false,
      base64: false,
      headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: "segredo-ficticio" },
      events: ["CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_EDITED", "MESSAGES_DELETE"]
    }
  });
  assert.doesNotMatch(JSON.stringify(last().body), /MESSAGES_UPDATE|MESSAGES_SET|CONTACTS|CHATS|GROUP|PRESENCE|SEND_MESSAGE/, "sem entrega/leitura, histórico, contatos, grupos ou envio");
  const before = recorded.length;
  await assert.rejects(client.setWebhook("crm-ficticio", []), /webhook_events_empty/, "lista vazia nunca vai ao Evolution");
  await assert.rejects(client.setWebhook("crm-ficticio", ["MESSAGES_UPSERT", "MESSAGES_UPSERT"]), /webhook_events_invalid/);
  await assert.rejects(client.setWebhook("crm-ficticio", ["SEND_MESSAGE"]), /webhook_events_invalid/);
  assert.equal(recorded.length, before, "nada foi enviado nas listas recusadas");
  assert.throws(() => explicitWebhookEvents([]), /webhook_events_empty/);
  respond(404, { response: { message: ['The "crm-ficticio" instance does not exist'] } });
  assert.equal(await client.setWebhook("crm-ficticio", ["CONNECTION_UPDATE"]), "not_found");
  respond(400, { response: { message: ["outro erro"] } });
  await assert.rejects(client.setWebhook("crm-ficticio", ["CONNECTION_UPDATE"]), EvolutionUnavailableError);
  env.whatsappEvolutionMessagesEnabled = false;
  assert.deepEqual([...evolutionWebhookEvents()], ["CONNECTION_UPDATE"], "gravação desligada volta a só conexão");

  // 8) Só dois envios (resumo diário e conversa com o cliente), o POST comum é privado de verdade; o único de
  // mídia é a leitura do áudio a transcrever.
  const methods = Object.getOwnPropertyNames(EvolutionClient.prototype);
  assert.deepEqual(methods.filter((name) => /send|message|text|media|post/i.test(name)).sort(), ["getMediaBase64", "sendTextToClient", "sendTextToCrmUser"]);
  assert.equal((client as any).postSendText, undefined);

  // 9) Áudio para transcrever: mensagem inteira (key + message), sem conversão, base64 devolvido.
  const audioRef = {
    key: { remoteJid: "5511900000101@s.whatsapp.net", fromMe: false, id: "AUDIO-FICTICIO-1" },
    message: { audioMessage: { url: "https://mmg.invalid/ficticio", mediaKey: "chave-ficticia", seconds: 7, ptt: true } }
  };
  respond(201, { mediaType: "audioMessage", mimetype: "audio/ogg; codecs=opus", base64: "T2dnUw==" });
  assert.deepEqual(await client.getMediaBase64("crm-ficticio", audioRef, 100), { base64: "T2dnUw==", mimetype: "audio/ogg; codecs=opus" });
  assert.equal(last().method, "POST");
  assert.equal(last().url, "/chat/getBase64FromMediaMessage/crm-ficticio");
  assert.equal(last().headers.apikey, "chave-ficticia");
  assert.deepEqual(last().body, { message: audioRef, convertToMp4: false });
  respond(400, { response: { message: ["Message not found"] } });
  await assert.rejects(client.getMediaBase64("crm-ficticio", audioRef, 100), /media_http_400/);
  respond(201, { mediaType: "audioMessage" });
  await assert.rejects(client.getMediaBase64("crm-ficticio", audioRef, 100), /media_empty/);
  respond(201, { base64: "A".repeat(101) });
  await assert.rejects(client.getMediaBase64("crm-ficticio", audioRef, 100), /media_too_large/);
  respond(500, {});
  await assert.rejects(client.getMediaBase64("crm-ficticio", audioRef, 100), EvolutionUnavailableError);

  // 10) Envio (Fase D): só para o destino emitido por resolveCrmUserRecipient (usuário ativo do CRM).
  const users: Record<string, { id: string; isActive: boolean; phone: string | null }> = {
    "user-ativo": { id: "user-ativo", isActive: true, phone: "(11) 90000-0101" },
    "user-inativo": { id: "user-inativo", isActive: false, phone: "(11) 90000-0102" },
    "user-sem-celular": { id: "user-sem-celular", isActive: true, phone: null },
    "user-fixo": { id: "user-fixo", isActive: true, phone: "(11) 3000-0103" },
    "user-celular-de-cliente": { id: "user-celular-de-cliente", isActive: true, phone: "11900000104" }
  };
  const clientPhones = new Set(["5511900000104"]);
  const fakeDb = {
    user: { findUnique: async (args: any) => users[args.where.id] ?? null },
    clientPhoneIndex: { count: async (args: any) => (clientPhones.has(args.where.phone) ? 1 : 0) }
  };
  const resolve = (id: string) => resolveCrmUserRecipient(id, fakeDb);
  assert.deepEqual(await resolve("user-inexistente"), { ok: false, reason: "user_not_found" });
  assert.deepEqual(await resolve("user-inativo"), { ok: false, reason: "user_inactive" });
  assert.deepEqual(await resolve("user-sem-celular"), { ok: false, reason: "no_phone" });
  assert.deepEqual(await resolve("user-fixo"), { ok: false, reason: "invalid_phone" });
  assert.deepEqual(await resolve("user-celular-de-cliente"), { ok: false, reason: "phone_matches_client" });
  const resolved = await resolve("user-ativo");
  assert(resolved.ok);
  const recipient = resolved.recipient;
  assert.deepEqual({ ...recipient }, { userId: "user-ativo", phone: "5511900000101" });
  assert(Object.isFrozen(recipient), "destino imutável");

  // Destino forjado (mesmo formato, com cast), vencido ou texto inválido: recusado antes da rede.
  const sentBefore = recorded.length;
  const forged = { userId: "user-ativo", phone: "5511900000999" } as CrmUserRecipient;
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", forged, "Olá"), /whatsapp_recipient_not_crm_user/);
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", { ...recipient }, "Olá"), /whatsapp_recipient_not_crm_user/, "cópia do destino");
  assert.equal(isCrmUserRecipient(recipient, Date.now() + CRM_USER_RECIPIENT_TTL_MS + 1), false, "destino vencido");
  const expired = await resolveCrmUserRecipient("user-ativo", fakeDb, () => Date.now() - CRM_USER_RECIPIENT_TTL_MS - 1);
  assert(expired.ok);
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", expired.recipient, "Olá"), /whatsapp_recipient_not_crm_user/);
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", recipient, "   "), /whatsapp_text_invalid/);
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", recipient, "x".repeat(MAX_SEND_TEXT_LENGTH + 1)), /whatsapp_text_invalid/);
  assert.equal(recorded.length, sentBefore, "nada chegou ao Evolution");

  // Aceito: número do destino (nunca outro), sem pré-visualização de link.
  respond(201, { key: { remoteJid: "5511900000101@s.whatsapp.net", fromMe: true, id: "MSG-FICTICIA-1" }, status: "PENDING" });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "Resumo fictício"), { kind: "sent" });
  assert.equal(last().method, "POST");
  assert.equal(last().url, "/message/sendText/crm-ficticio");
  assert.equal(last().headers.apikey, "chave-ficticia");
  assert.deepEqual(last().body, { number: "5511900000101", text: "Resumo fictício", delay: 1_200, linkPreview: false });

  // Respostas: sem id = incerto; número sem WhatsApp e instância inexistente = não saiu; desconhecidas = incerto.
  respond(201, { status: "PENDING" });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "uncertain", code: "no_message_id" });
  respond(400, { status: 400, error: "Bad Request", response: { message: [{ jid: "5511900000101@s.whatsapp.net", exists: false, number: "5511900000101" }] } });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "not_sent", code: "number_not_on_whatsapp", retryable: false });
  respond(404, { response: { message: ['The "crm-ficticio" instance does not exist'] } });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "not_sent", code: "instance_not_found", retryable: false });
  respond(400, { response: { message: ["Connection Closed"] } });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "uncertain", code: "http_400" });
  respond(500, { response: { message: ["Connection Closed"] } });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "uncertain", code: "http_500" });
  respond(401, { error: "Unauthorized" });
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "not_sent", code: "unauthorized", retryable: false });
  respond(201, {}, 1_000);
  assert.deepEqual(await client.sendTextToCrmUser("crm-ficticio", recipient, "x"), { kind: "uncertain", code: "timeout" }, "timeout pode ter saído");
  // Conexão recusada (porta fechada): a requisição não saiu e pode ser repetida.
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const closedPort = (closed.address() as { port: number }).port;
  closed.close();
  await once(closed, "close");
  const refused = new EvolutionClient({ baseUrl: `http://127.0.0.1:${closedPort}`, apiKey: "x", webhookSecret: "y", timeoutMs: 2_000 });
  await assert.rejects(refused.connect("crm-ficticio"), (error: unknown) => error instanceof EvolutionUnavailableError && error.connectRefused);
  const refusedRecipient = await resolve("user-ativo");
  assert(refusedRecipient.ok);
  assert.deepEqual(await refused.sendTextToCrmUser("crm-ficticio", refusedRecipient.recipient, "x"), { kind: "not_sent", code: "connection_refused", retryable: true });

  // 11) Envio ao cliente (Fase C): só o destino emitido por resolveClientRecipient, pela instância do próprio
  // remetente que vai dentro do destino; devolve o id da mensagem (casa com o eco do webhook).
  const models = ["user", "client", "opportunity", "opportunityItem", "opportunityChangeLog", "contact", "clientPhoneIndex", "communicationConversation", "communicationMessage", "appConfig", "whatsAppConnection", "tenantMembership"];
  const fakePrisma: any = Object.fromEntries(models.map((model) => [model, {}]));
  const { tables } = createWhatsAppConversationsTestDb(fakePrisma);
  tables.whatsAppConnection.push({ id: "conn-1", userId: "seller-a", instanceName: "crm-ficticio-vendedor", status: "CONNECTED", connectedPhone: "5511900000001" });
  tables.client.push({ id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false });
  tables.clientPhoneIndex.push({ id: "idx-a", phone: "5511900000301", clientId: "client-a", tenantId: "tenant-a", source: "erp" });
  const resolveClient = () =>
    resolveClientRecipient({ user: { id: "seller-a", role: "vendedor" }, tenantId: "tenant-a", target: { clientId: "client-a", phoneRef: "idx-a" } }, fakePrisma, { internalPhones: async () => new Set() });
  const clientResolution = await resolveClient();
  assert(clientResolution.ok);
  const clientRecipient = clientResolution.recipient;
  assert.equal(clientRecipient.instanceName, "crm-ficticio-vendedor");

  const beforeClient = recorded.length;
  const forgedClient = { ...clientRecipient } as ClientRecipient;
  await assert.rejects(client.sendTextToClient(forgedClient, "Olá"), /whatsapp_recipient_not_client/, "cópia do destino");
  await assert.rejects(client.sendTextToClient(recipient as unknown as ClientRecipient, "Olá"), /whatsapp_recipient_not_client/, "destino do resumo diário não serve para cliente");
  await assert.rejects(client.sendTextToCrmUser("crm-ficticio", clientRecipient as unknown as CrmUserRecipient, "Olá"), /whatsapp_recipient_not_crm_user/, "destino de cliente não serve para o resumo");
  assert.equal(isClientRecipient(clientRecipient, Date.now() + CLIENT_RECIPIENT_TTL_MS + 1), false, "destino vencido");
  await assert.rejects(client.sendTextToClient(clientRecipient, " "), /whatsapp_text_invalid/);
  await assert.rejects(client.sendTextToClient(clientRecipient, "x".repeat(MAX_SEND_TEXT_LENGTH + 1)), /whatsapp_text_invalid/);
  assert.equal(recorded.length, beforeClient, "nada chegou ao Evolution");

  respond(201, { key: { remoteJid: "5511900000301@s.whatsapp.net", fromMe: true, id: "MSG-FICTICIA-CLIENTE-1" }, status: "PENDING" });
  assert.deepEqual(await client.sendTextToClient(clientRecipient, "Olá, cliente fictício"), { kind: "sent", messageId: "MSG-FICTICIA-CLIENTE-1" });
  assert.equal(last().url, "/message/sendText/crm-ficticio-vendedor", "instância do próprio remetente");
  assert.deepEqual(last().body, { number: "5511900000301", text: "Olá, cliente fictício", delay: 1_200, linkPreview: false });
  respond(201, { status: "PENDING" });
  assert.deepEqual(await client.sendTextToClient(clientRecipient, "x"), { kind: "uncertain", code: "no_message_id" });
  respond(400, { response: { message: [{ exists: false, number: "5511900000301" }] } });
  assert.deepEqual(await client.sendTextToClient(clientRecipient, "x"), { kind: "not_sent", code: "number_not_on_whatsapp", retryable: false });
  respond(201, {}, 1_000);
  assert.deepEqual(await client.sendTextToClient(clientRecipient, "x"), { kind: "uncertain", code: "timeout" });
  assert.equal(CLIENT_SEND_TIMEOUT_MS, 10_000);
  // API_REQUEST_TIMEOUT_MS de produção (docker-compose.production.yml): 15 s.
  assert(CLIENT_SEND_TIMEOUT_MS < 15_000, "o envio ao cliente termina antes do timeout da requisição da API");

  console.log("evolutionClient.test.ts: ok");
} finally {
  server.close();
}
