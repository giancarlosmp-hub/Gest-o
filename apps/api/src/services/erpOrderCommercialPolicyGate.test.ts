import assert from "node:assert/strict";

// Pedido ERP com a política comercial: a tabela do pedido é a que precificou os itens e todo item está no preço atual
// do ERP (item antigo com preço alterado, item sem produto ou desconto em R$ bloqueiam). A trava roda antes de
// reservar número ou chamar o ERP. Dados fictícios; Prisma simulado; nada sai da máquina.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-commercial-policy-key";
const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { createErpOrderFromOpportunity } = await import("./erpOrderService.js");
const { assertOpportunityItemsMatchErp } = await import("./opportunityItemErpPrice.js");

const past = new Date("2026-01-01T00:00:00.000Z");
const priceRow = (table: string, price: number) => ({ erpPriceId: table, branchCode: null, price, source: "prices", availabilityState: "available", validFrom: past, sourceChangedAt: past });
const products = [
  { id: "p-alfa", name: "SEMENTE TESTE ALFA", erpProductCode: "9001", erpProductClassCode: "1", unit: "SC", isActive: true, isSuspended: false, rawErpPayload: { CODPRODUTO: 9001 }, prices: [priceRow("1", 140), priceRow("2", 175)] }
];
let productQueries = 0;
(prisma as any).product.findMany = async ({ where }: any) => {
  productQueries += 1;
  return products.filter((row) => where.id.in.includes(row.id));
};
const appConfig = new Map<string, string>([
  ["erp.ultrafv3.paymentMethods", JSON.stringify([{ FORMA: "1", DESCRICAO: "FORMA FICTICIA", ATIVO: "S", LIBERAR_INTERNET: "S" }])],
  ["erp.ultrafv3.receivingConditions", JSON.stringify([{ CODCONDREC: "10", DESCRICAO: "CONDICAO FICTICIA", LIBERAR_INTERNET: "S" }])],
  ["erp.ultrafv3.operations", JSON.stringify([{ CODOPER: "100", DESCRICAO: "VENDA", ATIVO: "S", LIBERAR_INTERNET: "S", VENDAS: "S" }])],
  ["erp.ultrafv3.priceTables", JSON.stringify([{ CODTABELA: "1", DESCRICAO: "TABELA FICTICIA 1" }, { CODTABELA: "2", DESCRICAO: "TABELA FICTICIA 2" }])]
]);
(prisma as any).appConfig.findUnique = async ({ where }: { where: { key: string } }) => {
  const value = appConfig.get(where.key);
  return value === undefined ? null : { value, updatedAt: new Date("2026-10-01T00:00:00Z") };
};

const item = (overrides: Record<string, unknown> = {}) => ({
  lineNumber: 1, productId: "p-alfa", erpProductCode: "9001", erpProductClassCode: "1", unit: "SC", productNameSnapshot: "SEMENTE TESTE ALFA",
  quantity: 10, unitPrice: 140, discountType: "percent", discountValue: 3, grossTotal: 1400, discountTotal: 42, netTotal: 1358, ...overrides
});
const opportunityWith = (items: unknown[], priceTableCode: string | null = "1") => ({
  id: "opp-ficticia",
  stage: "ganho",
  priceTableCode,
  client: { tenantId: "tenant-ficticio", code: "7001" },
  ownerSeller: {
    id: "seller-ficticio", name: "Vendedor Ficticio", erpCode: "77", erpOperatorCode: "5",
    erpLoginUsername: "login-ficticio", erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia")
  },
  items
}) as any;
const params = (priceTableCode: string) => ({
  paymentMethodCode: "1", receivingConditionCode: "10", priceTableCode, branchCode: "1", operationCode: "100",
  expectedDeliveryDate: "2026-12-01", erpOrderObservation: "", simulateOnly: true
});
const orderError = async (opportunity: unknown, priceTableCode: string) => {
  try {
    await createErpOrderFromOpportunity(opportunity as any, params(priceTableCode) as any, { correlationId: "corr-ficticio" });
  } catch (error) {
    return error as Error & { status?: number };
  }
  throw new Error("o pedido deveria ser bloqueado");
};

const results: string[] = [];

const tableMismatch = await orderError(opportunityWith([item()], "1"), "2");
assert.equal(tableMismatch.status, 400);
assert.equal(tableMismatch.message, "Tabela de preço do pedido (2) diferente da tabela que precificou os itens (1). Gere o pedido com a tabela 1.");
assert.equal(productQueries, 0, "tabela divergente bloqueia antes de consultar preços");
results.push("table_mismatch_blocked=PASS");

const stale = await orderError(opportunityWith([item(), item({ lineNumber: 2, unitPrice: 130, grossTotal: 1300, discountTotal: 0, netTotal: 1300, discountValue: 0 })]), "1");
assert.equal(stale.status, 400);
assert.equal(stale.message, "Preço diferente do ERP atual no item 2: edite o item para o preço voltar ao do ERP (item sem produto precisa ser excluído) antes de gerar o pedido.");
const manual = await orderError(opportunityWith([item({ productId: null, erpProductCode: "manual" })]), "1");
assert.match(manual.message, /^Preço diferente do ERP atual no item 1/);
const table2Stale = await orderError(opportunityWith([item()], "2"), "2");
assert.match(table2Stale.message, /^Preço diferente do ERP atual no item 1/, "preço da tabela 1 numa oportunidade da tabela 2");
results.push("stale_price_blocked=PASS");

const valueDiscount = await orderError(opportunityWith([item({ discountType: "value", discountValue: 10, discountTotal: 10, netTotal: 1390 })]), "1");
assert.equal(valueDiscount.message, "Item 1 com desconto em R$: edite o item e informe o desconto em % antes de gerar o pedido.");
results.push("value_discount_blocked=PASS");

// Tudo certo: a trava passa (tabela ausente na oportunidade vale como 1).
await assertOpportunityItemsMatchErp(opportunityWith([item(), item({ lineNumber: 2, discountType: "value", discountValue: 0, discountTotal: 0 })]), "1");
await assertOpportunityItemsMatchErp(opportunityWith([item()], null), "1");
await assertOpportunityItemsMatchErp(opportunityWith([item({ unitPrice: 175 })], "2"), "2");
results.push("matching_items_pass=PASS");

console.log(results.join("\n"));
await prisma.$disconnect().catch(() => undefined);
