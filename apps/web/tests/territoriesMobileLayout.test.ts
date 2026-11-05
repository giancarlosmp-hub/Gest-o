import assert from "node:assert/strict";
import fs from "node:fs";
import {
  countTerritoryCitiesByStatus,
  filterTerritoryCities,
  sortTerritoryCitiesForList,
  territoryCityListMetrics,
  type TerritoryCity
} from "../src/lib/territoryMap";

// Territórios no celular (abaixo de 640px): lista compacta de uma linha por cidade com filtro por status só na tela;
// tocar na lista seleciona a cidade no mapa; o painel abaixo do mapa sai (o resumo sobre o mapa já mostra os dados).
// Desktop: painel lateral e tabela como estavam. Dados e regra de cor não mudam (ver territoryMapRules.test.ts).
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = read("../src/pages/TerritoriosPage.tsx");
const brl = (value: number) => `R$ ${value}`;
const city = (name: string, status: TerritoryCity["status"], extra: Partial<TerritoryCity> = {}): TerritoryCity => ({
  city: name, state: "PR", status, statusLabel: status, orderCount: 0, soldValue: 0, openOpportunityCount: 0, ...extra
});

// 1. Ordem: verde, amarelo, vermelho; dentro de cada status, por nome (sem diferenciar acento/maiúscula).
const cities = [
  city("Toledo", "no_sale"),
  city("Cascavel", "positive", { orderCount: 2, soldValue: 30000 }),
  city("Assis", "opportunity", { openOpportunityCount: 1 }),
  city("Ábaco Fictício", "no_sale"),
  city("Bela Vista Fictícia", "positive", { orderCount: 1, soldValue: 500 }),
  city("Zé Fictício", "opportunity", { openOpportunityCount: 2 })
];
assert.deepEqual(sortTerritoryCitiesForList(cities).map((item) => item.city), ["Bela Vista Fictícia", "Cascavel", "Assis", "Zé Fictício", "Ábaco Fictício", "Toledo"]);
assert.equal(cities[0].city, "Toledo", "ordenar não altera a lista original (a tabela do desktop segue a ordem da API)");

// 2. Contagem e filtro só na tela.
assert.deepEqual(countTerritoryCitiesByStatus(cities), { all: 6, positive: 2, opportunity: 2, no_sale: 2 });
assert.deepEqual(filterTerritoryCities(cities, "opportunity").map((item) => item.city), ["Assis", "Zé Fictício"]);
assert.equal(filterTerritoryCities(cities, "all").length, 6);
assert.doesNotMatch(page, /params: \{ sellerId: selectedSellerId, month, (status|filter)/, "sem filtro novo na API");

// 3. Texto da direita: pedidos · vendido · oportunidades, só quando algum for maior que zero.
assert.equal(territoryCityListMetrics(cities[1], brl), "2 pedidos · R$ 30000 · 0 oport.");
assert.equal(territoryCityListMetrics(city("Um", "positive", { orderCount: 1, soldValue: 10 }), brl), "1 pedido · R$ 10 · 0 oport.");
assert.equal(territoryCityListMetrics(cities[2], brl), "0 pedidos · R$ 0 · 1 oport.");
assert.equal(territoryCityListMetrics(cities[0], brl), null, "tudo zerado: só o status");

// 4. Lista compacta só no celular, com os 4 filtros e a contagem; 640–767px mantém os cartões; tabela a partir de md.
assert.match(page, /<div className="p-3 sm:hidden">\s*<div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar cidades por status">/);
for (const [filter, label] of [["all", "Todas"], ["positive", "Verde"], ["opportunity", "Amarelo"], ["no_sale", "Vermelho"]]) {
  assert.ok(page.includes(`["${filter}", "${label}"]`), `filtro ${label}`);
}
assert.match(page, /\{label\} \(\{listCounts\[filter\]\}\)/);
assert.match(page, /aria-pressed=\{listFilter === filter\}/);
assert.match(page, /filterTerritoryCities\(sortTerritoryCitiesForList\(coverage\?\.cities \?\? \[\]\), listFilter\)/);
const mobileList = page.slice(page.indexOf('<ul className="mt-3 divide-y divide-slate-100" aria-label="Cidades do território">'), page.indexOf("</ul>", page.indexOf('aria-label="Cidades do território"')));
assert.ok(mobileList.length > 0, "lista compacta presente");
assert.match(mobileList, /\{city\.city\}\/\{city\.state\}/);
assert.match(mobileList, /statusStyles\[city\.status\]\.badge\}`\}>\{city\.statusLabel\}/);
assert.match(mobileList, /\{metrics \? <span className="max-w-\[55%\] shrink-0 text-right text-\[11px\]/);
assert.match(page, /<div className="hidden gap-3 p-4 sm:grid md:hidden">/);
assert.match(page, /<div className="hidden max-h-\[520px\] overflow-auto md:block">\s*<table/);
assert.match(page, /\{\(coverage\?\.cities \?\? \[\]\)\.map\(\(city\) => \{\s*const style = statusStyles\[city\.status\];\s*return \(\s*<tr /, "tabela do desktop na ordem da API");

// 5. Tocar na lista = mesma seleção do toque no mapa (resumo por cima) e rola até o mapa.
assert.match(mobileList, /onClick=\{\(\) => selectCityFromList\(city\)\}/);
assert.match(page, /const selectCityFromList = \(city: TerritoryCity\) => \{\s*setSelectedCity\(city\);\s*setRevealSelectedKey\(\(current\) => current \+ 1\);\s*mapAreaRef\.current\?\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\);/);
assert.match(page, /<div ref=\{mapAreaRef\} className="relative overflow-hidden rounded-3xl/);
assert.match(page, /revealSelectedKey=\{revealSelectedKey\}/);
assert.match(page, /\{selectedCity && !hasNoTerritory \? \(\s*<div className="absolute inset-x-3 bottom-8 z-10 rounded-\[1rem\][^"]*lg:hidden"/);

// 6. Celular sem o painel "Cidade selecionada"/cartão vazio abaixo do mapa; tablet e desktop como estavam.
assert.match(page, /<div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm max-sm:hidden lg:hidden">\s*<CityDetailPanel city=\{selectedCity\} sellerName=\{coverage\?\.seller\.name\} \/>/);
assert.match(page, /<aside className="hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:block">\s*<CityDetailPanel city=\{selectedCity\} sellerName=\{coverage\?\.seller\.name\} compact \/>/);

console.log("TERRITORIES_MOBILE_LAYOUT=PASS");
