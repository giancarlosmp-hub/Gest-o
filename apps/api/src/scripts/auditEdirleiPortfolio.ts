import { prisma } from "../config/prisma.js";

/**
 * Read-Only Audit Script for Seller Edirlei (Code 2585)
 * Quantifies active clients, open opportunities, territory cities, completed orders, timeline, and activities.
 */
export async function auditEdirleiPortfolio() {
  const sellerErpCode = "2585";

  console.log(`[Audit] Searching seller with ERP code: ${sellerErpCode}...`);
  const seller = await prisma.user.findFirst({
    where: { erpCode: sellerErpCode },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      erpCode: true,
      region: true,
    },
  });

  if (!seller) {
    console.log(`[Audit] Seller with erpCode=${sellerErpCode} not found in CRM DB.`);
    return null;
  }

  console.log(`[Audit] Seller Found: ID=${seller.id}, Name=${seller.name}, Active=${seller.isActive}`);

  const [
    activeClients,
    archivedClients,
    openOpportunities,
    closedOpportunities,
    territoryCities,
    erpOrders,
    timelineEvents,
    activities,
  ] = await Promise.all([
    prisma.client.count({ where: { ownerSellerId: seller.id, isArchived: false } }),
    prisma.client.count({ where: { ownerSellerId: seller.id, isArchived: true } }),
    prisma.opportunity.count({
      where: { ownerSellerId: seller.id, stage: { notIn: ["ganho", "perdido"] } },
    }),
    prisma.opportunity.count({
      where: { ownerSellerId: seller.id, stage: { in: ["ganho", "perdido"] } },
    }),
    prisma.sellerTerritoryCity.findMany({
      where: { sellerId: seller.id },
      select: { id: true, city: true, state: true },
    }),
    prisma.erpOrderSync.count({ where: { sellerId: seller.id } }),
    prisma.timelineEvent.count({ where: { ownerSellerId: seller.id } }),
    prisma.activity.count({ where: { ownerSellerId: seller.id } }),
  ]);

  const auditSummary = {
    seller,
    activeClientsCount: activeClients,
    archivedClientsCount: archivedClients,
    openOpportunitiesCount: openOpportunities,
    closedOpportunitiesCount: closedOpportunities,
    territoryCitiesCount: territoryCities.length,
    territoryCitiesList: territoryCities.map((c) => `${c.city}/${c.state}`),
    completedErpOrdersCount: erpOrders,
    timelineEventsCount: timelineEvents,
    activitiesCount: activities,
  };

  console.log("\n--- AUDIT SUMMARY FOR EDIRLEI (2585) ---");
  console.log(JSON.stringify(auditSummary, null, 2));
  return auditSummary;
}

if (process.argv[1]?.endsWith("auditEdirleiPortfolio.ts")) {
  auditEdirleiPortfolio()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
