import assert from "node:assert/strict";
import { DELETED_BY_CONTACT_TEXT, UNLINKED_RETENTION_DAYS, WhatsAppMessageIngestion, maskContactPhone } from "./whatsappMessageIngestion.js";
import { createMemoryWhatsAppMessageStore } from "./whatsappMessagesTestStore.js";

// Gravação das conversas (WhatsApp Fase B) com armazenamento em memória. Números, nomes, textos e ids
// fictícios.

const memory = createMemoryWhatsAppMessageStore();
let enabled = false;
const ingestion = new WhatsAppMessageIngestion(memory.store, () => enabled);

const INSTANCE = "crm-aaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT = "5511900000001";
const NOW = new Date("2026-11-07T15:00:00.000Z");
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const upsert = (id: string, contact: string, text: string, options: { fromMe?: boolean; pushName?: string; ts?: unknown; instance?: string } = {}) => ({
  event: "messages.upsert",
  instance: options.instance ?? INSTANCE,
  data: {
    key: { remoteJid: `${contact}@s.whatsapp.net`, fromMe: options.fromMe ?? false, id },
    pushName: options.pushName ?? "Contato Ficticio",
    message: { conversation: text },
    messageTimestamp: options.ts ?? at("2026-11-07T14:00:00.000Z")
  },
  apikey: "apikey-ficticia"
});
const conversationOf = (contact: string) => memory.conversations.find((row) => row.contactPhone === contact)!;
const messageOf = (id: string) => memory.messages.find((row) => row.externalMessageId === id)!;

// 1) Desligado: nada é lido nem gravado.
assert.deepEqual(await ingestion.handle(upsert("M-0", "5511900000101", "x"), NOW), { status: "ignored", event: "other", reason: "disabled" });
enabled = true;

// 2) Instância desconhecida (ou não conectada): nada gravado.
assert.deepEqual(await ingestion.handle(upsert("M-0", "5511900000101", "x"), NOW), { status: "unknown_instance", event: "upsert" });
assert.equal(memory.messages.length, 0);

memory.instances.set(INSTANCE, { userId: "seller-a", account: ACCOUNT });
memory.phoneIndex.set("5511900000101", ["client-a"]);
memory.clientTenants.set("client-a", "tenant-a");
memory.phoneIndex.set("5511900000102", ["client-a", "client-b"]);
memory.internal.add("5521900000002");

// 3) Recebida de número de cliente: conversa vinculada, mensagem gravada com o relógio do WhatsApp.
const stored = await ingestion.handle(upsert("M-1", "5511900000101", "Pedido ficticio"), NOW);
assert.deepEqual(stored, { status: "stored", event: "upsert", userId: "seller-a", link: "linked", direction: "inbound" });
const linked = conversationOf("5511900000101");
assert.equal(linked.clientId, "client-a");
assert.equal(linked.tenantId, "tenant-a");
assert.equal(linked.linkStatus, "linked");
assert.equal(linked.linkSource, "auto");
assert.equal(linked.unlinkedExpiresAt, null);
assert.equal(linked.contactName, null, "conversa vinculada não guarda o nome do WhatsApp");
assert.equal(linked.contactDisplay, "(11) ****-0101");
assert.equal(linked.numberOwnerUserId, "seller-a");
assert.equal(messageOf("M-1").direction, "INBOUND");
assert.equal(messageOf("M-1").status, "RECEIVED");
assert.equal(messageOf("M-1").textContent, "Pedido ficticio");
assert.equal(messageOf("M-1").providerTimestamp.toISOString(), "2026-11-07T14:00:00.000Z");
assert.equal(messageOf("M-1").tenantId, "tenant-a");
assert.deepEqual(messageOf("M-1").metadata, {});

// 4) Reentrega do mesmo evento: duplicada, nada muda.
assert.equal((await ingestion.handle(upsert("M-1", "5511900000101", "Pedido ficticio"), NOW)).status, "duplicate");
assert.equal(memory.messages.length, 1);

// 5) Enviada pelo app do celular: OUTBOUND, "via app".
const outbound = await ingestion.handle(upsert("M-2", "5511900000101", "Resposta ficticia", { fromMe: true, pushName: "Você", ts: at("2026-11-07T14:05:00.000Z") }), NOW);
assert.equal(outbound.direction, "outbound");
assert.equal(messageOf("M-2").direction, "OUTBOUND");
assert.equal(messageOf("M-2").status, "SENT");
assert.deepEqual(messageOf("M-2").metadata, { origin: "app" });
assert.equal(conversationOf("5511900000101").lastOutboundAt?.toISOString(), "2026-11-07T14:05:00.000Z");
assert.equal(conversationOf("5511900000101").lastMessageAt?.toISOString(), "2026-11-07T14:05:00.000Z");

