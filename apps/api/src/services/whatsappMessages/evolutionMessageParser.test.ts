import assert from "node:assert/strict";
import {
  classifyRemoteJid,
  formatDuration,
  isEvolutionMessageEvent,
  parseEvolutionMessageEvent,
  parseMessageContent,
  parseMessageTimestamp
} from "./evolutionMessageParser.js";

// Eventos de mensagem do Evolution v2.3.7 (WhatsApp Fase B). Números, nomes, textos e ids fictícios.

const INSTANCE = "crm-aaaaaaaaaaaaaaaaaaaaaaaa";
const upsert = (key: Record<string, unknown>, message: unknown, extra: Record<string, unknown> = {}) => ({
  event: "messages.upsert",
  instance: INSTANCE,
  data: { key, pushName: "Contato Ficticio", message, messageType: "conversation", messageTimestamp: 1_794_000_000, ...extra },
  apikey: "apikey-ficticia"
});
const contactKey = (id = "ID-FICTICIO-1", fromMe = false) => ({ remoteJid: "5511900000101@s.whatsapp.net", fromMe, id });

// 1) Nome do evento nas duas grafias.
assert.equal(isEvolutionMessageEvent("messages.upsert"), true);
assert.equal(isEvolutionMessageEvent("MESSAGES_UPSERT"), true);
assert.equal(isEvolutionMessageEvent("MESSAGES_EDITED"), true);
assert.equal(isEvolutionMessageEvent("messages.delete"), true);
assert.equal(isEvolutionMessageEvent("messages.update"), false, "entrega/leitura não é assinado");
assert.equal(isEvolutionMessageEvent("connection.update"), false);
assert.equal(isEvolutionMessageEvent(undefined), false);

// 2) Destino da conversa: só pessoa com número brasileiro.
assert.deepEqual(classifyRemoteJid("5511900000101@s.whatsapp.net"), { kind: "contact", phone: "5511900000101" });
assert.deepEqual(classifyRemoteJid("551130000101@s.whatsapp.net"), { kind: "contact", phone: "551130000101" }, "fixo (WhatsApp Business)");
assert.deepEqual(classifyRemoteJid("551180000101@s.whatsapp.net"), { kind: "contact", phone: "5511980000101" }, "nono dígito");
assert.deepEqual(classifyRemoteJid("status@broadcast"), { kind: "ignored", reason: "status" });
assert.deepEqual(classifyRemoteJid("120363000000000000@g.us"), { kind: "ignored", reason: "group" });
assert.deepEqual(classifyRemoteJid("1600000000@broadcast"), { kind: "ignored", reason: "broadcast" });
assert.deepEqual(classifyRemoteJid("120363000000000001@newsletter"), { kind: "ignored", reason: "newsletter" });
assert.deepEqual(classifyRemoteJid("123456789012345@lid"), { kind: "ignored", reason: "lid_unresolved" });
assert.deepEqual(classifyRemoteJid("15550000001@s.whatsapp.net"), { kind: "ignored", reason: "unsupported_number" });
assert.deepEqual(classifyRemoteJid(""), { kind: "ignored", reason: "invalid_payload" });

