import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  SELECTED_CITY_STROKE,
  createOutOfTerritoryCity,
  getCityGeoMatch,
  getCityStateNameKey,
  statusFillColors,
  statusStrokeColors,
  territoryCityPathStyle,
  type TerritoryCity,
  type TerritoryMunicipalityFeature
} from "../src/lib/territoryMap";

// Contrato do mapa de Territórios: a troca do fundo (SVG próprio -> Leaflet + OpenStreetMap) não pode mudar a regra de
// cor de cada cidade, a legenda, o seletor de vendedor e mês, os números do topo nem o detalhe da cidade.
// Se este teste falhar, a mudança altera a regra do mapa: precisa de aprovação explícita antes de atualizar o teste.
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const routes = read("../../api/src/routes/crudRoutes.ts");
const page = read("../src/pages/TerritoriosPage.tsx");
const mapComponent = read("../src/components/territories/TerritoryLeafletMap.tsx");
const webPackage = JSON.parse(read("../package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

// 1. API (onde a cor é decidida): o bloco inteiro de GET /territories/coverage está congelado por hash.
const routeStart = routes.indexOf('router.get("/territories/coverage"');
const routeEnd = routes.indexOf("const userListSelect", routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart, "rota GET /territories/coverage encontrada");
const routeBlock = routes.slice(routeStart, routeEnd).trimEnd();
assert.equal(
  createHash("sha256").update(routeBlock).digest("hex"),
  "a23e1539c14500094d5bc168ea956c27af3d1dd71a26d27b9a6e27ff3ad70314",
  "o bloco de GET /territories/coverage mudou: a regra de cor do mapa precisa de aprovação"
);
// Leitura do que o hash protege (documentação viva da regra):
// verde = pedido ERP enviado (status sent) do vendedor no mês, por sentAt ou createdAt quando sentAt está vazio;
assert.match(routeBlock, /status: ErpOrderSyncStatus\.sent,\s*OR: \[\s*\{ sentAt: monthInstantRange \},\s*\{ sentAt: null, createdAt: monthInstantRange \}\s*\]/);
// amarelo = oportunidade do vendedor em prospecção/negociação/proposta com data de proposta no mês;
assert.match(routeBlock, /ownerSellerId: sellerId,\s*stage: \{ in: \[\.\.\.OPEN_TERRITORY_OPPORTUNITY_STAGES\] \},\s*proposalDate: \{ gte: start, lt: end \}/);
assert.match(routes, /const OPEN_TERRITORY_OPPORTUNITY_STAGES = \[OpportunityStage\.prospeccao, OpportunityStage\.negociacao, OpportunityStage\.proposta\] as const;/);
// pedido tem precedência sobre oportunidade; o resto do território é vermelho.
assert.match(routeBlock, /const status = orderMetrics\.orderCount > 0\s*\? "positive"\s*: opportunityMetrics\.openOpportunityCount > 0\s*\? "opportunity"\s*: "no_sale";/);
// a cidade do pedido/oportunidade é a do cliente, pela mesma chave UF + nome normalizado.
assert.match(routes, /const getTerritoryCityNormalizedKey = \(state: string, city: string\) => `\$\{normalizeState\(state\)\}::\$\{normalizeTerritoryCityKey\(city\)\}`;/);

// 2. Web: cada status mantém a mesma cor (preenchimento e borda) do mapa anterior.
assert.deepEqual(statusFillColors, { positive: "#059669", opportunity: "#f59e0b", no_sale: "#dc2626", out_of_territory: "#e8edf3" });
assert.deepEqual(statusStrokeColors, { positive: "#065f46", opportunity: "#92400e", no_sale: "#991b1b", out_of_territory: "#b8c2cc" });
assert.equal(SELECTED_CITY_STROKE, "#020617");
for (const status of ["positive", "opportunity", "no_sale", "out_of_territory"] as const) {
  const style = territoryCityPathStyle(status, false);
  assert.equal(style.fillColor, statusFillColors[status]);
  assert.equal(style.color, statusStrokeColors[status]);
  const selected = territoryCityPathStyle(status, true);
  assert.equal(selected.fillColor, statusFillColors[status], "selecionar não troca a cor do status");
  assert.equal(selected.color, SELECTED_CITY_STROKE);
}
// O polígono usa o status que veio da API (por IBGE, senão UF + nome); sem correspondência, é "fora do território".
const apiCity: TerritoryCity = { city: "Cidade Fictícia", state: "PR", status: "opportunity", statusLabel: "Oportunidade aberta", ibgeCode: "4100001", orderCount: 0, soldValue: 0, openOpportunityCount: 1 };
const feature = (props: TerritoryMunicipalityFeature["properties"]): TerritoryMunicipalityFeature => ({ type: "Feature", properties: props, geometry: null });
const byIbge = new Map([["4100001", apiCity]]);
const byName = new Map([[getCityStateNameKey("PR", "Cidade Fictícia"), apiCity]]);
assert.equal(getCityGeoMatch(feature({ id: "4100001", name: "Outro Nome" }), byIbge, byName), apiCity);
assert.equal(getCityGeoMatch(feature({ name: "CIDADE FICTICIA", __state: "PR" }), new Map(), byName), apiCity);
assert.equal(getCityGeoMatch(feature({ id: "4100002", name: "Sem Vínculo", __state: "PR" }), byIbge, byName), null);
assert.equal(createOutOfTerritoryCity("Sem Vínculo", "PR").status, "out_of_territory");
assert.match(page, /getCityGeoMatch\(feature, citiesByIbgeCode, citiesByStateAndName\)\s*\?\? createOutOfTerritoryCity\(getFeatureCityName\(feature\), getFeatureState\(feature\)\)/);
assert.match(mapComponent, /territoryCityPathStyle\(resolveCity\(feature\)\.status, isFeatureSelected\(feature, selectedRef\.current\)\)/);

// 3. Legenda igual.
for (const [dot, label] of [
  ["bg-emerald-600", "Verde: pedido ERP"],
  ["bg-amber-500", "Amarelo: oportunidade"],
  ["bg-red-600", "Vermelho: sem venda"],
  ["bg-slate-200 ring-1 ring-slate-300", "Cinza: fora"]
]) {
  assert.ok(page.includes(`<span className="h-3 w-3 rounded-full ${dot}" />${label}</span>`), `legenda: ${label}`);
}
assert.ok(page.includes("<p>Cidades coloridas fazem parte do território do vendedor.</p>"));
assert.ok(page.includes("<p>Cidades em cinza estão fora do território.</p>"));

// 4. Seletor de vendedor (travado para vendedor) e mês.
assert.match(page, /value=\{selectedSellerId\}\s*onChange=\{\(event\) => setSelectedSellerId\(event\.target\.value\)\}\s*disabled=\{!canChooseSeller\}/);
assert.match(page, /const canChooseSeller = user\?\.role === "diretor" \|\| user\?\.role === "gerente";/);
assert.match(page, /type="month"\s*value=\{month\}\s*onChange=\{\(event\) => setMonth\(event\.target\.value\)\}/);
assert.match(page, /api\.get<TerritoryCoverageResponse>\("\/territories\/coverage", \{ params: \{ sellerId: selectedSellerId, month \} \}\)/);

// 5. Números do topo: mesmos títulos e mesmas fontes da resposta da API.
for (const [title, source] of [
  ["Total de cidades", "formatNumberBR(coverage?.summary.totalCities ?? 0)"],
  ["Cidades positivadas", "formatNumberBR(coverage?.summary.positiveCities ?? 0)"],
  ["Oportunidade aberta", "formatNumberBR(coverage?.summary.opportunityCities ?? 0)"],
  ["Cidades sem venda", "formatNumberBR(coverage?.summary.noSaleCities ?? 0)"],
  ["Cobertura", "formatPercentBR(coverage?.summary.coveragePercent ?? 0, 1)"],
  ["Valor vendido", "formatCurrencyBRL(coverage?.summary.soldValue ?? 0)"]
]) {
  assert.ok(page.includes(`<SummaryCard title="${title}" value={${source}}`), `número do topo: ${title}`);
}

// 6. Detalhe da cidade: mesmos campos no painel; ao tocar no mapa, a cidade selecionada é a da API.
for (const [label, value] of [
  ["Vendedor", 'sellerName ?? "-"'],
  ["Código IBGE", 'city.ibgeCode ?? "-"'],
  ["Pedidos ERP", "city.orderCount"],
  ["Valor vendido", "formatCurrencyBRL(city.soldValue)"],
  ["Oportunidades abertas", "city.openOpportunityCount"]
]) {
  assert.ok(page.includes(`<DetailRow label="${label}" value={${value}} />`), `detalhe: ${label}`);
}
assert.match(page, /onSelectCity=\{setSelectedCity\}/);
assert.match(mapComponent, /featureLayer\.on\("click", \(\) => onSelectRef\.current\(city\)\)/);
// Subtítulo diz o que o painel mostra.
assert.ok(page.includes("Toque em uma cidade para ver pedidos, valor vendido e oportunidades."));
assert.ok(!page.includes("ver clientes, oportunidades e pedidos"));

// 7. Fundo: Leaflet 1.9.4 puro (sem react-leaflet) e tiles do OpenStreetMap com a atribuição visível.
assert.equal(webPackage.dependencies.leaflet, "1.9.4");
assert.match(webPackage.devDependencies["@types/leaflet"] ?? "", /^\^1\.9\./);
assert.ok(!("react-leaflet" in webPackage.dependencies) && !("react-leaflet" in webPackage.devDependencies));
assert.match(mapComponent, /^import L from "leaflet";$/m);
assert.match(mapComponent, /^import "leaflet\/dist\/leaflet\.css";$/m);
assert.match(mapComponent, /OSM_TILE_URL = "https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png"/);
assert.ok(mapComponent.includes('OSM_ATTRIBUTION = \'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors\''));
assert.match(mapComponent, /attribution: OSM_ATTRIBUTION/);
// Pinça e arrasto no celular; botões de zoom e recentralizar mantidos.
assert.match(mapComponent, /touchZoom: true/);
assert.match(mapComponent, /dragging: true/);
for (const label of ["Aproximar mapa", "Afastar mapa", "Recentralizar mapa"]) {
  assert.ok(mapComponent.includes(`aria-label="${label}"`), label);
}
// Leaflet fora do pacote principal: o mapa é carregado sob demanda pela página.
assert.match(page, /const TerritoryLeafletMap = lazy\(\(\) => import\("\.\.\/components\/territories\/TerritoryLeafletMap"\)\);/);
assert.ok(!/from "leaflet"/.test(page), "a página não importa o Leaflet direto");
// O SVG próprio saiu.
assert.ok(!page.includes("<svg"), "mapa SVG antigo removido");

console.log("TERRITORY_MAP_RULES=PASS");
