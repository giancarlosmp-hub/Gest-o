import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { calculateOpportunityPriceForTable } from "../services/opportunityPriceService.js";

const product273 = {
  defaultPrice: 12.34,
  erpProductCode: "273",
  erpProductClassCode: "default",
  stockQuantity: 0,
  rawErpPayload: { PRECO: 12.34 },
  prices: [],
};
const price273 = calculateOpportunityPriceForTable({ product: product273, priceTableCode: "1" });
assert.equal(price273.priceTableMatched, true, "Produto 273 sem /prices, mas com /products.PRECO válido, deve aparecer na busca");
assert.equal(price273.price, 12.34, "Produto 273 deve usar /products.PRECO quando /prices não retornou linha explícita");
assert.equal(price273.source, "product.PRECO", "Diagnóstico deve expor fallback vindo de /products.PRECO");
assert.equal(product273.stockQuantity, 0, "Produto com estoque 0 continua disponível para avaliação comercial");

const product273WithPrice = {
  ...product273,
  defaultPrice: 0,
  rawErpPayload: { PRECO: 0 },
  prices: [{ erpPriceId: "1", price: 12.34, validFrom: new Date() }],
};
const explicitPrice273 = calculateOpportunityPriceForTable({ product: product273WithPrice, priceTableCode: "1" });
assert.equal(explicitPrice273.priceTableMatched, true, "Produto 273 com ProductPrice válido deve aparecer na busca");
assert.equal(explicitPrice273.price, 12.34, "Produto 273 deve usar ProductPrice sincronizado");

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
  ...product273WithPrice,
  prices: [{ erpPriceId: "1", price: 19.87, validFrom: new Date() }],
};
const updatedPrice273 = calculateOpportunityPriceForTable({ product: product273Updated, priceTableCode: "1" });
assert.equal(updatedPrice273.price, 19.87, "Troca de preço no /prices deve atualizar preço exibido na busca");

const crudRoutes = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
assert.match(crudRoutes, /\/erp\/ultrafv3\/sync\/partners\/opportunity-clients/, "Endpoint do botão Atualizar clientes deve existir");
assert.match(crudRoutes, /syncPartnersForAllConfiguredSellers/, "Endpoint do botão Atualizar clientes deve usar fluxo all-sellers");
assert.match(crudRoutes, /return res\.status\(result\.errorCount > 0 \? 207 : 200\)\.json/, "Endpoint opportunity-clients deve retornar exatamente a resposta de sucesso do all-sellers");
assert.match(crudRoutes, /if \(res\.headersSent\)/, "Endpoint opportunity-clients não deve tentar responder erro depois de já ter enviado resposta");
assert.match(crudRoutes, /status: stock <= 0 \? "sem estoque" : "disponível"/, "Produto com estoque 0 deve aparecer com status de alerta para confirmação antes de adicionar");
assert.match(crudRoutes, /\/erp\/ultrafv3\/price-diagnostics/, "Endpoint temporário de diagnóstico de preços deve existir");
assert.match(crudRoutes, /\/erp\/sync-all[\s\S]*startUltraFv3FullSyncJob/, "POST /erp/sync-all deve apenas iniciar job assíncrono");
assert.match(crudRoutes, /res\.status\(job\.alreadyRunning \? 200 : 202\)\.json\(job\)/, "POST /erp/sync-all deve responder rapidamente com 202 ou status claro de já em execução");
assert.doesNotMatch(crudRoutes, /\/erp\/sync-all[\s\S]*response already sent before success payload/, "POST /erp/sync-all não deve manter lógica de resposta tardia após headersSent");

