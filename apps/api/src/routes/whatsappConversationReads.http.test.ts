import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";

// WhatsApp Fase B2: leitura das conversas por cliente, por oportunidade e por cartão (dia), com escopo:
// gerente/diretor veem tudo do tenant; vendedor vê a carteira atual; dono da oportunidade vê só pela
// oportunidade e só desde a criação dela. Prisma em memória, só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);

tables.client.push(
  { id: "client-a", name: "Cliente Ficticio A", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-b", name: "Cliente Ficticio B", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-x", name: "Cliente Ficticio X", tenantId: "tenant-b", ownerSellerId: "seller-other-tenant", isArchived: false }
);
tables.opportunity.push(
  // Oportunidade do vendedor B num cliente que hoje é da carteira do vendedor A.
  { id: "opp-b-on-a", clientId: "client-a", ownerSellerId: "seller-b", createdAt: new Date("2026-11-05T15:00:00.000Z") },
  { id: "opp-c-on-b", clientId: "client-b", ownerSellerId: "seller-c", createdAt: new Date("2026-11-01T12:00:00.000Z") }
);
const conversation = (id: string, clientId: string | null, owner: string, provider = "evolution_whatsapp") => ({
  id,
  provider,
  clientId,
  numberOwnerUserId: owner,
  contactNormalized: "5511900000201",
  contactDisplay: "(11) ****-0201",
  contactName: clientId ? null : "Contato Ficticio",
  linkStatus: clientId ? "linked" : "unlinked"
});
tables.communicationConversation.push(
  conversation("conv-a-seller-a", "client-a", "seller-a"),
  conversation("conv-a-seller-b", "client-a", "seller-b"),
  conversation("conv-unlinked", null, "seller-a"),
  conversation("conv-meta", "client-a", "seller-a", "META_WHATSAPP_CLOUD"),
  conversation("conv-x", "client-x", "seller-other-tenant")
);
let messageSeq = 0;
const message = (conversationId: string, iso: string, direction: "INBOUND" | "OUTBOUND", text: string, metadata: Record<string, unknown> = {}) => {
  const conv = tables.communicationConversation.find((row) => row.id === conversationId)!;
  tables.communicationMessage.push({
    id: `msg-${String(++messageSeq).padStart(3, "0")}`,
    conversationId,
    provider: conv.provider,
    externalMessageId: `EXTERNO-FICTICIO-${messageSeq}`,
    externalAccountId: "5511900000001",
    direction,
    type: "TEXT",
    textContent: text,
    providerTimestamp: new Date(iso),
    metadata: direction === "OUTBOUND" ? { origin: "app", ...metadata } : metadata
  });
};
message("conv-a-seller-a", "2026-11-04T13:00:00.000Z", "INBOUND", "Mensagem ficticia antiga");
message("conv-a-seller-a", "2026-11-05T13:00:00.000Z", "INBOUND", "Mensagem ficticia antes da oportunidade");
message("conv-a-seller-a", "2026-11-05T16:00:00.000Z", "OUTBOUND", "Mensagem ficticia depois da oportunidade", { editedAt: "2026-11-05T16:01:00.000Z" });
message("conv-a-seller-a", "2026-11-05T17:00:00.000Z", "OUTBOUND", "Mensagem ficticia apagada pelo vendedor", { deletedInWhatsAppAt: "2026-11-05T17:05:00.000Z" });
message("conv-a-seller-a", "2026-11-05T18:00:00.000Z", "INBOUND", "[mensagem apagada]", { deletedInWhatsAppAt: "2026-11-05T18:05:00.000Z" });
// 01:30 UTC do dia 7 = 22:30 do dia 6 em Brasília.
message("conv-a-seller-b", "2026-11-07T01:30:00.000Z", "INBOUND", "Mensagem ficticia noite");
message("conv-unlinked", "2026-11-06T12:00:00.000Z", "INBOUND", "Mensagem ficticia sem cliente");
message("conv-meta", "2026-11-06T12:00:00.000Z", "INBOUND", "Mensagem ficticia meta");
message("conv-x", "2026-11-06T12:00:00.000Z", "INBOUND", "Mensagem ficticia outro tenant");

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const get = async (userId: string, path: string) => {
  const user = tables.user.find((row) => row.id === userId)!;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role })}` }
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const cardKeys = (json: any) => json.items.map((card: any) => `${card.day} ${card.conversationId} ${card.total}`);

try {
  // 1) Cliente: cartões por conversa e dia de Brasília, mais recente primeiro; sem Meta, sem fila, sem outro tenant.
  const own = await get("seller-a", "/whatsapp/clients/client-a/days");
  assert.equal(own.status, 200);
  assert.deepEqual(cardKeys(own.json), [
    "2026-11-06 conv-a-seller-b 1",
    "2026-11-05 conv-a-seller-a 4",
    "2026-11-04 conv-a-seller-a 1"
  ]);
  assert.equal(own.json.nextBefore, null);
  const card = own.json.items[1];
  assert.equal(card.inbound, 2);
  assert.equal(card.outbound, 2);
  assert.equal(card.contactDisplay, "(11) ****-0201", "número mascarado no cartão");
  assert.deepEqual(card.numberOwner, { id: "seller-a", name: "Vendedor Ficticio A" });
  assert.doesNotMatch(JSON.stringify(own.json), /5511900000201|EXTERNO-FICTICIO|Contato Ficticio|Mensagem ficticia/);

  // Paginação por dias.
  const firstPage = await get("seller-a", "/whatsapp/clients/client-a/days?take=1");
  assert.deepEqual(cardKeys(firstPage.json), ["2026-11-06 conv-a-seller-b 1"]);
  assert.equal(firstPage.json.nextBefore, "2026-11-06");
  const secondPage = await get("seller-a", `/whatsapp/clients/client-a/days?take=1&before=${firstPage.json.nextBefore}`);
  assert.deepEqual(cardKeys(secondPage.json), ["2026-11-05 conv-a-seller-a 4"]);
  assert.equal((await get("seller-a", "/whatsapp/clients/client-a/days?before=2026-13-01")).status, 400);

  // 2) Escopo por cliente: gerente e diretor veem; vendedor de outra carteira e de outro tenant não.
  assert.equal((await get("manager-a", "/whatsapp/clients/client-a/days")).status, 200);
  assert.equal((await get("director-a", "/whatsapp/clients/client-a/days")).status, 200);
  assert.equal((await get("seller-b", "/whatsapp/clients/client-a/days")).status, 404, "dono da oportunidade não lê pelo cliente");
  assert.equal((await get("seller-c", "/whatsapp/clients/client-a/days")).status, 404);
  assert.equal((await get("manager-a", "/whatsapp/clients/client-x/days")).status, 404, "outro tenant");

  // 3) Oportunidade: o dono dela vê, só desde a criação (15:00 UTC do dia 5).
  const byOpportunity = await get("seller-b", "/whatsapp/opportunities/opp-b-on-a/days");
  assert.equal(byOpportunity.status, 200);
  assert.deepEqual(cardKeys(byOpportunity.json), ["2026-11-06 conv-a-seller-b 1", "2026-11-05 conv-a-seller-a 3"]);
  assert.equal(byOpportunity.json.clientId, "client-a");
  assert.equal(byOpportunity.json.since, "2026-11-05T15:00:00.000Z");
  assert.equal(byOpportunity.json.canOpenClient, false, "dono da oportunidade não abre o cliente de outra carteira");
  // O dono atual do cliente também vê pela oportunidade; vendedor sem vínculo, não.
  const byClientOwner = await get("seller-a", "/whatsapp/opportunities/opp-b-on-a/days");
  assert.equal(byClientOwner.status, 200);
  assert.equal(byClientOwner.json.canOpenClient, true);
  assert.equal((await get("seller-c", "/whatsapp/opportunities/opp-b-on-a/days")).status, 404);
  assert.equal((await get("manager-a", "/whatsapp/opportunities/opp-b-on-a/days")).json.canOpenClient, true);

  // 4) Mensagens de um cartão: origem e marcas; pela oportunidade, nada antes da criação.
  const dayMessages = await get("seller-a", "/whatsapp/conversations/conv-a-seller-a/messages?day=2026-11-05");
  assert.equal(dayMessages.status, 200);
  assert.deepEqual(
    dayMessages.json.items.map((item: any) => [item.text, item.origin, item.edited, item.deletedInWhatsApp]),
    [
      ["Mensagem ficticia antes da oportunidade", "received", false, false],
      ["Mensagem ficticia depois da oportunidade", "app", true, false],
      ["Mensagem ficticia apagada pelo vendedor", "app", false, true],
      ["[mensagem apagada]", "received", false, true]
    ]
  );
  assert.equal(dayMessages.json.nextCursor, null);
  assert.doesNotMatch(JSON.stringify(dayMessages.json), /EXTERNO-FICTICIO|5511900000201|5511900000001/);

  const sinceOpportunity = await get("seller-b", "/whatsapp/conversations/conv-a-seller-a/messages?day=2026-11-05&opportunityId=opp-b-on-a");
  assert.equal(sinceOpportunity.status, 200);
  assert.equal(sinceOpportunity.json.items.length, 3);
  assert.equal(sinceOpportunity.json.items[0].text, "Mensagem ficticia depois da oportunidade");

  // Sem a oportunidade, o dono dela não lê; oportunidade de outro cliente também não abre a conversa.
  assert.equal((await get("seller-b", "/whatsapp/conversations/conv-a-seller-a/messages?day=2026-11-05")).status, 404);
  assert.equal((await get("seller-c", "/whatsapp/conversations/conv-a-seller-a/messages?day=2026-11-05&opportunityId=opp-c-on-b")).status, 404);
  // Conversa da fila (sem cliente), da Meta ou de outro tenant: não existe para estas rotas.
  assert.equal((await get("seller-a", "/whatsapp/conversations/conv-unlinked/messages?day=2026-11-06")).status, 404);
  assert.equal((await get("manager-a", "/whatsapp/conversations/conv-meta/messages?day=2026-11-06")).status, 404);
  assert.equal((await get("manager-a", "/whatsapp/conversations/conv-x/messages?day=2026-11-06")).status, 404);
  assert.equal((await get("seller-a", "/whatsapp/conversations/conv-a-seller-a/messages?day=ontem")).status, 400);
  assert.equal((await get("seller-a", "/whatsapp/conversations/conv-a-seller-a/messages")).status, 400);

  // 5) Sem token: 401.
  const anonymous = await fetch(`http://127.0.0.1:${address.port}/whatsapp/clients/client-a/days`);
  assert.equal(anonymous.status, 401);
} finally {
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}

console.log("whatsappConversationReads.http.test.ts: ok");
