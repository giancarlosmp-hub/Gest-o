import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";
import { WhatsAppMessageIngestion } from "../services/whatsappMessages/whatsappMessageIngestion.js";
import { PrismaWhatsAppMessageStore } from "../services/whatsappMessages/whatsappMessageStore.js";
import { CRM_SEND_CONFIG_KEY } from "../services/whatsappConversations/crmSendConfig.js";
import { crmSendLimiter } from "../services/whatsappConversations/crmSendLimits.js";

// WhatsApp Fase C: caixa de conversas e envio pelo CRM, com Prisma em memória e um Evolution falso em
// localhost. Só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);
const user = (id: string) => tables.user.find((row) => row.id === id)!;

const SELLER_A = "5511900000001";
const SELLER_B = "5511900000002";
const MANAGER = "5511900000003";
tables.whatsAppConnection.push(
  { id: "conn-a", userId: "seller-a", instanceName: "crm-ficticio-a", status: "CONNECTED", connectedPhone: SELLER_A },
  { id: "conn-b", userId: "seller-b", instanceName: "crm-ficticio-b", status: "CONNECTED", connectedPhone: SELLER_B },
  { id: "conn-m", userId: "manager-a", instanceName: "crm-ficticio-m", status: "CONNECTED", connectedPhone: MANAGER }
);
tables.client.push(
  { id: "client-a", name: "Cliente Ficticio A", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-b", name: "Cliente Ficticio B", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-x", name: "Cliente Ficticio X", tenantId: "tenant-b", ownerSellerId: "seller-other-tenant", isArchived: false }
);
tables.clientPhoneIndex.push(
  { id: "idx-a1-erp", phone: "5511900000301", clientId: "client-a", tenantId: "tenant-a", source: "erp" },
  { id: "idx-a1-crm", phone: "5511900000301", clientId: "client-a", tenantId: "tenant-a", source: "crm" },
  { id: "idx-a2", phone: "551130000302", clientId: "client-a", tenantId: "tenant-a", source: "erp" },
  { id: "idx-b1", phone: "5511900000303", clientId: "client-b", tenantId: "tenant-a", source: "erp" }
);
const conversation = (id: string, owner: string, account: string, contact: string, clientId: string | null, lastIso: string, unread = 0) =>
  tables.communicationConversation.push({
    id,
    provider: "evolution_whatsapp",
    channel: "WHATSAPP",
    numberOwnerUserId: owner,
    externalAccountId: account,
    externalConversationKey: contact,
    contactNormalized: contact,
    contactDisplay: `(11) ****-${contact.slice(-4)}`,
    clientId,
    tenantId: clientId ? "tenant-a" : null,
    linkStatus: clientId ? "linked" : "unlinked",
    lastMessageAt: new Date(lastIso),
    lastInboundAt: new Date(lastIso),
    lastOutboundAt: null,
    unreadCount: unread
  });
conversation("conv-a1", "seller-a", SELLER_A, "5511900000301", "client-a", "2026-11-10T12:00:00.000Z", 2);
conversation("conv-a-old", "seller-a", SELLER_A, "5511900000305", "client-a", "2026-11-01T12:00:00.000Z");
conversation("conv-a-queue", "seller-a", SELLER_A, "5511900000306", null, "2026-11-10T13:00:00.000Z", 1);
conversation("conv-b1", "seller-b", SELLER_B, "5511900000303", "client-b", "2026-11-10T11:00:00.000Z", 3);
let seq = 0;
const message = (conversationId: string, iso: string, direction: "INBOUND" | "OUTBOUND", text: string, metadata: Record<string, unknown> = {}) => {
  const conv = tables.communicationConversation.find((row) => row.id === conversationId)!;
  tables.communicationMessage.push({
    id: `msg-${String(++seq).padStart(3, "0")}`,
    conversationId,
    provider: "evolution_whatsapp",
    externalAccountId: conv.externalAccountId,
    externalMessageId: `EXTERNO-FICTICIO-${seq}`,
    direction,
    type: "TEXT",
    textContent: text,
    providerTimestamp: new Date(iso),
    status: direction === "OUTBOUND" ? "SENT" : "RECEIVED",
    metadata,
    createdAt: new Date(iso),
    updatedAt: new Date(iso)
  });
};
message("conv-a1", "2026-11-10T11:00:00.000Z", "OUTBOUND", "Oferta ficticia", { origin: "app" });
message("conv-a1", "2026-11-10T12:00:00.000Z", "INBOUND", "Resposta ficticia do cliente");
message("conv-a-old", "2026-11-01T12:00:00.000Z", "INBOUND", "Mensagem ficticia antiga");
message("conv-b1", "2026-11-10T11:00:00.000Z", "INBOUND", "Pergunta ficticia ao vendedor B");

