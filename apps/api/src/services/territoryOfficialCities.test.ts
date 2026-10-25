import assert from "node:assert/strict";
import {
  findOfficialTerritoryCity,
  listOfficialTerritoryCities,
  normalizeTerritoryCityKey,
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
assert.equal(normalizeTerritoryCityKey("  Pérola  D’Oeste "), "pérola d'oeste".normalize("NFD").replace(/\p{M}/gu, ""));

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

console.log("TERRITORY_OFFICIAL_CITIES=PASS totals=PASS recent_municipalities=PASS ambiguous=PASS placemark_state=PASS");
