import assert from "node:assert/strict";
import { contactPhoneFromWhatsAppJid, displayPhone, maskPhone, normalizeMobilePhone, normalizeWhatsAppContactPhone, phoneFromWhatsAppJid } from "./phoneMatch.js";

// Regra do número da Fase A do WhatsApp. Só números fictícios.

// 1) Celular do usuário, como gravado em User.phone (55 + DDD + número).
assert.equal(normalizeMobilePhone("5511900000001"), "5511900000001");
assert.equal(normalizeMobilePhone("(11) 90000-0001"), "5511900000001");
assert.equal(normalizeMobilePhone("(11) 3000-0001"), null, "fixo não é aceito");
assert.equal(normalizeMobilePhone(""), null);
assert.equal(normalizeMobilePhone(null), null);

// 2) Número lido no QR (JID da conta conectada).
assert.equal(phoneFromWhatsAppJid("5511900000001@s.whatsapp.net"), "5511900000001");
assert.equal(phoneFromWhatsAppJid("5511900000001:12@s.whatsapp.net"), "5511900000001", "sufixo do aparelho é ignorado");
assert.equal(phoneFromWhatsAppJid("551180000001@s.whatsapp.net"), "5511980000001", "conta antiga sem o nono dígito ganha o 9");
assert.equal(phoneFromWhatsAppJid("123456789012345@lid"), null, "LID não tem número legível");
assert.equal(phoneFromWhatsAppJid("5511900000001-1600000000@g.us"), null, "grupo não é conta");
assert.equal(phoneFromWhatsAppJid("15550000001@s.whatsapp.net"), null, "fora do Brasil é recusado");
assert.equal(phoneFromWhatsAppJid("551130000001@s.whatsapp.net"), null, "fixo é recusado");
assert.equal(phoneFromWhatsAppJid("5511900000001"), null, "sem servidor não é JID");
assert.equal(phoneFromWhatsAppJid("5511900000001@s.whatsapp.net@x"), null);
assert.equal(phoneFromWhatsAppJid(undefined), null);

// 3) Mesmo número dos dois lados, inclusive com o nono dígito faltando no WhatsApp.
assert.equal(phoneFromWhatsAppJid("552180000002@s.whatsapp.net"), normalizeMobilePhone("(21) 98000-0002"));
assert.notEqual(phoneFromWhatsAppJid("5521900000003@s.whatsapp.net"), normalizeMobilePhone("(21) 90000-0004"));

// 4) Exibição.
assert.equal(maskPhone("5511900000001"), "(11) 9****-0001");
assert.equal(maskPhone(null), null);
assert.equal(maskPhone("123"), null);
assert.equal(displayPhone("5511900000001"), "(11) 90000-0001");

// 5) Fase B: número do contato da conversa aceita celular e fixo (WhatsApp Business num fixo).
assert.equal(normalizeWhatsAppContactPhone("(11) 3000-0001"), "551130000001", "fixo vale para contato");
assert.equal(normalizeWhatsAppContactPhone("(11) 90000-0001"), "5511900000001");
assert.equal(normalizeWhatsAppContactPhone("(00) 3000-0001"), null, "DDD inválido");
assert.equal(normalizeWhatsAppContactPhone(undefined), null);
assert.equal(contactPhoneFromWhatsAppJid("551130000001@s.whatsapp.net"), "551130000001", "fixo do WhatsApp Business");
assert.equal(contactPhoneFromWhatsAppJid("551180000001@s.whatsapp.net"), "5511980000001", "celular antigo ganha o 9");
assert.equal(contactPhoneFromWhatsAppJid("5511900000001:3@s.whatsapp.net"), "5511900000001");
assert.equal(contactPhoneFromWhatsAppJid("123456789012345@lid"), null);
assert.equal(contactPhoneFromWhatsAppJid("5511900000001-1600000000@g.us"), null);
assert.equal(contactPhoneFromWhatsAppJid("status@broadcast"), null);
assert.equal(contactPhoneFromWhatsAppJid("15550000001@s.whatsapp.net"), null, "fora do Brasil");
assert.equal(phoneFromWhatsAppJid("551130000001@s.whatsapp.net"), null, "a conta conectada continua só celular");

console.log("phoneMatch.test.ts: ok");
