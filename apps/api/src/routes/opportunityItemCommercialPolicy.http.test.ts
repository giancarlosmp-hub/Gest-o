import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Itens de oportunidade com a política comercial: produto do ERP obrigatório, preço sempre o do ERP para a tabela da
// oportunidade (o valor da tela é ignorado), desconto só em % e limitado por perfil, auditoria do desconto no
// OpportunityChangeLog e item antigo com preço fora do ERP sinalizado. Dados fictícios; Prisma simulado.
type Row = Record<string, any>;

const past = new Date("2026-01-01T00:00:00.000Z");
const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" }
];
const priceRow = (table: string, price: number) => ({ erpPriceId: table, branchCode: null, price, source: "prices", availabilityState: price > 0 ? "available" : "explicit_zero", validFrom: past, sourceChangedAt: past });
const products: Row[] = [
  { id: "p-alfa", name: "SEMENTE TESTE ALFA", erpProductCode: "9001", erpProductClassCode: "1", unit: "SC", isActive: true, isSuspended: false, rawErpPayload: { CODPRODUTO: 9001 }, prices: [priceRow("1", 140), priceRow("2", 175)] },
  { id: "p-zerado", name: "SEMENTE TESTE ZERADA", erpProductCode: "9002", erpProductClassCode: "1", unit: "SC", isActive: true, isSuspended: false, rawErpPayload: { CODPRODUTO: 9002 }, prices: [priceRow("1", 0)] }
];
const opportunities: Row[] = [
  { id: "opp-t1", priceTableCode: "1", value: 0 },
  { id: "opp-t2", priceTableCode: "2", value: 0 }
];
let items: Row[] = [];
const changeLogs: Row[] = [];
const config = new Map<string, string>();
let sequence = 0;

const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.id, role: user.role, region: null, isActive: true } : null;
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("appConfig", { findUnique: async ({ where }: any) => (config.has(where.key) ? { value: config.get(where.key) } : null) });
setModel("opportunity", {
  findFirst: async ({ where }: any) => opportunities.find((row) => row.id === where?.id) ?? null,
  update: async ({ where, data }: any) => Object.assign(opportunities.find((row) => row.id === where.id)!, data)
});
setModel("product", {
  findUnique: async ({ where }: any) => products.find((row) => row.id === where.id) ?? null,
  findMany: async ({ where }: any) => products.filter((row) => where.id.in.includes(row.id))
});
setModel("opportunityItem", {
  findMany: async ({ where }: any) => items.filter((row) => row.opportunityId === where.opportunityId).map((row) => ({ ...row, product: null })),
  findFirst: async ({ where }: any) => items.find((row) => row.id === where.id && row.opportunityId === where.opportunityId) ?? null,
  aggregate: async ({ where, _sum }: any) => {
    const rows = items.filter((row) => row.opportunityId === where.opportunityId);
    if (_sum) return { _sum: { netTotal: rows.reduce((sum, row) => sum + row.netTotal, 0) } };
    return { _max: { lineNumber: rows.length ? Math.max(...rows.map((row) => row.lineNumber)) : null } };
  },
  create: async ({ data }: any) => {
    const row = { id: `item-${++sequence}`, createdAt: past, updatedAt: past, ...data };
    items.push(row);
    return row;
  },
  update: async ({ where, data }: any) => Object.assign(items.find((row) => row.id === where.id)!, data)
});
setModel("opportunityChangeLog", { create: async ({ data }: any) => { changeLogs.push(data); return data; } });
(prisma as any).$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (method: string, path: string, userId: string, body?: unknown) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const amounts = (row: Row) => ({ unitPrice: row.unitPrice, grossTotal: row.grossTotal, discountTotal: row.discountTotal, netTotal: row.netTotal, discountType: row.discountType, discountValue: row.discountValue });
const WARNING = "Descontos acima do limite da política comercial não são autorizados e implicam a perda do bônus.";

