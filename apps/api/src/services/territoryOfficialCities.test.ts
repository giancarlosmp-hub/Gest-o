import assert from "node:assert/strict";
import {
  distanceKm,
  findOfficialTerritoryCity,
  listOfficialTerritoryCities,
  normalizeTerritoryCityKey,
  officialTerritoryCityPoint,
  parsePlacemarkCityName,
  resolvePlacemarkCities
} from "./territoryOfficialCities.js";

// Catálogo oficial do IBGE embutido: totais por UF, municípios recentes e nomes repetidos entre UFs.
assert.equal(listOfficialTerritoryCities("PR").length, 399);
assert.equal(listOfficialTerritoryCities("SC").length, 295);
assert.equal(listOfficialTerritoryCities("MS").length, 79);
assert.equal(listOfficialTerritoryCities().length, 399 + 295 + 79);
assert.equal(listOfficialTerritoryCities("SP").length, 0, "UF fora do território");
for (const city of listOfficialTerritoryCities()) assert.match(city.ibgeCode ?? "", /^(41|42|50)\d{5}$/, `${city.city}/${city.state} com código IBGE`);

assert.equal(findOfficialTerritoryCity("SC", "Pescaria Brava")?.ibgeCode, "4212650");
assert.equal(findOfficialTerritoryCity("SC", "Balneario Rincao")?.ibgeCode, "4220000", "sem acento");
assert.equal(findOfficialTerritoryCity("MS", "PARAÍSO DAS ÁGUAS")?.ibgeCode, "5006275", "maiúsculas");
assert.equal(findOfficialTerritoryCity("SC", "Grão Pará")?.city, "Grão-Pará", "hífen = espaço");
assert.equal(findOfficialTerritoryCity("PR", "Irati")?.ibgeCode, "4110706");
assert.equal(findOfficialTerritoryCity("SC", "Irati")?.ibgeCode, "4207858");
assert.equal(findOfficialTerritoryCity("PR", "nome qualquer", "4104808")?.city, "Cascavel", "código IBGE tem precedência");
assert.equal(normalizeTerritoryCityKey("  Pérola  D’Oeste "), "perola d oeste");
assert.equal(normalizeTerritoryCityKey("Diamante D'Oeste"), normalizeTerritoryCityKey("diamante d oeste"), "apóstrofo = espaço");
assert.equal(findOfficialTerritoryCity("PR", "diamante d oeste")?.city, "Diamante D'Oeste", "nome do ERP sem apóstrofo");
assert.equal(findOfficialTerritoryCity("PR", "SAO JORGE D OESTE")?.city, "São Jorge d'Oeste");

// Coordenadas: centroide do IBGE para todos os municípios do catálogo; distância em linha reta.
for (const city of listOfficialTerritoryCities()) {
  const point = officialTerritoryCityPoint(city.ibgeCode);
  assert(point && point.latitude < -17 && point.latitude > -30 && point.longitude < -47 && point.longitude > -59, `${city.city}/${city.state} com coordenada`);
}
assert.equal(officialTerritoryCityPoint(null), null);
assert.equal(officialTerritoryCityPoint("9999999"), null);
{
  const beltrao = officialTerritoryCityPoint(findOfficialTerritoryCity("PR", "Francisco Beltrão")?.ibgeCode)!;
  const pitanga = officialTerritoryCityPoint(findOfficialTerritoryCity("PR", "Pitanga")?.ibgeCode)!;
  const km = distanceKm(beltrao, pitanga);
  assert(km > 190 && km < 215, `Francisco Beltrão x Pitanga em linha reta (${km.toFixed(0)} km)`);
  assert.equal(distanceKm(beltrao, beltrao), 0);
}

// UF escrita no marcador.
assert.deepEqual(parsePlacemarkCityName("Irati - PR"), { name: "Irati", state: "PR" });
assert.deepEqual(parsePlacemarkCityName("Irati/SC"), { name: "Irati", state: "SC" });
assert.deepEqual(parsePlacemarkCityName("Irati (PR)"), { name: "Irati", state: "PR" });
assert.deepEqual(parsePlacemarkCityName("Irati, Santa Catarina"), { name: "Irati", state: "SC" });
assert.deepEqual(parsePlacemarkCityName("Grão-Pará"), { name: "Grão-Pará", state: null }, "hífen do nome não é UF");
assert.deepEqual(parsePlacemarkCityName("Irati"), { name: "Irati", state: null });

// Ambíguos: UF do marcador; senão a UF da maioria do arquivo; empate fica para escolha.
{
  const [irati, palmeira] = resolvePlacemarkCities(["Irati", "Palmeira - SC", "Cascavel", "Toledo"]);
  assert.equal(irati.status === "resolved" && irati.city.state, "PR", "maioria PR no arquivo");
  assert.equal(palmeira.status === "resolved" && palmeira.city.state, "SC", "UF escrita vence a maioria");
}
{
  const [irati] = resolvePlacemarkCities(["Irati", "Joinville", "Cascavel"]);
  assert.equal(irati.status, "ambiguous", "empate PR x SC");
  assert.deepEqual(irati.status === "ambiguous" ? irati.candidates.map((city) => city.state).sort() : [], ["PR", "SC"]);
}
{
  const [missing, sc] = resolvePlacemarkCities(["Cidade Inexistente Ficticia", "Irati - SC"]);
  assert.equal(missing.status, "not_found");
  assert.equal(sc.status === "resolved" && sc.city.ibgeCode, "4207858");
}

console.log("TERRITORY_OFFICIAL_CITIES=PASS totals=PASS recent_municipalities=PASS apostrophe=PASS coordinates=PASS ambiguous=PASS placemark_state=PASS");
