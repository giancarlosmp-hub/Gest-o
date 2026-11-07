import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";

// WhatsApp Fase B2: fila "Conversas não vinculadas" — listar (só a própria), vincular (vendedor só à
// carteira dele; telefone vira contato sem duplicar; ambígua não cria) e descartar. Prisma em memória,
// só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);
const NOW = Date.now();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000);
const daysAhead = (days: number) => new Date(NOW + days * 86_400_000);

tables.client.push(
  { id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-a2", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-b", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-archived", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true },
  { id: "client-x", tenantId: "tenant-b", ownerSellerId: "seller-other-tenant", isArchived: false }
);
// Contato já existente do client-a2 com o mesmo telefone em outro formato.
tables.contact.push({ id: "contact-existing", clientId: "client-a2", phone: "(11) 90000-0302 / (11) 3000-0000", email: "", ownerSellerId: "seller-a" });
// Telefone no índice de outro cliente: vincular não cria contato (ficaria ambíguo).
tables.clientPhoneIndex.push({ id: "idx-1", phone: "5511900000303", clientId: "client-b", tenantId: "tenant-a", source: "erp" });

const queued = (id: string, owner: string, phone: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: "evolution_whatsapp",
  clientId: null,
  tenantId: null,
  numberOwnerUserId: owner,
  contactNormalized: phone,
  contactDisplay: `(11) ****-${phone.slice(-4)}`,
  contactName: "Contato Ficticio",
  linkStatus: "unlinked",
  lastMessageAt: hoursAgo(1),
  unlinkedExpiresAt: daysAhead(6.5),
  ...extra
});
tables.communicationConversation.push(
  queued("q-new", "seller-a", "5511900000301"),
  queued("q-existing", "seller-a", "5511900000302", { lastMessageAt: hoursAgo(2), contactName: "X" }),
  queued("q-other-client", "seller-a", "5511900000303", { lastMessageAt: hoursAgo(3) }),
  queued("q-ambiguous", "seller-a", "5511900000304", { linkStatus: "ambiguous", lastMessageAt: hoursAgo(4), unlinkedExpiresAt: daysAhead(0.2) }),
  queued("q-manager", "manager-a", "5511900000305"),
  queued("q-seller-b", "seller-b", "5511900000306"),
  { ...queued("linked-a", "seller-a", "5511900000307"), clientId: "client-a", linkStatus: "linked", unlinkedExpiresAt: null },
  { ...queued("meta-a", "seller-a", "5511900000308"), provider: "META_WHATSAPP_CLOUD" }
);
const longText = `Mensagem ficticia ${"longa ".repeat(40)}`;
let seq = 0;
for (const conversation of tables.communicationConversation) {
  tables.communicationMessage.push(
    { id: `m-${++seq}`, conversationId: conversation.id, provider: conversation.provider, direction: "INBOUND", type: "TEXT", textContent: "Primeira ficticia", tenantId: null, providerTimestamp: hoursAgo(10), metadata: {} },
    { id: `m-${++seq}`, conversationId: conversation.id, provider: conversation.provider, direction: "INBOUND", type: "TEXT", textContent: conversation.id === "q-new" ? longText : "Ultima ficticia", tenantId: null, providerTimestamp: hoursAgo(1), metadata: {} }
  );
}

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const user = tables.user.find((row) => row.id === userId)!;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role })}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const conv = (id: string) => tables.communicationConversation.find((row) => row.id === id);