// 3) Conteúdo: texto, mídia só com tipo e legenda, sem URL, chave, miniatura, coordenadas ou vCard.
assert.deepEqual(parseMessageContent({ conversation: "Bom dia ficticio" }), { type: "TEXT", text: "Bom dia ficticio", media: null });
assert.deepEqual(parseMessageContent({ extendedTextMessage: { text: "Link ficticio https://exemplo.invalid", jpegThumbnail: "AAAA" } }), { type: "TEXT", text: "Link ficticio https://exemplo.invalid", media: null });
const image = parseMessageContent({ imageMessage: { url: "https://mmg.invalid/x", mediaKey: "chave", jpegThumbnail: "AAAA", caption: "Foto ficticia", mimetype: "image/jpeg" } });
assert.deepEqual(image, { type: "IMAGE", text: "[imagem] Foto ficticia", media: { kind: "image" } });
assert.doesNotMatch(JSON.stringify(image), /mmg\.invalid|chave|AAAA|jpeg/);
assert.deepEqual(parseMessageContent({ imageMessage: { url: "x" } }), { type: "IMAGE", text: "[imagem]", media: { kind: "image" } });
assert.deepEqual(parseMessageContent({ audioMessage: { seconds: 42, ptt: true, url: "x" } }), { type: "AUDIO", text: "[áudio 0:42]", media: { kind: "audio", seconds: 42 } });
assert.deepEqual(parseMessageContent({ audioMessage: {} }), { type: "AUDIO", text: "[áudio]", media: { kind: "audio" } });
assert.deepEqual(parseMessageContent({ videoMessage: { seconds: "75", caption: "Video ficticio" } }), { type: "VIDEO", text: "[vídeo] Video ficticio", media: { kind: "video", seconds: 75 } });
const document = parseMessageContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: "contrato-ficticio.pdf", caption: "Segue", url: "x" } } } });
assert.deepEqual(document, { type: "DOCUMENT", text: "[documento] Segue", media: { kind: "document" } });
assert.doesNotMatch(JSON.stringify(document), /contrato-ficticio/, "nome do arquivo não é gravado");
assert.deepEqual(parseMessageContent({ stickerMessage: { url: "x" } }), { type: "STICKER", text: "[figurinha]", media: { kind: "sticker" } });
const location = parseMessageContent({ locationMessage: { degreesLatitude: -10.5, degreesLongitude: -50.5 } });
assert.deepEqual(location, { type: "LOCATION", text: "[localização]", media: null });
assert.doesNotMatch(JSON.stringify(location), /10\.5|50\.5/);
const contactCard = parseMessageContent({ contactMessage: { displayName: "Pessoa Ficticia", vcard: "BEGIN:VCARD TEL:5511900000999" } });
assert.deepEqual(contactCard, { type: "CONTACT", text: "[contato]", media: null });
assert.doesNotMatch(JSON.stringify(contactCard), /VCARD|900000999|Pessoa/);
assert.deepEqual(parseMessageContent({ pollCreationMessageV3: { name: "Enquete ficticia" } }), { type: "UNKNOWN", text: "[enquete]", media: null });
assert.deepEqual(parseMessageContent({ ephemeralMessage: { message: { conversation: "Temporaria ficticia" } } }), { type: "TEXT", text: "Temporaria ficticia", media: null });
assert.deepEqual(parseMessageContent({ viewOnceMessageV2: { message: { imageMessage: { caption: "Uma vez" } } } }), { type: "IMAGE", text: "[imagem] Uma vez", media: { kind: "image" } });
assert.deepEqual(parseMessageContent({ buttonsResponseMessage: { selectedButtonId: "x" } }), { type: "UNKNOWN", text: "[mensagem não suportada]", media: null });
assert.equal(parseMessageContent({ reactionMessage: { text: "ok" } }), "reaction");
assert.equal(parseMessageContent({ protocolMessage: { type: 0 } }), "protocol");
assert.equal(parseMessageContent({ conversation: "   " }), "empty");
assert.equal(parseMessageContent({ messageContextInfo: {} }), "empty");
assert.equal(parseMessageContent(null), "empty");
assert.equal(formatDuration(605), "10:05");

// 4) Relógio: segundos, texto, Long e milissegundos.
assert.equal(parseMessageTimestamp(1_794_000_000)?.toISOString(), new Date(1_794_000_000_000).toISOString());
assert.equal(parseMessageTimestamp("1794000000")?.toISOString(), new Date(1_794_000_000_000).toISOString());
assert.equal(parseMessageTimestamp({ low: 1_794_000_000, high: 0, unsigned: true })?.toISOString(), new Date(1_794_000_000_000).toISOString());
assert.equal(parseMessageTimestamp(1_794_000_000_123)?.toISOString(), new Date(1_794_000_000_123).toISOString());
assert.equal(parseMessageTimestamp(0), null);
assert.equal(parseMessageTimestamp("ontem"), null);

