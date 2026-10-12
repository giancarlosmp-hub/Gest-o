import assert from "node:assert/strict";
import { buildWhatsAppUrl } from "../src/lib/whatsappLink.js";

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

console.log("WhatsApp link regression tests passed");