try {
  // 1) Fila do próprio usuário: número completo, pushName, última mensagem cortada, dias para expirar.
  const queue = await call("seller-a", "GET", "/whatsapp/unlinked");
  assert.equal(queue.status, 200);
  assert.deepEqual(queue.json.items.map((item: any) => item.id), ["q-new", "q-existing", "q-other-client", "q-ambiguous"]);
  assert.equal(queue.json.total, 4);
  assert.equal(queue.json.nextCursor, null);
  const first = queue.json.items[0];
  assert.equal(first.phone, "(11) 90000-0301");
  assert.equal(first.pushName, "Contato Ficticio");
  assert.equal(first.status, "unlinked");
  assert.equal(first.daysToExpire, 7);
  assert.equal(first.lastMessage.direction, "inbound");
  assert.equal(first.lastMessage.text.length, 120);
  assert.ok(first.lastMessage.text.endsWith("…"));
  assert.equal(queue.json.items[3].status, "ambiguous");
  assert.equal(queue.json.items[3].daysToExpire, 1);

  const paged = await call("seller-a", "GET", "/whatsapp/unlinked?take=3");
  assert.equal(paged.json.items.length, 3);
  assert.equal(paged.json.nextCursor, "q-other-client");
  const rest = await call("seller-a", "GET", `/whatsapp/unlinked?take=3&cursor=${paged.json.nextCursor}`);
  assert.deepEqual(rest.json.items.map((item: any) => item.id), ["q-ambiguous"]);

  // Cada um vê só a própria fila, inclusive gerente.
  assert.deepEqual((await call("manager-a", "GET", "/whatsapp/unlinked")).json.items.map((item: any) => item.id), ["q-manager"]);
  assert.deepEqual((await call("director-a", "GET", "/whatsapp/unlinked")).json.items, []);

  // 2) Vincular: só o dono do número; vendedor só a cliente da carteira dele, ativo e do tenant.
  assert.equal((await call("seller-b", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-b" })).status, 404, "fila de outro");
  assert.equal((await call("manager-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-a" })).status, 404, "gerente não mexe na fila de outro");
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-b" })).status, 404, "fora da carteira");
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-archived" })).status, 404);
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-x" })).status, 404, "outro tenant");
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", {})).status, 400);
  assert.equal(conv("q-new")!.clientId, null, "nada mudou nas recusas");

  const linked = await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-a" });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.json, { conversationId: "q-new", clientId: "client-a", contact: "created" });
  const row = conv("q-new")!;
  assert.equal(row.clientId, "client-a");
  assert.equal(row.tenantId, "tenant-a");
  assert.equal(row.linkStatus, "linked");
  assert.equal(row.linkSource, "manual");
  assert.equal(row.linkedById, "seller-a");
  assert.ok(row.linkedAt instanceof Date);
  assert.equal(row.unlinkedExpiresAt, null);
  assert.equal(row.contactName, null);
  assert.ok(tables.communicationMessage.filter((message) => message.conversationId === "q-new").every((message) => message.tenantId === "tenant-a"));
  const created = tables.contact.filter((contact) => contact.clientId === "client-a");
  assert.equal(created.length, 1);
  assert.deepEqual(
    { name: created[0].name, phone: created[0].phone, email: created[0].email, owner: created[0].ownerSellerId },
    { name: "Contato Ficticio", phone: "(11) 90000-0301", email: "", owner: "seller-a" }
  );

  // Segunda tentativa (corrida ou duplo clique): não está mais na fila.
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-new/link", { clientId: "client-a" })).status, 404);

  // Telefone já num contato do cliente (outro formato): não duplica. Nome curto do WhatsApp não é usado.
  const existing = await call("seller-a", "POST", "/whatsapp/unlinked/q-existing/link", { clientId: "client-a2" });
  assert.equal(existing.json.contact, "exists");
  assert.equal(tables.contact.filter((contact) => contact.clientId === "client-a2").length, 1);

  // Telefone no índice de outro cliente: vincula, mas não cria contato.
  const otherClient = await call("seller-a", "POST", "/whatsapp/unlinked/q-other-client/link", { clientId: "client-a" });
  assert.equal(otherClient.json.contact, "skipped_ambiguous");
  // Conversa ambígua: vincula, não cria contato.
  const ambiguous = await call("seller-a", "POST", "/whatsapp/unlinked/q-ambiguous/link", { clientId: "client-a" });
  assert.equal(ambiguous.json.contact, "skipped_ambiguous");
  assert.equal(tables.contact.filter((contact) => contact.clientId === "client-a").length, 1);

  // Gerente vincula a própria conversa a cliente de qualquer carteira do tenant; contato fica com o dono da carteira.
  const byManager = await call("manager-a", "POST", "/whatsapp/unlinked/q-manager/link", { clientId: "client-b" });
  assert.equal(byManager.json.contact, "created");
  assert.equal(tables.contact.find((contact) => contact.clientId === "client-b")!.ownerSellerId, "seller-b");

  // Conversa já vinculada ou da Meta não está na fila.
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/linked-a/link", { clientId: "client-a" })).status, 404);
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/meta-a/link", { clientId: "client-a" })).status, 404);

  // 3) Descartar: só o dono; apaga conversa e mensagens; conversa vinculada nunca.
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/q-seller-b/discard")).status, 404);
  assert.equal((await call("seller-a", "POST", "/whatsapp/unlinked/linked-a/discard")).status, 404);
  assert.ok(conv("linked-a"));
  const discarded = await call("seller-b", "POST", "/whatsapp/unlinked/q-seller-b/discard");
  assert.equal(discarded.status, 200);
  assert.deepEqual(discarded.json, { conversationId: "q-seller-b", discarded: true });
  assert.equal(conv("q-seller-b"), undefined);
  assert.equal(tables.communicationMessage.filter((message) => message.conversationId === "q-seller-b").length, 0);
  assert.equal((await call("seller-b", "POST", "/whatsapp/unlinked/q-seller-b/discard")).status, 404);

  assert.equal((await call("seller-a", "GET", "/whatsapp/unlinked")).json.total, 0);
} finally {
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}

console.log("whatsappConversationQueue.http.test.ts: ok");
