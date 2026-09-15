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
  console.log("TENANT_READ_PREVIEW_DATASET=PASS", { tenantId, tenants: tenants.length, users: users.length, memberships: memberships.length, clients: clients.length, orders: orders.length, territoryOrders: territoryOrders.length, cancellationOrders: cancellationOrders.length });
}

failClosed().finally(() => prisma.$disconnect()).catch((error) => { console.error("Preview dataset certification failed", { code: error instanceof Error ? error.message : "UNKNOWN" }); process.exit(1); });
