import { prisma } from "../config/prisma.js";

/**
 * Succession and Reassignment Plan from Seller Edirlei (Code 2585) to Vitor (Code 7081)
 *
 * Governance Rules (DOCUMENTO_MESTRE.md):
 * 1. Completed Orders (ErpOrderSync), Sales, TimelineEvents, Activities, ChangeLogs, and past KPIs remain
 *    IMMUTABLY linked to Edirlei's ID (2585).
 * 2. Active Clients and Open Opportunities (prospeccao, negociacao, proposta) can be transferred to Vitor (7081).
 * 3. Closed Opportunities (ganho, perdido) REMAIN with Edirlei (2585).
 * 4. Territory Cities associated with Edirlei are transferred to Vitor (7081).
 */
export async function planVitorSuccession(executeMutation = false) {
  const edirleiCode = "2585";
  const vitorCode = "7081";

  const [edirlei, vitor] = await Promise.all([
    prisma.user.findFirst({ where: { erpCode: edirleiCode } }),
    prisma.user.findFirst({ where: { erpCode: vitorCode } }),
  ]);

  if (!edirlei) {
    console.log(`[Succession] Seller Edirlei (ERP Code ${edirleiCode}) not found.`);
    return;
  }
  if (!vitor) {
    console.log(`[Succession] Seller Vitor (ERP Code ${vitorCode}) not found.`);
    return;
  }

  console.log(`[Succession] Origin: Edirlei (ID: ${edirlei.id}, Active: ${edirlei.isActive})`);
  console.log(`[Succession] Destination: Vitor (ID: ${vitor.id}, Active: ${vitor.isActive})`);

  const openOpportunities = await prisma.opportunity.findMany({
    where: { ownerSellerId: edirlei.id, stage: { notIn: ["ganho", "perdido"] } },
    select: { id: true, title: true, value: true, stage: true, clientId: true },
  });

  const activeClients = await prisma.client.findMany({
    where: { ownerSellerId: edirlei.id, isArchived: false },
    select: { id: true, name: true, city: true, state: true },
  });

  const territoryCities = await prisma.sellerTerritoryCity.findMany({
    where: { sellerId: edirlei.id },
    select: { id: true, city: true, state: true },
  });

  console.log(`\n--- PREVIEW OF REASSIGNMENT ---`);
  console.log(`- Territory Cities to Transfer: ${territoryCities.length}`);
  console.log(`- Active Clients to Reassign: ${activeClients.length}`);
  console.log(`- Open Opportunities to Reassign: ${openOpportunities.length}`);

  if (!executeMutation) {
    console.log(`\n[DRY RUN COMPLETE] To execute reassignment, run with executeMutation=true.`);
    return {
      edirleiId: edirlei.id,
      vitorId: vitor.id,
      territoryCitiesCount: territoryCities.length,
      activeClientsCount: activeClients.length,
      openOpportunitiesCount: openOpportunities.length,
    };
  }

  // Transactional Execution if requested
  console.log(`\n[MUTATION Execution Started...]`);
  const result = await prisma.$transaction(async (tx) => {
    // 1. Transfer territory cities
    const updatedTerritories = await tx.sellerTerritoryCity.updateMany({
      where: { sellerId: edirlei.id },
      data: { sellerId: vitor.id },
    });

    // 2. Reassign active clients
    const updatedClients = await tx.client.updateMany({
      where: { ownerSellerId: edirlei.id, isArchived: false },
      data: { ownerSellerId: vitor.id },
    });

    // 3. Reassign open opportunities
    const updatedOpportunities = await tx.opportunity.updateMany({
      where: { ownerSellerId: edirlei.id, stage: { notIn: ["ganho", "perdido"] } },
      data: { ownerSellerId: vitor.id },
    });

    // 4. Record audit log in Timeline
    await tx.timelineEvent.create({
      data: {
        type: "status",
        ownerSellerId: vitor.id,
        description: `Succession execution: Reassigned ${updatedClients.count} clients, ${updatedOpportunities.count} open opportunities, and ${updatedTerritories.count} territory cities from Edirlei (2585) to Vitor (7081).`,
      },
    });

    return {
      updatedTerritoriesCount: updatedTerritories.count,
      updatedClientsCount: updatedClients.count,
      updatedOpportunitiesCount: updatedOpportunities.count,
    };
  });

  console.log(`[MUTATION Execution Complete]`, result);
  return result;
}

if (process.argv[1]?.endsWith("planVitorSuccession.ts")) {
  const execute = process.argv.includes("--execute");
  planVitorSuccession(execute)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