const syncService = readFileSync(new URL("../services/ultraFv3SyncService.ts", import.meta.url), "utf8");
assert.match(syncService, /ownerSeller: \{ connect: \{ id: ownerSellerId \} \}/, "Troca de carteira deve atualizar ownerSellerId do cliente existente");
assert.match(syncService, /startUltraFv3FullSyncJob[\s\S]*void syncAllUltraFv3Catalogs/, "Sync completa deve continuar em background depois da resposta HTTP");
assert.match(syncService, /scope: "syncAll"[\s\S]*finalStatus/, "Sync completa deve persistir status final no histórico do job");
assert.match(syncService, /nonCritical: true[\s\S]*orderStatus|orderStatus[\s\S]*nonCritical: true/, "Sincronização completa deve tratar orderStatus como não crítico");
assert.match(syncService, /hasConfiguredSellerFv3Credentials/, "Sync deve detectar vendedores ativos com Login FV3/Senha FV3");
assert.match(syncService, /skippedOrderStatusMissingGlobalCredentials/, "orderStatus deve ser ignorado como aviso operacional quando só faltam credenciais globais em modo por vendedor");
assert.match(syncService, /\[ultrafv3 sync orderStatus\] skipped in seller-auth mode/, "orderStatus deve logar skip estruturado não crítico em modo por vendedor");
assert.match(syncService, /zeroPriceInvalidated/, "Sync de preços deve invalidar preço zero retornado pelo ERP");
assert.match(syncService, /createdZeroPrice/, "Sync de preços deve registrar ProductPrice zero explícito para bloquear fallback de /products.PRECO");
assert.match(syncService, /product PRECO fallback preserved/, "Sync de preços não deve zerar fallback de /products.PRECO quando /prices não retorna o produto");
assert.match(syncService, /productCandidates\.length === 1 \? productCandidates\[0\]/, "Sync de preços deve atualizar candidato único seguro mesmo com classificação divergente ou ausente");
assert.match(syncService, /\{ scope: "products"[\s\S]*\{ scope: "priceTables"[\s\S]*\{ scope: "prices"/, "Sincronização completa deve rodar Produtos antes de Preços");

const orderService = readFileSync(new URL("../services/erpOrderService.ts", import.meta.url), "utf8");
assert.match(orderService, /export const NUM_PEDIDO_PATTERN = \/\^\\d\{1,15\}\$\//, "NUM_PEDIDO deve aceitar apenas string numérica de até 15 caracteres");
assert.match(orderService, /normalizeUltraFv3OrderNumber/, "NUM_PEDIDO deve validar inteiro maior que zero sem zeros à esquerda");
assert.match(orderService, /const numPedido = salesmenNumPedido;/, "NUM_PEDIDO deve vir exclusivamente do NUMERO_PEDIDO retornado por /salesmen");
assert.doesNotMatch(orderService, /generateShortNumPedido/, "CRM não pode gerar fallback PMR/P* para NUM_PEDIDO");
assert.match(orderService, /PEDIDO_ID_IMPORTACAO: pedidoIdImportacao/, "PEDIDO_ID_IMPORTACAO deve continuar usando UUID separado");
assert.match(orderService, /NUM_PEDIDO não pode ser igual ao PEDIDO_ID_IMPORTACAO/, "Validação deve bloquear NUM_PEDIDO igual ao UUID de importação");
assert.match(orderService, /NUM_PEDIDO não pode usar código interno PMR/, "Validação deve bloquear código interno PMR em NUM_PEDIDO");
assert.match(orderService, /Não foi possível obter do UltraFV3 um número sequencial válido/, "Ausência de NUMERO_PEDIDO deve bloquear envio");
assert.match(orderService, /erpOrderSubmissionMutex\.runExclusive/, "Envio real deve ser serializado para evitar concorrência no NUMERO_PEDIDO global");
assert.match(orderService, /finally[\s\S]*released global UltraFV3 submission lock/, "Falha do UltraFV3 deve liberar lock em finally");
assert.match(orderService, /resultado desconhecido\/timeout/, "Timeout/resultado desconhecido deve bloquear reenvio cego");
assert.match(orderService, /getFunctionalOrderErrorMessage/, "HTTP 200 com erro funcional deve ser validado antes de marcar pedido como enviado");
assert.match(orderService, /extractErpOrderNumber\(erpResponse\) \|\| numPedido/, "Número oficial salvo deve cair para o NUM_PEDIDO sequencial usado quando o ERP não retorna outro número explícito");

console.log("UltraFV3 CRM sync regression smoke passed");
