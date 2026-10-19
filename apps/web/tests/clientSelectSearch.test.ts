import assert from "node:assert/strict";
import fs from "node:fs";
import { CLIENT_SELECT_PAGE_SIZE, clientSearchParams, readClientSearchItems, withSelectedClient } from "../src/lib/clientSelectSearch.js";

// Dados fictícios: busca do ClientSelect (filtro "Cliente" de Atividades) em GET /clients.
const client = (n: number, extra: Record<string, string> = {}) => ({
  id: `cli-${n}`, name: `Cliente Ficticio ${String(n).padStart(2, "0")}`, code: `C${n}`, city: "Cidade Ficticia A", state: "PR", ...extra,
});

// A busca manda q (parâmetro que a API lê), com página e 20 resultados; texto vazio não busca.
assert.deepEqual(clientSearchParams("fazenda"), { q: "fazenda", page: 1, pageSize: 20 });
assert.deepEqual(clientSearchParams("  C12 "), { q: "C12", page: 1, pageSize: 20 });
assert.equal(CLIENT_SELECT_PAGE_SIZE, 20);
assert.equal(clientSearchParams(""), null);
assert.equal(clientSearchParams("   "), null);
assert.equal("search" in (clientSearchParams("x") ?? {}), false);

// Resposta paginada ({ items, ... }) é lida; o array antigo e respostas inesperadas não quebram.
const page = Array.from({ length: 20 }, (_, i) => client(i + 1));
assert.deepEqual(readClientSearchItems({ items: page, total: 45, page: 1, pageSize: 20 }), page);
assert.deepEqual(readClientSearchItems([client(1)]), [client(1)]);
assert.deepEqual(readClientSearchItems({ total: 0 }), []);
assert.deepEqual(readClientSearchItems(null), []);

// Cliente já selecionado fora dos 20 primeiros: continua na lista quando bate com a busca (nome, código ou cidade).
const selected = client(45, { city: "Cidade Ficticia Z" });
assert.deepEqual(withSelectedClient(page, selected, "Cliente Ficticio").map((c) => c.id), ["cli-45", ...page.map((c) => c.id)]);
assert.equal(withSelectedClient(page, selected, "c45")[0].id, "cli-45");
assert.equal(withSelectedClient(page, selected, "ficticia z")[0].id, "cli-45");
// Já está nos resultados: não duplica. Não bate com a busca ou não há seleção: lista igual à da API.
assert.equal(withSelectedClient([...page, selected], selected, "Cliente").length, 21);
assert.deepEqual(withSelectedClient(page, selected, "outro nome"), page);
assert.deepEqual(withSelectedClient(page, null, "Cliente"), page);

// O componente usa esses helpers e não manda mais ?search=.
const component = fs.readFileSync(new URL("../src/components/ClientSelect.tsx", import.meta.url), "utf8");
assert.doesNotMatch(component, /search=/);
assert.match(component, /api\.get\("\/clients", \{ params \}\)/);
assert.match(component, /readClientSearchItems\(res\.data\)/);
assert.match(component, /withSelectedClient\(/);

console.log("CLIENT_SELECT_SEARCH=PASS sends_q=PASS paginated=PASS selected_kept=PASS");
