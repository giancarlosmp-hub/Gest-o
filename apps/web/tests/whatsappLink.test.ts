import assert from "node:assert/strict";
import { buildWhatsAppUrl } from "../src/lib/whatsappLink.js";

const { normalizeBrazilPhone, splitPhoneField } = await import("@salesforce-pro/shared");

// Números fictícios.
assert.equal(buildWhatsAppUrl("(11) 98888-7777", "Olá"), "https://wa.me/5511988887777?text=Ol%C3%A1");
assert.equal(buildWhatsAppUrl("+55 11 98888-7777", "Olá"), "https://wa.me/5511988887777?text=Ol%C3%A1");
assert.equal(buildWhatsAppUrl("5511988887777", "Oi"), "https://wa.me/5511988887777?text=Oi");
assert.equal(buildWhatsAppUrl("551133334444", "Oi"), "https://wa.me/551133334444?text=Oi");
// DDD 55 sem código do país continua recebendo o 55.
assert.equal(buildWhatsAppUrl("55988887777", "Oi"), "https://wa.me/5555988887777?text=Oi");
assert.equal(buildWhatsAppUrl("5533334444", "Oi"), "https://wa.me/555533334444?text=Oi");
assert.equal(buildWhatsAppUrl("", "Oi"), "https://web.whatsapp.com/send?text=Oi");
assert.equal(buildWhatsAppUrl(null, "Oi"), "https://web.whatsapp.com/send?text=Oi");

// Normalização (packages/shared), com números fictícios em cada formato do ERP.
const mobile = (raw: string, e164: string, display: string, insertedNinthDigit = false) =>
  assert.deepEqual(normalizeBrazilPhone(raw), {
    valid: true,
    kind: "mobile",
    e164,
    display,
    tel: `tel:+${e164}`,
    whatsapp: `https://wa.me/${e164}`,
    insertedNinthDigit
  }, raw);
const landline = (raw: string, e164: string, display: string) =>
  assert.deepEqual(normalizeBrazilPhone(raw), {
    valid: true,
    kind: "landline",
    e164,
    display,
    tel: `tel:+${e164}`,
    whatsapp: `https://wa.me/${e164}`,
    insertedNinthDigit: false
  }, raw);
const textOnly = (raw: string, display = raw) =>
  assert.deepEqual(normalizeBrazilPhone(raw), { valid: false, display, tel: null, whatsapp: null }, raw);

// "(DD) NNNN-NNNN": fixo (2 a 5) ganha Ligar + WhatsApp; celular antigo (6 a 9) ganha o nono dígito.
landline("(11) 3333-4444", "551133334444", "(11) 3333-4444");
landline("(41) 2222-0000", "554122220000", "(41) 2222-0000");
landline("(51) 5555-1234", "555155551234", "(51) 5555-1234");
mobile("(11) 8888-7777", "5511988887777", "(11) 98888-7777", true);
mobile("(21) 6666-1234", "5521966661234", "(21) 96666-1234", true);
mobile("(31) 7777-1234", "5531977771234", "(31) 97777-1234", true);
mobile("(48) 9999-1234", "5548999991234", "(48) 99999-1234", true);
// "DD 9 NNNN-NNNN", "DD NNNNNNNNN" e só dígitos.
mobile("11 9 8888-7777", "5511988887777", "(11) 98888-7777");
mobile("11 988887777", "5511988887777", "(11) 98888-7777");
mobile("11988887777", "5511988887777", "(11) 98888-7777");
landline("1133334444", "551133334444", "(11) 3333-4444");
mobile("1188887777", "5511988887777", "(11) 98888-7777", true);
// Com código do país.
mobile("+55 (11) 98888-7777", "5511988887777", "(11) 98888-7777");
landline("551133334444", "551133334444", "(11) 3333-4444");
// DDD 55 sem código do país.
mobile("(55) 98888-7777", "5555988887777", "(55) 98888-7777");

// Sem DDD, DDD inválido ou tamanho estranho: só o texto, sem botões (DDD nunca deduzido pela cidade).
textOnly("3333-4444");
textOnly("98888-7777");
textOnly("(20) 3333-4444");
textOnly("(10) 98888-7777");
textOnly("(11) 1333-4444");
textOnly("(11) 88888-7777");
textOnly("123");
textOnly("(11) 3333-44445");
textOnly("  (11)   333  ", "(11) 333");

// Vários números no mesmo campo.
assert.deepEqual(splitPhoneField("(11) 3333-4444 / (11) 98888-7777"), ["(11) 3333-4444", "(11) 98888-7777"]);
assert.deepEqual(splitPhoneField("(11) 3333-4444; 11 9 8888-7777, 1122223333"), ["(11) 3333-4444", "11 9 8888-7777", "1122223333"]);
assert.deepEqual(splitPhoneField("(11) 3333-4444 e (11) 98888-7777"), ["(11) 3333-4444", "(11) 98888-7777"]);
assert.deepEqual(splitPhoneField("11 9 8888-7777"), ["11 9 8888-7777"]);
assert.deepEqual(splitPhoneField(1133334444), ["1133334444"]);
assert.deepEqual(splitPhoneField(""), []);
assert.deepEqual(splitPhoneField("  -  "), []);
assert.deepEqual(splitPhoneField(null), []);
assert.deepEqual(splitPhoneField({ TELEFONE: "1133334444" }), []);

console.log("WhatsApp link regression tests passed");