// 6) Fora de ordem: a mais antiga chega depois e não recua lastMessageAt.
await ingestion.handle(upsert("M-3", "5511900000101", "Mais antiga ficticia", { ts: at("2026-11-07T13:00:00.000Z") }), NOW);
assert.equal(conversationOf("5511900000101").lastMessageAt?.toISOString(), "2026-11-07T14:05:00.000Z");

// 7) Relógio: sem horário ou no futuro vale a hora de chegada, marcada.
await ingestion.handle(upsert("M-4", "5511900000101", "Sem hora", { ts: 0 }), NOW);
assert.equal(messageOf("M-4").providerTimestamp.toISOString(), NOW.toISOString());
assert.deepEqual(messageOf("M-4").metadata, { clock: "received_at" });
await ingestion.handle(upsert("M-5", "5511900000101", "Do futuro", { ts: at("2026-11-07T16:00:00.000Z") }), NOW);
assert.deepEqual(messageOf("M-5").metadata, { clock: "received_at_future" });

// 8) Número sem cliente: fila do dono do número, expira em 7 dias, guarda o nome do WhatsApp.
const unlinked = await ingestion.handle(upsert("M-6", "5511900000103", "Quero orcamento ficticio", { pushName: "Nome Ficticio" }), NOW);
assert.equal(unlinked.link, "unlinked");
const queue = conversationOf("5511900000103");
assert.equal(queue.clientId, null);
assert.equal(queue.linkStatus, "unlinked");
assert.equal(queue.numberOwnerUserId, "seller-a");
assert.equal(queue.contactName, "Nome Ficticio");
assert.equal(queue.unlinkedExpiresAt?.toISOString(), new Date(NOW.getTime() + UNLINKED_RETENTION_DAYS * 86_400_000).toISOString());

// 9) Telefone em mais de um cliente: ambíguo, vai para a fila.
assert.equal((await ingestion.handle(upsert("M-7", "5511900000102", "Ambiguo ficticio"), NOW)).link, "ambiguous");
assert.equal(conversationOf("5511900000102").clientId, null);
assert.equal(conversationOf("5511900000102").linkStatus, "ambiguous");

// 10) O telefone entrou num cliente: a próxima mensagem vincula a conversa e tira da fila.
memory.phoneIndex.set("5511900000103", ["client-c"]);
memory.clientTenants.set("client-c", "tenant-a");
assert.equal((await ingestion.handle(upsert("M-8", "5511900000103", "Segunda ficticia"), NOW)).link, "linked");
assert.equal(queue.clientId, "client-c");
assert.equal(queue.linkStatus, "linked");
assert.equal(queue.linkSource, "auto");
assert.equal(queue.unlinkedExpiresAt, null);
assert.equal(queue.contactName, null, "o nome do WhatsApp sai ao vincular");
assert.equal(messageOf("M-8").tenantId, "tenant-a");

// 11) Conversa com outro usuário do CRM e com o próprio número: ignorada.
assert.deepEqual(await ingestion.handle(upsert("M-9", "5521900000002", "Interna ficticia"), NOW), { status: "ignored", event: "upsert", userId: "seller-a", reason: "internal_number" });
assert.equal((await ingestion.handle(upsert("M-10", ACCOUNT, "Para mim"), NOW)).reason, "internal_number");
assert.equal(memory.messages.some((row) => row.externalMessageId === "M-9" || row.externalMessageId === "M-10"), false);

// 12) Grupo e status: ignorados pelo parser, nada gravado.
const group = { ...upsert("M-11", "5511900000101", "x"), data: { ...upsert("M-11", "5511900000101", "x").data, key: { remoteJid: "120363000000000000@g.us", fromMe: false, id: "M-11" } } };
assert.deepEqual(await ingestion.handle(group, NOW), { status: "ignored", event: "other", reason: "group" });