// 5) messages.upsert completo, recebida e enviada pelo app.
const received = parseEvolutionMessageEvent(upsert(contactKey(), { conversation: "Pedido ficticio" }));
assert.deepEqual(received, {
  kind: "upsert",
  instance: INSTANCE,
  externalMessageId: "ID-FICTICIO-1",
  fromMe: false,
  contactPhone: "5511900000101",
  pushName: "Contato Ficticio",
  timestamp: new Date(1_794_000_000_000),
  content: { type: "TEXT", text: "Pedido ficticio", media: null }
});
const sent = parseEvolutionMessageEvent(upsert(contactKey("ID-FICTICIO-2", true), { conversation: "Resposta ficticia" }, { pushName: "Você" }));
assert.equal(sent.kind === "upsert" && sent.fromMe, true);
assert.equal(sent.kind === "upsert" && sent.pushName, null, "nome do próprio vendedor não é guardado");
assert.deepEqual(parseEvolutionMessageEvent(upsert({ ...contactKey(), remoteJid: "status@broadcast" }, { conversation: "x" })), { kind: "ignored", reason: "status" });
assert.deepEqual(parseEvolutionMessageEvent(upsert({ ...contactKey(), remoteJid: "120363000000000000@g.us" }, { conversation: "x" })), { kind: "ignored", reason: "group" });
assert.deepEqual(parseEvolutionMessageEvent(upsert({ ...contactKey(), remoteJid: "1@broadcast" }, { conversation: "x" })), { kind: "ignored", reason: "broadcast" });
assert.deepEqual(parseEvolutionMessageEvent(upsert({ ...contactKey(), remoteJid: "123456789012345@lid" }, { conversation: "x" })), { kind: "ignored", reason: "lid_unresolved" });
assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey(), { reactionMessage: { text: "ok" } })), { kind: "ignored", reason: "reaction" });
assert.deepEqual(parseEvolutionMessageEvent(upsert({ remoteJid: "5511900000101@s.whatsapp.net" }, { conversation: "x" })), { kind: "ignored", reason: "invalid_payload" });
assert.deepEqual(parseEvolutionMessageEvent({ event: "messages.upsert", data: {} }), { kind: "ignored", reason: "invalid_payload" });
assert.deepEqual(parseEvolutionMessageEvent({ event: "connection.update", instance: INSTANCE, data: {} }), { kind: "ignored", reason: "not_message_event" });
assert.deepEqual(parseEvolutionMessageEvent("texto"), { kind: "ignored", reason: "not_message_event" });

// 6) Editada (protocolMessage com a chave da original) e apagada ({ ...key, status }).
assert.deepEqual(
  parseEvolutionMessageEvent({ event: "messages.edited", instance: INSTANCE, data: { key: contactKey("ID-FICTICIO-1"), type: 14, editedMessage: { conversation: "Pedido corrigido ficticio" } } }),
  { kind: "edit", instance: INSTANCE, targetMessageId: "ID-FICTICIO-1", content: { type: "TEXT", text: "Pedido corrigido ficticio", media: null } }
);
assert.deepEqual(
  parseEvolutionMessageEvent({ event: "MESSAGES_EDITED", instance: INSTANCE, data: { protocolMessage: { key: contactKey("ID-FICTICIO-1"), editedMessage: { imageMessage: { caption: "Nova legenda" } } } } }),
  { kind: "edit", instance: INSTANCE, targetMessageId: "ID-FICTICIO-1", content: { type: "IMAGE", text: "[imagem] Nova legenda", media: { kind: "image" } } }
);
assert.deepEqual(parseEvolutionMessageEvent({ event: "messages.edited", instance: INSTANCE, data: { key: contactKey("ID-FICTICIO-1") } }), { kind: "ignored", reason: "empty" });
assert.deepEqual(
  parseEvolutionMessageEvent({ event: "messages.delete", instance: INSTANCE, data: { ...contactKey("ID-FICTICIO-1"), status: "DELETED" } }),
  { kind: "delete", instance: INSTANCE, targetMessageId: "ID-FICTICIO-1" }
);
assert.deepEqual(parseEvolutionMessageEvent({ event: "messages.delete", instance: INSTANCE, data: { status: "DELETED" } }), { kind: "ignored", reason: "invalid_payload" });

