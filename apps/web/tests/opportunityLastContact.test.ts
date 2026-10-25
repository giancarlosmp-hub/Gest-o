import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Aparelho em outro fuso: o dia e a hora continuam os de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { lastContactFormDayOf, lastContactPayloadOf } = await import("../src/lib/opportunityLastContact");

const now = new Date("2026-10-25T13:40:00.000Z"); // 10:40 de Brasília

// O campo mostra o dia de Brasília: 22h de 20/10 em Brasília (01h UTC de 21/10) continua 20/10.
assert.equal(lastContactFormDayOf("2026-10-21T01:00:00.000Z"), "2026-10-20");
assert.equal(lastContactFormDayOf(null), "");
assert.equal(lastContactFormDayOf("data-invalida"), "");

// Sem mudança, vazio ou apagado: nada vai para a API.
assert.equal(lastContactPayloadOf("2026-10-20", "2026-10-20", now), undefined, "editar outro campo não reenvia o último contato");
assert.equal(lastContactPayloadOf("", "2026-10-20", now), undefined, "apagar o campo não envia vazio");
assert.equal(lastContactPayloadOf("", "", now), undefined);

// Mudou: o dia escolhido com a hora atual de Brasília (na criação, a base é vazia).
assert.equal(lastContactPayloadOf("2026-10-23", "2026-10-20", now), "2026-10-23T13:40:00.000Z");
assert.equal(lastContactPayloadOf("2026-10-24", "", now), "2026-10-24T13:40:00.000Z");

// O formulário usa os dois helpers e guarda o dia original da edição.
const page = readFileSync(new URL("../src/pages/OpportunitiesPage.tsx", import.meta.url), "utf8");
assert.match(page, /lastContactAt: lastContactPayloadOf\(form\.lastContactAt, editing \? editingLastContactDay : ""\)/);
assert.match(page, /lastContactAt: lastContactFormDayOf\(item\.lastContactAt\)/);
assert.match(page, /setEditingLastContactDay\(lastContactFormDayOf\(item\.lastContactAt\)\)/);
assert.doesNotMatch(page, /lastContactAt: form\.lastContactAt \|\| undefined/, "o envio antigo, só com a data, saiu");

console.log("OPPORTUNITY_LAST_CONTACT_FORM=PASS brazil_day=PASS unchanged_not_sent=PASS changed_with_brazil_time=PASS form_wired=PASS");
