import assert from "node:assert/strict";
import { createWhatsAppConversationsTestDb } from "../whatsappMessages/whatsappConversationsTestDb.js";
import { CLIENT_RECIPIENT_TTL_MS, isClientRecipient, resolveClientRecipient, type ClientSendTarget } from "./clientRecipient.js";

// WhatsApp Fase C: destino do envio pelo CRM, conferido no servidor. Prisma em memória, só dados fictícios.
const models = ["user", "client", "opportunity", "opportunityItem", "opportunityChangeLog", "contact", "clientPhoneIndex", "communicationConversation", "communicationMessage", "appConfig", "whatsAppConnection", "tenantMembership"];
const db: any = Object.fromEntries(models.map((model) => [model, {}]));
const { tables } = createWhatsAppConversationsTestDb(db);

const SELLER_A_NUMBER = "5511900000001";
const MANAGER_NUMBER = "5511900000002";
tables.whatsAppConnection.push(
  { id: "conn-a", userId: "seller-a", instanceName: "crm-ficticio-a", status: "CONNECTED", connectedPhone: SELLER_A_NUMBER },
  { id: "conn-m", userId: "manager-a", instanceName: "crm-ficticio-m", status: "CONNECTED", connectedPhone: MANAGER_NUMBER },
  { id: "conn-b", userId: "seller-b", instanceName: "crm-ficticio-b", status: "DISCONNECTED", connectedPhone: null }
);
tables.client.push(
  { id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-b", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-archived", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true },
  { id: "client-shared-1", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-shared-2", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-x", tenantId: "tenant-b", ownerSellerId: "seller-a", isArchived: false }
);
const index = (id: string, phone: string, clientId: string) => tables.clientPhoneIndex.push({ id, phone, clientId, tenantId: "tenant-a", source: "erp" });
index("idx-a", "5511900000301", "client-a");
index("idx-a-landline", "551130000302", "client-a");
index("idx-a-new", "5511900000309", "client-a");
index("idx-b", "5511900000303", "client-b");
index("idx-archived", "5511900000304", "client-archived");
index("idx-shared-1", "5511900000305", "client-shared-1");
index("idx-shared-2", "5511900000305", "client-shared-2");
index("idx-internal", "5511900000306", "client-a");
index("idx-x", "5511900000307", "client-x");
index("idx-queue", "5511900000308", "client-a");
const conversation = (id: string, owner: string, account: string, contact: string, clientId: string | null, extra: Record<string, unknown> = {}) =>
  tables.communicationConversation.push({
    id,
    provider: "evolution_whatsapp",
    numberOwnerUserId: owner,
    externalAccountId: account,
    externalConversationKey: contact,
    contactNormalized: contact,
    clientId,
    linkStatus: clientId ? "linked" : "unlinked",
    lastInboundAt: null,
    ...extra
  });
conversation("conv-a", "seller-a", SELLER_A_NUMBER, "5511900000301", "client-a", { lastInboundAt: new Date("2026-11-05T12:00:00.000Z") });
conversation("conv-a-other-number", "manager-a", MANAGER_NUMBER, "5511900000301", "client-a");
conversation("conv-a-queue", "seller-a", SELLER_A_NUMBER, "5511900000308", null);
conversation("conv-shared", "seller-a", SELLER_A_NUMBER, "5511900000305", "client-shared-1");
conversation("conv-meta", "seller-a", SELLER_A_NUMBER, "5511900000301", "client-a", { provider: "META_WHATSAPP_CLOUD", id: "conv-meta" });

const internalPhones = async () => new Set(["5511900000306"]);
const resolve = (userId: string, role: string, target: ClientSendTarget, tenantId = "tenant-a") =>
  resolveClientRecipient({ user: { id: userId, role }, tenantId, target }, db, { internalPhones });
const reason = async (userId: string, role: string, target: ClientSendTarget, tenantId?: string) => {
  const result = await resolve(userId, role, target, tenantId);
  return result.ok ? "ok" : result.reason;
};

