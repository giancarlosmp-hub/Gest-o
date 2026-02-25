import { prisma } from "../config/prisma.js";

async function run() {
  const opportunities = await prisma.opportunity.findMany({
    where: {
      notes: {
        not: null
      }
    },
    select: {
      id: true,
      notes: true,
      clientId: true,
      ownerSellerId: true
    }
  });

  let migrated = 0;

  for (const opportunity of opportunities) {
    const notes = opportunity.notes?.trim();
    if (!notes) continue;

    const exists = await prisma.event.findFirst({
      where: {
        opportunityId: opportunity.id,
        description: notes
      },
      select: { id: true }
    });

    if (exists) continue;

    await prisma.event.create({
      data: {
        type: "comentario",
        description: notes,
        opportunityId: opportunity.id,
        clientId: opportunity.clientId,
        ownerSellerId: opportunity.ownerSellerId
      }
    });
    migrated += 1;
  }

  console.log(`Migração concluída. ${migrated} oportunidades tiveram notas convertidas em eventos.`);
}

run()
  .catch((error) => {
    console.error("Falha ao migrar notas para eventos", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