// 7) Edição e revogação dentro de messages.upsert (Baileys 7.0.0-rc.9): protocolMessage solto, dentro de
// editedMessage.message, dentro de ephemeralMessage (conversa temporária) e com o enum por nome.
const editProtocol = (type: unknown = 14) => ({ key: contactKey("ID-ORIGINAL-1", true), type, editedMessage: { conversation: "Texto editado ficticio" }, timestampMs: "1794000060000" });
const editedTo = { kind: "edit", instance: INSTANCE, targetMessageId: "ID-ORIGINAL-1", content: { type: "TEXT", text: "Texto editado ficticio", media: null } };
for (const [name, message] of Object.entries({
  solto: { protocolMessage: editProtocol(), messageContextInfo: { messageSecret: { 0: 1 } } },
  editedMessage: { editedMessage: { message: { protocolMessage: editProtocol() } } },
  temporaria: { ephemeralMessage: { message: { protocolMessage: editProtocol() } } },
  temporariaEditedMessage: { ephemeralMessage: { message: { editedMessage: { message: { protocolMessage: editProtocol() } } } } },
  nomeDoEnum: { protocolMessage: editProtocol("MESSAGE_EDIT") }
})) {
  assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey("ID-AVISO-EDICAO"), message, { messageType: "protocolMessage" })), editedTo, name);
}
assert.deepEqual(
  parseEvolutionMessageEvent(upsert(contactKey("ID-AVISO-EDICAO"), { protocolMessage: { ...editProtocol(), editedMessage: { extendedTextMessage: { text: "Legenda ficticia" } } } })),
  { ...editedTo, content: { type: "TEXT", text: "Legenda ficticia", media: null } }
);
const revoked = { kind: "delete", instance: INSTANCE, targetMessageId: "ID-ORIGINAL-1" };
assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey("ID-AVISO-REVOGA"), { protocolMessage: { key: contactKey("ID-ORIGINAL-1", true), type: 0 } })), revoked);
assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey("ID-AVISO-REVOGA"), { ephemeralMessage: { message: { protocolMessage: { key: contactKey("ID-ORIGINAL-1"), type: "REVOKE" } } } })), revoked);
// Sem id da original, edição sem conteúdo, tipo ausente ou outro tipo de protocolMessage: ignorado, nunca UNKNOWN.
assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey(), { protocolMessage: { type: 14, editedMessage: { conversation: "x" } } })), { kind: "ignored", reason: "invalid_payload" });
assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey(), { protocolMessage: { key: contactKey("ID-ORIGINAL-1"), type: 14 } })), { kind: "ignored", reason: "empty" });
for (const protocolMessage of [
  { key: contactKey("ID-ORIGINAL-1"), editedMessage: { conversation: "x" } },
  { type: 3, ephemeralExpiration: 86_400 },
  { type: "HISTORY_SYNC_NOTIFICATION", historySyncNotification: { chunkOrder: 1 } },
  { type: 23, lidMigrationMappingSyncMessage: {} },
  { type: 99, key: contactKey("ID-ORIGINAL-1") }
]) {
  assert.deepEqual(parseEvolutionMessageEvent(upsert(contactKey(), { protocolMessage })), { kind: "ignored", reason: "protocol" }, JSON.stringify(protocolMessage.type));
}
// Edição cifrada (secretEncryptedMessage): sem texto novo legível, ignorada.
assert.deepEqual(
  parseEvolutionMessageEvent(upsert(contactKey(), { secretEncryptedMessage: { targetMessageKey: contactKey("ID-ORIGINAL-1"), encPayload: { 0: 1 }, encIv: { 0: 2 }, secretEncType: 2 }, messageContextInfo: {} })),
  { kind: "ignored", reason: "secret_encrypted" }
);

// 8) Tipo realmente desconhecido: grava "[mensagem não suportada]" e devolve só os nomes dos campos de
// primeiro nível de data.message (para o log), nunca valores.
const unknown = parseEvolutionMessageEvent(upsert(contactKey(), { tipoNovoFicticioMessage: { texto: "Valor sigiloso ficticio" }, messageContextInfo: { messageSecret: { 0: 1 } }, "chave com espaço": 1 }));
assert.equal(unknown.kind === "upsert" && unknown.content.text, "[mensagem não suportada]");
assert.deepEqual(unknown.kind === "upsert" && unknown.unsupportedFields, ["tipoNovoFicticioMessage", "messageContextInfo"]);
const poll = parseEvolutionMessageEvent(upsert(contactKey(), { pollCreationMessageV3: { name: "Enquete ficticia" } }));
assert.equal(poll.kind === "upsert" && "unsupportedFields" in poll, false, "enquete é conhecida");
const text = parseEvolutionMessageEvent(upsert(contactKey(), { conversation: "Oi ficticio" }));
assert.equal(text.kind === "upsert" && "unsupportedFields" in text, false);

console.log("evolutionMessageParser.test.ts: ok");