// 1) Conversa vinculada do próprio número: destino = contato da conversa, instância do remetente, não é primeiro contato.
const fromConversation = await resolve("seller-a", "vendedor", { conversationId: "conv-a" });
assert(fromConversation.ok);
assert.deepEqual({ ...fromConversation.recipient }, {
  senderUserId: "seller-a",
  instanceName: "crm-ficticio-a",
  account: SELLER_A_NUMBER,
  clientId: "client-a",
  tenantId: "tenant-a",
  phone: "5511900000301",
  conversationId: "conv-a",
  firstContact: false
});
assert(Object.isFrozen(fromConversation.recipient));
assert(isClientRecipient(fromConversation.recipient));
assert.equal(isClientRecipient({ ...fromConversation.recipient }), false, "cópia não vale");
assert.equal(isClientRecipient(fromConversation.recipient, Date.now() + CLIENT_RECIPIENT_TTL_MS + 1), false, "vencido");

// 2) Pelo cliente + telefone do índice: conversa existente reaproveitada; telefone novo = primeiro contato, sem conversa.
const fromIndex = await resolve("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-a" });
assert(fromIndex.ok);
assert.equal(fromIndex.recipient.conversationId, "conv-a");
const fresh = await resolve("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-a-new" });
assert(fresh.ok);
assert.equal(fresh.recipient.conversationId, null);
assert.equal(fresh.recipient.firstContact, true);
const landline = await resolve("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-a-landline" });
assert(landline.ok, "fixo com WhatsApp Business também vale");

// 3) Recusas.
assert.equal(await reason("seller-b", "vendedor", { conversationId: "conv-a" }), "not_connected", "número desconectado");
assert.equal(await reason("seller-c", "vendedor", { conversationId: "conv-a" }), "not_connected", "sem conexão");
assert.equal(await reason("manager-a", "gerente", { conversationId: "conv-a" }), "conversation_not_found", "gerente não envia na conversa de outro número");
assert.equal(await reason("seller-a", "vendedor", { conversationId: "conv-a-other-number" }), "conversation_not_found");
assert.equal(await reason("seller-a", "vendedor", { conversationId: "conv-meta" }), "conversation_not_found", "só Evolution");
assert.equal(await reason("seller-a", "vendedor", { conversationId: "conv-a-queue" }), "conversation_unlinked");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-queue" }), "conversation_unlinked", "conversa na fila: vincule antes");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-b" }), "recipient_not_allowed", "telefone de outro cliente");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-b", phoneRef: "idx-b" }), "recipient_not_allowed", "cliente fora da carteira");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-archived", phoneRef: "idx-archived" }), "recipient_not_allowed", "arquivado");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-x", phoneRef: "idx-x" }), "recipient_not_allowed", "outro tenant");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-a", phoneRef: "idx-internal" }), "phone_internal", "número de usuário do CRM");
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-a", phoneRef: "nao-existe" }), "recipient_not_allowed");
assert.equal(await reason("manager-a", "gerente", { clientId: "client-shared-2", phoneRef: "idx-shared-2" }), "phone_ambiguous", "telefone em dois clientes");
// Telefone em dois clientes, mas a conversa deste número já está vinculada a um deles: vale para esse.
assert.equal(await reason("seller-a", "vendedor", { clientId: "client-shared-1", phoneRef: "idx-shared-1" }), "ok");

// 4) Gerente e diretor: qualquer cliente ativo do tenant, sempre pelo próprio número.
const managerSend = await resolve("manager-a", "gerente", { clientId: "client-b", phoneRef: "idx-b" });
assert(managerSend.ok);
assert.equal(managerSend.recipient.instanceName, "crm-ficticio-m");
assert.equal(managerSend.recipient.account, MANAGER_NUMBER);
const managerOwnConversation = await resolve("manager-a", "gerente", { clientId: "client-a", phoneRef: "idx-a" });
assert(managerOwnConversation.ok);
assert.equal(managerOwnConversation.recipient.conversationId, "conv-a-other-number", "a conversa do próprio número, nunca a do vendedor");

console.log("clientRecipient.test.ts: ok");