// Evolution falso: estado "open" e envio aceito com ids sequenciais.
const evolutionRequests: Array<{ url: string; body: any }> = [];
let evolutionSeq = 0;
const evolution = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  evolutionRequests.push({ url: req.url!, body: raw ? JSON.parse(raw) : null });
  const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (req.url!.startsWith("/instance/connectionState/")) return json(200, { instance: { state: "open" } });
  if (req.url!.startsWith("/message/sendText/")) return json(201, { key: { id: `MSG-FICTICIA-${++evolutionSeq}`, fromMe: true }, status: "PENDING" });
  res.writeHead(404).end();
});
evolution.listen(0, "127.0.0.1");
await once(evolution, "listening");

const server = app.listen(0);
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const row = user(userId);
  const response = await fetch(`http://127.0.0.1:${port}/whatsapp${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: row.id, email: row.email, role: row.role })}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const conv = (id: string) => tables.communicationConversation.find((row) => row.id === id)!;

const logs: string[] = [];
const originals = { info: console.info, warn: console.warn, error: console.error };
for (const level of ["info", "warn", "error"] as const) console[level] = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));

try {
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;
  env.whatsappEvolutionMessagesEnabled = true;
  env.whatsappEvolutionBaseUrl = `http://127.0.0.1:${(evolution.address() as { port: number }).port}`;
  env.whatsappEvolutionApiKey = "chave-ficticia";
  env.whatsappEvolutionWebhookSecret = "segredo-ficticio";

  // 1) Situação: envio desligado por padrão; só o diretor muda a chave.
  const status = await call("seller-a", "GET", "/inbox/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.available, true);
  assert.equal(status.json.enabled, false);
  assert.equal(status.json.sendEnabled, false);
  assert.equal(status.json.connected, true);
  assert.equal(status.json.canEditConfig, false);
  assert.deepEqual(status.json.limits, { perMinute: 6, perDay: 150, firstContactsPerDay: 20, maxTextLength: 4000 });
  assert.equal(status.json.unreadTotal, 2, "só as vinculadas do próprio número");
  assert.equal((await call("seller-c", "GET", "/inbox/status")).json.connected, false);
  assert.equal((await call("seller-a", "PUT", "/inbox/send-config", { enabled: true })).status, 403);
  assert.equal((await call("manager-a", "PUT", "/inbox/send-config", { enabled: true })).status, 403);
  const sendWhileOff = await call("seller-a", "POST", "/inbox/send", { conversationId: "conv-a1", text: "Olá ficticio" });
  assert.equal(sendWhileOff.status, 403);
  assert.equal(sendWhileOff.json.code, "send_disabled");
  assert.equal(evolutionRequests.length, 0);

  // 2) Caixa "Meu número": vinculadas do próprio número, mais recente primeiro, com não lidas e trecho.
  const mine = await call("seller-a", "GET", "/inbox");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.items.map((item: any) => item.id), ["conv-a1", "conv-a-old"]);
  assert.deepEqual(mine.json.items[0].client, { id: "client-a", name: "Cliente Ficticio A" });
  assert.equal(mine.json.items[0].unreadCount, 2);
  assert.equal(mine.json.items[0].own, true);
  assert.equal(mine.json.items[0].canReply, true);
  assert.deepEqual(mine.json.items[0].lastMessage, { direction: "inbound", type: "TEXT", text: "Resposta ficticia do cliente", viaCrm: false });
  assert.equal(JSON.stringify(mine.json).includes("5511900000301"), false, "número completo do contato não sai na caixa");
  const paged = await call("seller-a", "GET", "/inbox?take=1");
  assert.deepEqual(paged.json.items.map((item: any) => item.id), ["conv-a1"]);
  assert.equal(paged.json.nextCursor, "conv-a1");
  assert.deepEqual((await call("seller-a", "GET", `/inbox?take=1&cursor=${paged.json.nextCursor}`)).json.items.map((item: any) => item.id), ["conv-a-old"]);

  // 3) "Equipe": só gestão, somente leitura (outros números do tenant).
  assert.equal((await call("seller-a", "GET", "/inbox?scope=team")).status, 403);
  const team = await call("manager-a", "GET", "/inbox?scope=team");
  assert.equal(team.status, 200);
  assert.deepEqual(team.json.items.map((item: any) => item.id), ["conv-a1", "conv-b1", "conv-a-old"]);
  assert(team.json.items.every((item: any) => item.own === false && item.canReply === false));
  assert.deepEqual((await call("manager-a", "GET", "/inbox?scope=team&ownerUserId=seller-b")).json.items.map((item: any) => item.id), ["conv-b1"]);
  assert.deepEqual((await call("manager-a", "GET", "/inbox")).json.items, [], "gerente sem conversas no próprio número");

  // 4) Abrir conversa: dono e gestão leem; outro vendedor não.
  const thread = await call("seller-a", "GET", "/inbox/messages?conversationId=conv-a1");
  assert.equal(thread.status, 200);
  assert.deepEqual(thread.json.items.map((item: any) => item.text), ["Oferta ficticia", "Resposta ficticia do cliente"]);
  assert.equal(thread.json.items[0].origin, "app");
  assert.equal(thread.json.conversation.canReply, true);
  assert.equal(thread.json.nextBefore, null);
  assert(thread.json.serverTime);
  assert.equal((await call("seller-b", "GET", "/inbox/messages?conversationId=conv-a1")).status, 404);
  assert.equal((await call("seller-a", "GET", "/inbox/messages?conversationId=conv-a-queue")).status, 404, "fila fica na fila");
  const managerThread = await call("manager-a", "GET", "/inbox/messages?conversationId=conv-b1");
  assert.equal(managerThread.status, 200);
  assert.equal(managerThread.json.conversation.canReply, false);
  assert.equal(managerThread.json.conversation.own, false);
  assert.equal((await call("seller-a", "GET", "/inbox/messages?conversationId=conv-a1&changedSince=xx")).status, 400);
  const changed = await call("seller-a", "GET", "/inbox/messages?conversationId=conv-a1&changedSince=2026-11-10T11:30:00.000Z");
  assert.deepEqual(changed.json.items.map((item: any) => item.text), ["Resposta ficticia do cliente"]);

  // 5) Lida/não lida: só o dono; gerente olhando não zera as do vendedor.
  assert.equal((await call("manager-a", "POST", "/inbox/read", { conversationId: "conv-b1" })).status, 404);
  assert.equal(conv("conv-b1").unreadCount, 3);
  assert.deepEqual((await call("seller-a", "POST", "/inbox/read", { conversationId: "conv-a1" })).json, { unreadCount: 0 });
  assert.equal(conv("conv-a1").unreadCount, 0);
  assert.deepEqual((await call("seller-a", "POST", "/inbox/unread", { conversationId: "conv-a1" })).json, { unreadCount: 1 });
  assert.equal(conv("conv-a1").unreadCount, 1);
  await call("seller-a", "POST", "/inbox/read", { conversationId: "conv-a1" });

  // 6) Telefones do cliente: um por número, com a conversa do próprio número; carteira conferida.
  const targets = await call("seller-a", "GET", "/inbox/client-targets?clientId=client-a");
  assert.equal(targets.status, 200);
  assert.equal(targets.json.connected, true);
  assert.deepEqual(
    targets.json.phones.map((phone: any) => [phone.ref, phone.display, phone.kind, phone.conversationId]),
    [
      ["idx-a1-erp", "(11) 90000-0301", "mobile", "conv-a1"],
      ["idx-a2", "(11) 3000-0302", "landline", null]
    ]
  );
  assert.equal((await call("seller-a", "GET", "/inbox/client-targets?clientId=client-b")).status, 404);
  assert.equal((await call("seller-a", "GET", "/inbox/client-targets?clientId=client-x")).status, 404);
  assert.equal((await call("manager-a", "GET", "/inbox/client-targets?clientId=client-b")).json.phones[0].conversationId, null, "conversa do vendedor não é do gerente");

  // 7) Liga o envio (diretor).
  assert.deepEqual((await call("director-a", "PUT", "/inbox/send-config", { enabled: true })).json, { enabled: true });
  assert.equal(tables.appConfig.find((row) => row.key === CRM_SEND_CONFIG_KEY)?.value, JSON.stringify({ enabled: true }));

  // 8) Corpo do envio: um destino, um texto; lista, número solto ou campo a mais = 400, nada sai.
  for (const body of [
    [{ conversationId: "conv-a1", text: "x" }],
    { conversationId: ["conv-a1", "conv-a-old"], text: "x" },
    { conversationId: "conv-a1", text: "x", phone: "5511900000999" },
    { phone: "5511900000999", text: "x" },
    { clientId: "client-a", text: "x" },
    { conversationId: "conv-a1" }
  ]) {
    const response = await call("seller-a", "POST", "/inbox/send", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(evolutionRequests.length, 0);

  // 9) Envio pela conversa: sai pelo número do vendedor para o contato da conversa, gravado "via CRM".
  const sent = await call("seller-a", "POST", "/inbox/send", { conversationId: "conv-a1", text: "Proposta ficticia enviada pelo CRM" });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.conversationId, "conv-a1");
  assert.equal(sent.json.message.origin, "crm");
  assert.equal(sent.json.message.text, "Proposta ficticia enviada pelo CRM");
  const sendRequest = evolutionRequests.find((request) => request.url.startsWith("/message/sendText/"))!;
  assert.equal(sendRequest.url, "/message/sendText/crm-ficticio-a");
  assert.equal(sendRequest.body.number, "5511900000301");
  const crmRow = tables.communicationMessage.find((row) => row.externalMessageId === "MSG-FICTICIA-1")!;
  assert.deepEqual(crmRow.metadata, { origin: "crm", sentByUserId: "seller-a" });

  // 10) Eco do webhook depois do envio (mesmo id): não duplica e continua "via CRM".
  const ingestion = new WhatsAppMessageIngestion(new PrismaWhatsAppMessageStore(prisma), () => true);
  const echo = await ingestion.handle({
    event: "messages.upsert",
    instance: "crm-ficticio-a",
    data: { key: { remoteJid: "5511900000301@s.whatsapp.net", fromMe: true, id: "MSG-FICTICIA-1" }, message: { conversation: "Proposta ficticia enviada pelo CRM" }, messageTimestamp: Math.floor(Date.now() / 1000) }
  });
  assert.equal(echo.status, "duplicate");
  assert.equal(tables.communicationMessage.filter((row) => row.externalMessageId === "MSG-FICTICIA-1").length, 1);
  const after = await call("seller-a", "GET", "/inbox/messages?conversationId=conv-a1");
  assert.deepEqual(after.json.items.map((item: any) => item.origin), ["app", "received", "crm"]);
  assert.equal((await call("seller-a", "GET", "/inbox")).json.items[0].lastMessage.viaCrm, true);

  // 11) Gerente: não envia na conversa do vendedor; envia pelo próprio número, em conversa própria.
  crmSendLimiter.reset();
  const onSellerConversation = await call("manager-a", "POST", "/inbox/send", { conversationId: "conv-b1", text: "Olá ficticio" });
  assert.equal(onSellerConversation.status, 404);
  assert.equal(onSellerConversation.json.code, "conversation_not_found");
  const managerSent = await call("manager-a", "POST", "/inbox/send", { clientId: "client-b", phoneRef: "idx-b1", text: "Olá, sou o gerente ficticio" });
  assert.equal(managerSent.status, 201);
  assert.notEqual(managerSent.json.conversationId, "conv-b1");
  const managerConversation = conv(managerSent.json.conversationId);
  assert.equal(managerConversation.numberOwnerUserId, "manager-a");
  assert.equal(managerConversation.externalAccountId, MANAGER);
  assert.equal(managerConversation.clientId, "client-b");
  assert.equal(managerConversation.linkSource, "crm");
  assert.equal(evolutionRequests[evolutionRequests.length - 1].url, "/message/sendText/crm-ficticio-m");
  assert.equal(conv("conv-b1").unreadCount, 3, "conversa do vendedor intacta");

  // 12) Vendedor: cliente de outra carteira, conversa da fila e limite de intervalo.
  crmSendLimiter.reset();
  assert.equal((await call("seller-a", "POST", "/inbox/send", { clientId: "client-b", phoneRef: "idx-b1", text: "x" })).json.code, "recipient_not_allowed");
  assert.equal((await call("seller-a", "POST", "/inbox/send", { conversationId: "conv-a-queue", text: "x" })).json.code, "conversation_unlinked");
  assert.equal((await call("seller-a", "POST", "/inbox/send", { clientId: "client-a", phoneRef: "idx-a2", text: "Primeiro contato ficticio" })).status, 201);
  const tooFast = await call("seller-a", "POST", "/inbox/send", { conversationId: "conv-a1", text: "x" });
  assert.equal(tooFast.status, 429);
  assert.equal(tooFast.json.code, "rate_interval");
  assert.equal(tooFast.json.message, "Aguarde alguns segundos entre um envio e outro.");

  // 13) Desligar a chave volta a bloquear.
  crmSendLimiter.reset();
  await call("director-a", "PUT", "/inbox/send-config", { enabled: false });
  assert.equal((await call("seller-a", "POST", "/inbox/send", { conversationId: "conv-a1", text: "x" })).json.code, "send_disabled");

  // 14) Logs (inclusive o de acesso): ids internos do CRM podem aparecer (opacos), mas NUNCA texto da mensagem,
  // telefone (completo ou parcial), nome de cliente/contato, pushName, JID, id da mensagem do WhatsApp,
  // instância do Evolution nem chave/segredo.
  const joined = logs.join("\n");
  for (const forbidden of [
    // texto das mensagens
    "Proposta ficticia", "Olá", "Primeiro contato ficticio", "Oferta ficticia", "Resposta ficticia", "Pergunta ficticia",
    // telefones: e164, exibição e parcial
    "5511900000", "551130000", "90000-0", "3000-03", "****-",
    // nomes de cliente e usuário
    "Cliente Ficticio", "Gerente Ficticio", "Vendedor Ficticio",
    // JID, id da mensagem do WhatsApp, instância e segredos
    "@s.whatsapp.net", "MSG-FICTICIA", "EXTERNO-FICTICIO", "crm-ficticio", "chave-ficticia", "segredo-ficticio"
  ]) {
    assert(!joined.includes(forbidden), `log com ${forbidden}`);
  }

  console.log("whatsappInbox.http.test.ts: ok");
} finally {
  Object.assign(console, originals);
  crmSendLimiter.reset();
  server.close();
  evolution.close();
}
