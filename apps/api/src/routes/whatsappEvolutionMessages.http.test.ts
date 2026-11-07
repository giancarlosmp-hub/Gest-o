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
const FILE_NAME = "arquivo-ficticio-sigiloso.pdf";
const EDITED_TEXT = "Texto editado ficticio sigiloso";
const UNKNOWN_VALUE = "Valor ficticio sigiloso de tipo novo";

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

  // 2b) Tamanho real do Evolution v2.3.7: os binários da mensagem chegam como Uint8Array serializado,
  // {"0":12,"1":34,...} (~10 bytes por byte). Imagem e documento com miniatura de 60 KB passam de 512 KiB
  // (o limite antigo, que devolvia 413) e precisam ser gravados. Bytes fictícios.
  const binary = (size: number, seed: number) => JSON.parse(JSON.stringify(Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 256)));
  const contextInfo = { deviceListMetadata: { senderKeyHash: binary(10, 1), senderTimestamp: 1_794_000_000, recipientKeyHash: binary(10, 2), recipientTimestamp: 1_794_000_000 }, deviceListMetadataVersion: 2, messageSecret: binary(32, 3) };
  const media = (mimetype: string, thumbnailBytes: number) => ({
    url: "https://mmg.invalid/midia-ficticia", mimetype, fileSha256: binary(32, 4), fileLength: 123_456, mediaKey: binary(32, 5), fileEncSha256: binary(32, 6),
    directPath: "/midia-ficticia", mediaKeyTimestamp: 1_794_000_000, ...(thumbnailBytes ? { jpegThumbnail: binary(thumbnailBytes, 7) } : {})
  });
  const real = {
    text: upsert(`${KEY_ID}-REAL-TXT`, { conversation: TEXT, messageContextInfo: contextInfo }),
    image: upsert(`${KEY_ID}-REAL-IMG`, { imageMessage: { ...media("image/jpeg", 60 * 1024), caption: CAPTION, height: 1280, width: 960, scansSidecar: binary(80, 8), midQualityFileSha256: binary(32, 9) }, messageContextInfo: contextInfo }),
    document: upsert(`${KEY_ID}-REAL-DOC`, { documentMessage: { ...media("application/pdf", 60 * 1024), fileName: FILE_NAME, caption: CAPTION, pageCount: 3 }, messageContextInfo: contextInfo }),
    audio: upsert(`${KEY_ID}-REAL-AUD`, { audioMessage: { ...media("audio/ogg; codecs=opus", 0), seconds: 12, ptt: true, waveform: binary(64, 10) }, messageContextInfo: contextInfo }),
    reply: (() => {
      // Resposta a uma imagem: o Evolution põe a mensagem citada (com a miniatura) em data.contextInfo.
      const event = upsert(`${KEY_ID}-REAL-RPL`, { conversation: TEXT, messageContextInfo: contextInfo });
      return { ...event, data: { ...event.data, contextInfo: { stanzaId: `${KEY_ID}-CITADA`, participant: `${CONTACT}@s.whatsapp.net`, quotedMessage: { imageMessage: { ...media("image/jpeg", 60 * 1024), caption: CAPTION } } } } };
    })()
  };
  const sizeKiB = (body: unknown) => Buffer.byteLength(JSON.stringify(body)) / 1024;
  for (const name of ["image", "document", "reply"] as const) assert(sizeKiB(real[name]) > 512, `${name} passa de 512 KiB (${sizeKiB(real[name]).toFixed(0)} KiB)`);
  for (const [name, body] of Object.entries(real)) {
    const response = await post(body);
    assert.equal(response.status, 200, `${name}: ${response.status}`);
    assert.deepEqual(response.json, { status: "stored" }, name);
  }

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

  // 5b) Edição e revogação em messages.upsert (caso visto em produção: a edição virava uma linha UNKNOWN).
  // Formatos do Baileys 7.0.0-rc.9 com o JSON do Evolution v2.3.7: binários como {"0":..}, enum como número.
  const original = (id: string, fromMe = false) => upsert(id, { conversation: TEXT, messageContextInfo: contextInfo }, fromMe);
  const notice = (noticeId: string, message: unknown) => {
    const event = upsert(noticeId, { ...(message as object), messageContextInfo: contextInfo });
    return { ...event, data: { ...event.data, messageType: "protocolMessage" } };
  };
  const editOf = (targetId: string, text = EDITED_TEXT) => ({
    key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: true, id: targetId },
    type: 14,
    editedMessage: { conversation: text, messageContextInfo: { messageSecret: binary(32, 11) } },
    timestampMs: "1794000060000"
  });
  const textOf = (id: string) => memory.messages.find((row) => row.externalMessageId === id);
  const editFormats = {
    solto: (id: string) => ({ protocolMessage: editOf(id) }),
    editedMessage: (id: string) => ({ editedMessage: { message: { protocolMessage: editOf(id) } } }),
    temporaria: (id: string) => ({ ephemeralMessage: { message: { protocolMessage: editOf(id) } } })
  };
  for (const [name, format] of Object.entries(editFormats)) {
    const id = `${KEY_ID}-ED-${name}`;
    assert.deepEqual((await post(original(id))).json, { status: "stored" }, name);
    const rows: number = memory.messages.length;
    const edited = await post(notice(`${KEY_ID}-AVISO-${name}`, format(id)));
    assert.equal(edited.status, 200, name);
    assert.deepEqual(edited.json, { status: "updated" }, name);
    assert.equal(memory.messages.length, rows, `${name}: nenhuma linha nova`);
    assert.equal(textOf(id)?.textContent, EDITED_TEXT, name);
    assert.equal(textOf(id)?.metadata.previousText, TEXT, name);
    assert.equal(typeof textOf(id)?.metadata.editedAt, "string", name);
    assert.deepEqual((await post(notice(`${KEY_ID}-AVISO-${name}`, format(id)))).json, { status: "duplicate" }, `${name}: reentrega`);
  }
  const rowsBeforeProtocol = memory.messages.length;
  assert.deepEqual((await post(notice(`${KEY_ID}-AVISO-SEM-ORIGINAL`, { protocolMessage: editOf(`${KEY_ID}-NUNCA-GRAVADA`) }))).json, { status: "not_found" });
  assert.deepEqual((await post(notice(`${KEY_ID}-AVISO-TEMPORARIAS`, { protocolMessage: { type: 3, ephemeralExpiration: 604_800 } }))).json, { status: "ignored" });
  assert.deepEqual(
    (await post(notice(`${KEY_ID}-AVISO-CIFRADO`, { secretEncryptedMessage: { targetMessageKey: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: true, id: `${KEY_ID}-ED-solto` }, encPayload: binary(48, 12), encIv: binary(12, 13), secretEncType: 2 } }))).json,
    { status: "ignored" }
  );
  // Revogação no upsert: do contato vira "[mensagem apagada]" (sai o texto anterior da edição); do vendedor
  // mantém o texto com a marca.
  assert.deepEqual((await post(notice(`${KEY_ID}-AVISO-REVOGA-1`, { protocolMessage: { key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: false, id: `${KEY_ID}-ED-solto` }, type: 0 } }))).json, { status: "updated" });
  assert.equal(textOf(`${KEY_ID}-ED-solto`)?.textContent, "[mensagem apagada]");
  assert.equal(textOf(`${KEY_ID}-ED-solto`)?.metadata.previousText, undefined);
  assert.equal(typeof textOf(`${KEY_ID}-ED-solto`)?.metadata.deletedInWhatsAppAt, "string");
  assert.deepEqual((await post(original(`${KEY_ID}-ED-VENDEDOR`, true))).json, { status: "stored" });
  const rowsBeforeSellerRevoke = memory.messages.length;
  assert.deepEqual((await post(notice(`${KEY_ID}-AVISO-REVOGA-2`, { ephemeralMessage: { message: { protocolMessage: { key: { remoteJid: `${CONTACT}@s.whatsapp.net`, fromMe: true, id: `${KEY_ID}-ED-VENDEDOR` }, type: 0 } } } }))).json, { status: "updated" });
  assert.equal(textOf(`${KEY_ID}-ED-VENDEDOR`)?.textContent, TEXT);
  assert.equal(typeof textOf(`${KEY_ID}-ED-VENDEDOR`)?.metadata.deletedInWhatsAppAt, "string");
  assert.equal(memory.messages.length, rowsBeforeSellerRevoke);
  assert.equal(memory.messages.length, rowsBeforeProtocol + 1, "só a mensagem do vendedor entrou");
  assert.equal(memory.messages.some((row) => row.externalMessageId.includes("-AVISO-")), false);
  assert.equal(memory.messages.some((row) => row.type === "UNKNOWN"), false, "nenhum aviso virou UNKNOWN");

  // 5c) Tipo realmente desconhecido: grava "[mensagem não suportada]" e loga WARN só com os nomes dos campos.
  assert.deepEqual((await post(upsert(`${KEY_ID}-TIPO-NOVO`, { tipoNovoFicticioMessage: { texto: UNKNOWN_VALUE, url: "https://mmg.invalid/novo" }, messageContextInfo: contextInfo }))).json, { status: "stored" });
  assert.equal(textOf(`${KEY_ID}-TIPO-NOVO`)?.type, "UNKNOWN");
  const warn = logs.find((line) => line.includes("[whatsapp] unsupported message type"));
  assert(warn, "WARN do tipo desconhecido");
  assert.match(warn, /WARN/);
  assert.match(warn, /tipoNovoFicticioMessage/);
  assert.match(warn, /messageContextInfo/);
  assert.doesNotMatch(warn, /texto|url|deviceListMetadata|messageSecret/, "só o primeiro nível, sem valores");

  // 6) Logs: há registro de cada evento, sem nenhum dado da mensagem.
  const logged = logs.join("\n");
  assert.match(logged, /\[whatsapp\] message event/);
  assert.match(logged, /"status":"stored"/);
  assert.match(logged, /\[whatsapp\] message event failed/);
  assert.match(logged, /P2024/);
  for (const forbidden of [TEXT, CAPTION, PUSH_NAME, CONTACT, "900000201", `${CONTACT}@s.whatsapp.net`, "s.whatsapp.net", KEY_ID, "FALHA-ID", "RAJADA-", INSTANCE_TOKEN, SECRET, "mmg.invalid", "5511900000001", FILE_NAME, "-REAL-", "-CITADA", EDITED_TEXT, UNKNOWN_VALUE, "-AVISO-", "-ED-", "-TIPO-NOVO", "-NUNCA-GRAVADA"]) {
    assert.equal(logged.includes(forbidden), false, `log sem ${forbidden}`);
  }

  console.log("whatsappEvolutionMessages.http.test.ts: ok");
} finally {
  whatsappMessageIngestion.store = originalStore;
  harness.restoreConsole();
  server.close();
}
