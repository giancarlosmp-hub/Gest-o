import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientLastContactOf } from "../src/lib/clientLastContact";

// "Último contato" do cliente: atividade ou mensagem enviada pelo WhatsApp (a API calcula lastContactAt).
// Dados fictícios.

assert.equal(clientLastContactOf({ lastContactAt: "2026-11-14T12:00:00.000Z", lastActivityAt: "2026-11-01T12:00:00.000Z" }), "2026-11-14T12:00:00.000Z");
// Só conversa do WhatsApp, sem atividade.
assert.equal(clientLastContactOf({ lastContactAt: "2026-11-14T12:00:00.000Z", lastActivityAt: null }), "2026-11-14T12:00:00.000Z");
// Resposta antiga da API (sem o campo): vale a última atividade.
assert.equal(clientLastContactOf({ lastActivityAt: "2026-11-01T12:00:00.000Z" }), "2026-11-01T12:00:00.000Z");
assert.equal(clientLastContactOf({ lastContactAt: null, lastActivityAt: null }), null);
assert.equal(clientLastContactOf(null), null);

// A tela do cliente e o resumo de reserva mostram "Último contato" com o helper.
const page = readFileSync(new URL("../src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
assert.match(page, />Último contato</);
assert.doesNotMatch(page, />Última atividade</);
assert.match(page, /formatDate\(clientLastContactOf\(client\.commercialSummary\)\)/);
const card = readFileSync(new URL("../src/components/clients/ClientAutoSummaryCard.tsx", import.meta.url), "utf8");
assert.match(card, /Último contato:<\/span> \{formatDatePtBr\(clientLastContactOf\(fallbackSummary\)\)\}/);

console.log("clientLastContact.test.ts: ok");