// 13) Editada: troca o texto e marca editedAt; original inexistente: not_found.
const edit = (id: string, text: string) => ({ event: "messages.edited", instance: INSTANCE, data: { key: { remoteJid: "5511900000101@s.whatsapp.net", id }, editedMessage: { conversation: text } } });
assert.equal((await ingestion.handle(edit("M-1", "Pedido corrigido ficticio"), NOW)).status, "updated");
assert.equal(messageOf("M-1").textContent, "Pedido corrigido ficticio");
assert.equal(messageOf("M-1").metadata.editedAt, NOW.toISOString());
assert.equal((await ingestion.handle(edit("M-INEXISTENTE", "x"), NOW)).status, "not_found");

// 14) Apagada pelo vendedor: mantém o texto com a marca. Pelo contato: só "[mensagem apagada]".
const del = (id: string) => ({ event: "messages.delete", instance: INSTANCE, data: { remoteJid: "5511900000101@s.whatsapp.net", fromMe: false, id, status: "DELETED" } });
assert.equal((await ingestion.handle(del("M-2"), NOW)).direction, "outbound");
assert.equal(messageOf("M-2").textContent, "Resposta ficticia");
assert.deepEqual(messageOf("M-2").metadata, { origin: "app", deletedInWhatsAppAt: NOW.toISOString() });
assert.equal((await ingestion.handle(del("M-1"), NOW)).direction, "inbound");
assert.equal(messageOf("M-1").textContent, DELETED_BY_CONTACT_TEXT);
assert.equal(messageOf("M-1").mediaMetadata, null);
assert.equal(messageOf("M-1").metadata.editedAt, undefined, "marca de edição sai junto com o texto");
assert.equal(messageOf("M-1").metadata.deletedInWhatsAppAt, NOW.toISOString());
assert.equal((await ingestion.handle(del("M-1"), NOW)).status, "duplicate", "reentrega do apagamento");
assert.equal((await ingestion.handle(edit("M-1", "Volta ficticia"), NOW)).reason, "already_deleted");
assert.equal(messageOf("M-1").textContent, DELETED_BY_CONTACT_TEXT);
assert.equal((await ingestion.handle(del("M-INEXISTENTE"), NOW)).status, "not_found");

// 15) Áudio e imagem: só tipo, duração e legenda.
await ingestion.handle({ ...upsert("M-12", "5511900000101", "x"), data: { ...upsert("M-12", "5511900000101", "x").data, message: { audioMessage: { seconds: 42, url: "https://mmg.invalid/a", mediaKey: "chave" } } } }, NOW);
assert.equal(messageOf("M-12").textContent, "[áudio 0:42]");
assert.deepEqual(messageOf("M-12").mediaMetadata, { kind: "audio", seconds: 42 });
await ingestion.handle({ ...upsert("M-13", "5511900000101", "x"), data: { ...upsert("M-13", "5511900000101", "x").data, message: { imageMessage: { caption: "Foto ficticia", url: "https://mmg.invalid/i" } } } }, NOW);
assert.equal(messageOf("M-13").type, "IMAGE");
await ingestion.handle({ event: "messages.edited", instance: INSTANCE, data: { key: { id: "M-13" }, editedMessage: { conversation: "Legenda nova ficticia" } } }, NOW);
assert.equal(messageOf("M-13").type, "IMAGE", "legenda editada mantém o tipo");
assert.equal(messageOf("M-13").textContent, "[imagem] Legenda nova ficticia");
assert.doesNotMatch(JSON.stringify(memory.messages), /mmg\.invalid|chave/);

// 16) Outro número comercial com o mesmo contato: conversa separada (cada vendedor tem a sua).
memory.instances.set("crm-bbbbbbbbbbbbbbbbbbbbbbbb", { userId: "seller-b", account: "5521900000009" });
await ingestion.handle(upsert("M-1", "5511900000101", "Mesmo id em outro numero", { instance: "crm-bbbbbbbbbbbbbbbbbbbbbbbb" }), NOW);
assert.equal(memory.conversations.filter((row) => row.contactPhone === "5511900000101").length, 2);
assert.equal(memory.messages.filter((row) => row.externalMessageId === "M-1").length, 2, "o id só é único dentro do número comercial");

// 17) O resultado nunca traz texto, nome, número, JID ou id da mensagem.
const results = [stored, outbound, unlinked];
assert.doesNotMatch(JSON.stringify(results), /ficticio|Ficticio|5511900000|s\.whatsapp|M-\d/);
assert.equal(maskContactPhone("551130000101"), "(11) ****-0101");

console.log("whatsappMessageIngestion.test.ts: ok");
