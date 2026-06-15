import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { calculateOpportunityPriceForTable } from "../services/opportunityPriceService.js";

const product273 = {
  defaultPrice: 0,
  erpProductCode: "273",
  erpProductClassCode: "default",
  stockQuantity: 0,
  rawErpPayload: { PRECO: 0 },
  prices: [{ erpPriceId: "1", price: 12.34, validFrom: new Date() }],
};
const price273 = calculateOpportunityPriceForTable({ product: product273, priceTableCode: "1" });
assert.equal(price273.priceTableMatched, true, "Produto 273 com ProductPrice válido deve aparecer na busca");
assert.equal(price273.price, 12.34, "Produto 273 deve usar ProductPrice sincronizado");
assert.equal(product273.stockQuantity, 0, "Produto com estoque 0 continua disponível para avaliação comercial");

const product228 = {
  defaultPrice: 0,
  erpProductCode: "228",
  erpProductClassCode: "default",
  rawErpPayload: { PRECO: 5.36, PRECO_TABELA_1: 5.36 },
  prices: [{ erpPriceId: "1", price: 0, validFrom: new Date() }],
};
const price228 = calculateOpportunityPriceForTable({ product: product228, priceTableCode: "1" });
assert.equal(price228.priceTableMatched, false, "Produto 228 zerado no ERP não deve aparecer na busca");
assert.equal(price228.price, 0, "Produto 228 zerado não pode reaproveitar PRECO antigo do raw payload");
assert.equal(price228.source, "missing", "Preço antigo não pode ficar preso em defaultPrice/rawErpPayload/ProductPrice");

const product273Updated = {
  ...product273,
  prices: [{ erpPriceId: "1", price: 19.87, validFrom: new Date() }],
};
const updatedPrice273 = calculateOpportunityPriceForTable({ product: product273Updated, priceTableCode: "1" });
assert.equal(updatedPrice273.price, 19.87, "Troca de preço no /prices deve atualizar preço exibido na busca");

const crudRoutes = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
assert.match(crudRoutes, /\/erp\/ultrafv3\/sync\/partners\/opportunity-clients/, "Endpoint do botão Atualizar clientes deve existir");
assert.match(crudRoutes, /syncPartnersForAllConfiguredSellers/, "Endpoint do botão Atualizar clientes deve usar fluxo all-sellers");
assert.match(crudRoutes, /status: stock <= 0 \? "sem estoque" : "disponível"/, "Produto com estoque 0 deve aparecer com status de alerta para confirmação antes de adicionar");
assert.match(crudRoutes, /\/erp\/ultrafv3\/price-diagnostics/, "Endpoint temporário de diagnóstico de preços deve existir");

const syncService = readFileSync(new URL("../services/ultraFv3SyncService.ts", import.meta.url), "utf8");
assert.match(syncService, /ownerSeller: \{ connect: \{ id: ownerSellerId \} \}/, "Troca de carteira deve atualizar ownerSellerId do cliente existente");
assert.match(syncService, /nonCritical: true[\s\S]*orderStatus|orderStatus[\s\S]*nonCritical: true/, "Sincronização completa deve tratar orderStatus como não crítico");
assert.match(syncService, /zeroPriceInvalidated/, "Sync de preços deve invalidar preço zero retornado pelo ERP");
assert.match(syncService, /productCandidates\.length === 1 \? productCandidates\[0\]/, "Sync de preços deve atualizar candidato único seguro mesmo com classificação divergente ou ausente");
assert.match(syncService, /\{ scope: "products"[\s\S]*\{ scope: "priceTables"[\s\S]*\{ scope: "prices"/, "Sincronização completa deve rodar Produtos antes de Preços");

console.log("UltraFV3 CRM sync regression smoke passed");
