import assert from "node:assert/strict";
import fs from "node:fs";

// O campo segment do cliente recebe o endereço do ERP: as telas mostram "Endereço", nunca "Segmento".
const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(app, /\{ key: "segment", label: "Endereço" \}/, "coluna da lista e formulário mostram Endereço");

const details = fs.readFileSync(new URL("../src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
assert.match(details, /<p><strong>Endereço:<\/strong> \{client\.segment \|\| "-"\}<\/p>/, "detalhe mostra Endereço");

const list = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(list, /\{ key: "segment", label: "endereco", required: false \}/, "mapeamento da importação mostra endereco");
assert.match(list, /segment: \["segment", "segmento", "endereco",/, "planilhas antigas com coluna segmento continuam mapeando");

for (const [name, source] of [["App.tsx", app], ["ClientDetailsPage.tsx", details]] as const) {
  assert.doesNotMatch(source, /Segmento/, `${name} não exibe mais Segmento`);
}

console.log("CLIENT_ADDRESS_LABEL=PASS");
