import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const tenantId = process.env.DEFAULT_TENANT_ID?.trim();

async function failClosed() {
  if (process.env.DEPLOYMENT_ENV !== "preview" && process.env.NODE_ENV !== "test") throw new Error("PREVIEW_OR_TEST_ENV_REQUIRED");
  if (!tenantId) throw new Error("DEFAULT_TENANT_ID_REQUIRED");
  const [tenants, users, memberships, clients, orders] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true, status: true } }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, role: true } }),
    prisma.tenantMembership.findMany({ select: { userId: true, tenantId: true, role: true, status: true, revokedAt: true } }),
    prisma.client.findMany({ select: { id: true, tenantId: true, ownerSellerId: true, isArchived: true, region: true } }),
    prisma.erpOrderSync.findMany({
      where: { pedidoIdImportacao: { contains: "[preview-seed]" } },
      select: {
        id: true,
        pedidoIdImportacao: true,
        erpOrderNumber: true,
        operationalOrderStatus: true,
        tenantId: true,
        sellerId: true,
        opportunity: { select: { id: true, ownerSellerId: true, client: { select: { code: true, tenantId: true, ownerSellerId: true } } } }
      }
    })
  ]);
  if (tenants.length !== 1 || tenants[0]?.id !== tenantId || tenants[0].status !== "active") throw new Error("DATASET_TENANT_CONTRACT_FAILED");
  if (!users.length || memberships.length !== users.length) throw new Error("DATASET_MEMBERSHIP_CARDINALITY_FAILED");
  for (const user of users) {
    const matches = memberships.filter((item) => item.userId === user.id);
    if (matches.length !== 1 || matches[0].tenantId !== tenantId || matches[0].status !== "active" || matches[0].revokedAt || matches[0].role !== user.role) throw new Error("DATASET_MEMBERSHIP_CONTRACT_FAILED");
  }
  if (!clients.length || clients.some((client) => !client.tenantId || client.tenantId !== tenantId)) throw new Error("DATASET_CLIENT_TENANT_FAILED");
  const memberIds = new Set(users.map((user) => user.id));
  if (clients.some((client) => !memberIds.has(client.ownerSellerId))) throw new Error("DATASET_CLIENT_OWNERSHIP_FAILED");
  const territoryOrders = orders.filter((order) => order.pedidoIdImportacao.includes("[preview-seed]-territory-"));
  const cancellationOrders = orders.filter((order) => order.pedidoIdImportacao.match(/^\[preview-seed\]-900(?:169|033|051|071)-PREVIEW$/));
  const expectedCancellationStatus = new Map([
    ["900169-PREVIEW", "CANCELADO"],
    ["900033-PREVIEW", "FINALIZADO"],
    ["900051-PREVIEW", "FINALIZADO"],
    ["900071-PREVIEW", "FINALIZADO"],
  ]);
  if (orders.length !== 8 || territoryOrders.length !== 4 || cancellationOrders.length !== 4) {
    console.error("Preview order cardinality mismatch", { total: orders.length, territory: territoryOrders.length, cancellation: cancellationOrders.length });
    throw new Error("DATASET_ORDER_CARDINALITY_FAILED");
  }
  if (new Set(cancellationOrders.map((order) => order.erpOrderNumber)).size !== 4 || new Set(cancellationOrders.map((order) => order.opportunity.id)).size !== 4) throw new Error("DATASET_CANCELLATION_ORDER_UNIQUENESS_FAILED");
  if (cancellationOrders.some((order) => order.opportunity.client.code !== "968-PREVIEW" || expectedCancellationStatus.get(order.erpOrderNumber || "") !== order.operationalOrderStatus)) throw new Error("DATASET_CANCELLATION_SCENARIO_FAILED");
  if (orders.some((order) => order.tenantId !== tenantId || order.opportunity.client.tenantId !== tenantId)) throw new Error("DATASET_ORDER_TENANT_FAILED");
  if (orders.some((order) => order.sellerId !== order.opportunity.ownerSellerId || order.sellerId !== order.opportunity.client.ownerSellerId)) throw new Error("DATASET_ORDER_SELLER_FAILED");
  for (const user of users.filter((candidate) => candidate.role === "vendedor")) {
    const legacy = clients.filter((client) => client.ownerSellerId === user.id && !client.isArchived).length;
    const scoped = clients.filter((client) => client.ownerSellerId === user.id && !client.isArchived && client.tenantId === tenantId).length;
    if (legacy !== scoped) throw new Error("DATASET_RBAC_COUNT_FAILED");
  }
  const [itemProducts, itemOpportunities] = await Promise.all([
    prisma.product.findMany({
      where: { erpProductClassCode: "PREVIEW", name: { startsWith: "[preview-seed]" } },
      select: { erpProductCode: true, isActive: true, isSuspended: true, stockQuantity: true, prices: { select: { erpPriceId: true, branchCode: true, price: true, availabilityState: true } } }
    }),
    prisma.opportunity.findMany({
      where: { title: { contains: "[preview-seed]" }, items: { some: {} } },
      select: { value: true, ownerSellerId: true, client: { select: { tenantId: true, ownerSellerId: true } }, items: { select: { lineNumber: true, erpProductCode: true, discountTotal: true, grossTotal: true, netTotal: true, product: { select: { erpProductClassCode: true } } } } }
    })
  ]);
  const productCodes = itemProducts.map((product) => product.erpProductCode).sort();
  if (itemProducts.length !== 6 || productCodes.join(",") !== "1,2,3,4,5,6") throw new Error("DATASET_ITEM_PRODUCT_CARDINALITY_FAILED");
  for (const product of itemProducts) {
    if (!product.isActive || product.isSuspended) throw new Error("DATASET_ITEM_PRODUCT_STATUS_FAILED");
    for (const table of ["1", "2"]) {
      const rows = product.prices.filter((price) => price.erpPriceId === table);
      if (rows.length !== 1 || rows[0].branchCode !== null || rows[0].availabilityState !== "available" || !(rows[0].price > 0)) throw new Error("DATASET_ITEM_PRODUCT_PRICE_FAILED");
    }
  }
  const stocks = itemProducts.map((product) => product.stockQuantity ?? Number.NaN);
  if (!stocks.some((stock) => stock >= 100) || !stocks.some((stock) => stock > 0 && stock < 10) || !stocks.some((stock) => stock === 0) || !stocks.some((stock) => stock < 0)) throw new Error("DATASET_ITEM_STOCK_SCENARIOS_FAILED");
  const sellerIds = new Set(users.filter((user) => user.role === "vendedor").map((user) => user.id));
  const items = itemOpportunities.flatMap((opportunity) => opportunity.items);
  if (itemOpportunities.length !== 2 || items.length !== 5) throw new Error("DATASET_ITEM_CARDINALITY_FAILED");
  for (const opportunity of itemOpportunities) {
    const netTotal = Number(opportunity.items.reduce((sum, item) => sum + item.netTotal, 0).toFixed(2));
    if (opportunity.items.length < 2 || opportunity.items.length > 3 || Math.abs(netTotal - opportunity.value) > 0.005) throw new Error("DATASET_ITEM_VALUE_FAILED");
    if (new Set(opportunity.items.map((item) => item.lineNumber)).size !== opportunity.items.length) throw new Error("DATASET_ITEM_LINE_FAILED");
    if (!sellerIds.has(opportunity.ownerSellerId) || opportunity.client.ownerSellerId !== opportunity.ownerSellerId || opportunity.client.tenantId !== tenantId) throw new Error("DATASET_ITEM_OWNERSHIP_FAILED");
  }
  if (items.some((item) => item.product?.erpProductClassCode !== "PREVIEW" || Math.abs(item.grossTotal - item.discountTotal - item.netTotal) > 0.005)) throw new Error("DATASET_ITEM_PRODUCT_LINK_FAILED");
  if (!items.some((item) => item.discountTotal > 0)) throw new Error("DATASET_ITEM_DISCOUNT_FAILED");
  console.log("TENANT_READ_PREVIEW_DATASET=PASS", { tenantId, tenants: tenants.length, users: users.length, memberships: memberships.length, clients: clients.length, orders: orders.length, territoryOrders: territoryOrders.length, cancellationOrders: cancellationOrders.length, itemProducts: itemProducts.length, itemOpportunities: itemOpportunities.length, opportunityItems: items.length });
}

failClosed().finally(() => prisma.$disconnect()).catch((error) => { console.error("Preview dataset certification failed", { code: error instanceof Error ? error.message : "UNKNOWN" }); process.exit(1); });