const results: string[] = [];
try {
  // Produto obrigatório: item "manual" não existe mais.
  const manual = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { quantity: 10, unitPrice: 50, productNameSnapshot: "Item digitado" });
  assert.equal(manual.status, 400);
  assert.equal(manual.json.message, "Selecione um produto do ERP: item sem produto não é aceito.");
  assert.equal(items.length, 0);
  results.push("product_required=PASS");

  // Preço da tela ignorado: vale o do ERP para a tabela da oportunidade (1 → 140, 2 → 175).
  const table1 = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 100, unitPrice: 1, erpProductCode: "outro", productNameSnapshot: "Outro nome" });
  assert.equal(table1.status, 201, JSON.stringify(table1.json));
  assert.deepEqual(amounts(table1.json), { unitPrice: 140, grossTotal: 14000, discountTotal: 0, netTotal: 14000, discountType: "percent", discountValue: 0 });
  assert.equal(table1.json.erpProductCode, "9001");
  assert.equal(table1.json.productNameSnapshot, "SEMENTE TESTE ALFA");
  assert.equal(table1.json.erpPriceDiffers, false);
  const table2 = await call("POST", "/api/opportunities/opp-t2/items", "seller-a", { productId: "p-alfa", quantity: 10, unitPrice: 999 });
  assert.equal(table2.status, 201);
  assert.equal(table2.json.unitPrice, 175);
  assert.equal(opportunities[0].value, 14000, "valor da oportunidade = soma dos itens");
  assert.equal(changeLogs.length, 0, "sem desconto, sem auditoria");
  results.push("erp_price_enforced=PASS");

  // Produto sem preço no ERP não entra.
  const zero = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-zerado", quantity: 1, unitPrice: 10 });
  assert.equal(zero.status, 400);
  assert.match(zero.json.message, /sem preço válido no ERP para a tabela 1/);
  results.push("missing_erp_price_rejected=PASS");

  // Desconto: só em %, até 3% (padrão) para o vendedor; arredondado para baixo no centavo; auditado.
  const discounted = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 3, discountType: "percent", discountValue: 3 });
  assert.equal(discounted.status, 201);
  assert.deepEqual(amounts(discounted.json), { unitPrice: 140, grossTotal: 420, discountTotal: 12.6, netTotal: 407.4, discountType: "percent", discountValue: 3 });
  assert.deepEqual(changeLogs.at(-1), { opportunityId: "opp-t1", actorId: "seller-a", field: `item.${discounted.json.lineNumber}.discountPercent`, oldValue: null, newValue: "3" });
  const above = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 1, discountType: "percent", discountValue: 3.5 });
  assert.equal(above.status, 400);
  assert.equal(above.json.message, `Desconto máximo permitido: 3%. ${WARNING}`);
  const byValue = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 1, discountType: "value", discountValue: 5 });
  assert.equal(byValue.status, 400);
  assert.equal(byValue.json.message, "Desconto só em %: informe o percentual de desconto.");
  assert.equal((await call("POST", "/api/opportunities/opp-t1/items", "manager-a", { productId: "p-alfa", quantity: 1, discountValue: 4 })).status, 400, "gerente também limitado a 3% no padrão");
  results.push("discount_limit_default=PASS");

  // Limites configurados por perfil; política desligada não limita no CRM.
  config.set("commercial.policy", JSON.stringify({ enabled: true, maxDiscountPercent: { vendedor: 3, gerente: 5, diretor: 8 }, discountWarning: "Aviso fictício." }));
  assert.equal((await call("POST", "/api/opportunities/opp-t1/items", "manager-a", { productId: "p-alfa", quantity: 1, discountValue: 5 })).status, 201);
  const sellerAbove = await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 1, discountValue: 5 });
  assert.equal(sellerAbove.json.message, "Desconto máximo permitido: 3%. Aviso fictício.");
  assert.equal((await call("POST", "/api/opportunities/opp-t1/items", "director-a", { productId: "p-alfa", quantity: 1, discountValue: 8 })).status, 201);
  config.set("commercial.policy", JSON.stringify({ enabled: false, maxDiscountPercent: { vendedor: 3, gerente: 5, diretor: 8 }, discountWarning: "Aviso fictício." }));
  assert.equal((await call("POST", "/api/opportunities/opp-t1/items", "seller-a", { productId: "p-alfa", quantity: 1, discountValue: 10 })).status, 201);
  config.delete("commercial.policy");
  results.push("discount_limit_by_role=PASS");

  // Itens antigos: ficam como estão e são sinalizados; ao editar, o preço volta ao do ERP.
  items = [
    { id: "old-price", opportunityId: "opp-t1", productId: "p-alfa", lineNumber: 1, erpProductCode: "9001", erpProductClassCode: "1", productNameSnapshot: "SEMENTE TESTE ALFA", unit: "SC", quantity: 10, unitPrice: 130, discountType: "value", discountValue: 0, grossTotal: 1300, discountTotal: 0, netTotal: 1300, notes: null },
    { id: "old-manual", opportunityId: "opp-t1", productId: null, lineNumber: 2, erpProductCode: "manual", erpProductClassCode: "2", productNameSnapshot: "Item digitado", unit: "SC", quantity: 1, unitPrice: 50, discountType: "value", discountValue: 0, grossTotal: 50, discountTotal: 0, netTotal: 50, notes: null },
    { id: "old-value-discount", opportunityId: "opp-t1", productId: "p-alfa", lineNumber: 3, erpProductCode: "9001", erpProductClassCode: "1", productNameSnapshot: "SEMENTE TESTE ALFA", unit: "SC", quantity: 1, unitPrice: 140, discountType: "value", discountValue: 4, grossTotal: 140, discountTotal: 4, netTotal: 136, notes: null }
  ];
  changeLogs.length = 0;
  const listed = await call("GET", "/api/opportunities/opp-t1/items", "seller-a");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.items.map((row: Row) => [row.id, row.unitPrice, row.erpUnitPrice, row.erpPriceDiffers]), [
    ["old-price", 130, 140, true],
    ["old-manual", 50, null, true],
    ["old-value-discount", 140, 140, false]
  ]);
  const edited = await call("PUT", "/api/opportunities/opp-t1/items/old-price", "seller-a", { quantity: 2, unitPrice: 130 });
  assert.equal(edited.status, 200);
  assert.deepEqual(amounts(edited.json), { unitPrice: 140, grossTotal: 280, discountTotal: 0, netTotal: 280, discountType: "percent", discountValue: 0 });
  assert.equal(edited.json.erpPriceDiffers, false);
  assert.equal(changeLogs.length, 0, "desconto não mudou, sem auditoria");
  const manualEdit = await call("PUT", "/api/opportunities/opp-t1/items/old-manual", "seller-a", { quantity: 2 });
  assert.equal(manualEdit.status, 400);
  assert.equal(manualEdit.json.message, "Selecione um produto do ERP: item sem produto não é aceito.");
  assert.equal((await call("PUT", "/api/opportunities/opp-t1/items/old-value-discount", "seller-a", { quantity: 2 })).status, 400, "desconto antigo em R$ precisa virar %");
  const converted = await call("PUT", "/api/opportunities/opp-t1/items/old-value-discount", "seller-a", { discountType: "percent", discountValue: 2 });
  assert.equal(converted.status, 200);
  assert.deepEqual(amounts(converted.json), { unitPrice: 140, grossTotal: 140, discountTotal: 2.8, netTotal: 137.2, discountType: "percent", discountValue: 2 });
  assert.deepEqual(changeLogs.at(-1), { opportunityId: "opp-t1", actorId: "seller-a", field: "item.3.discountPercent", oldValue: "R$ 4.00", newValue: "2" });
  assert.equal((await call("PUT", "/api/opportunities/opp-t1/items/old-value-discount", "seller-a", { discountValue: 3.5 })).status, 400, "limite vale na edição");
  const removed = await call("PUT", "/api/opportunities/opp-t1/items/old-value-discount", "seller-a", { discountValue: 0 });
  assert.equal(removed.status, 200);
  assert.deepEqual(changeLogs.at(-1), { opportunityId: "opp-t1", actorId: "seller-a", field: "item.3.discountPercent", oldValue: "2", newValue: "0" });
  results.push("legacy_items_flagged_and_reset=PASS");

  console.log(results.join("\n"));
} finally {
  server.close();
}
