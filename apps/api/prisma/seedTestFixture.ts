import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

if (!process.env.SEED_FIXTURE) {
  console.log("Skipping fixture seed. Set SEED_FIXTURE=1 to run.");
  process.exit(0);
}

const BR_STATES = ["SP", "RJ", "MG", "RS", "PR", "SC", "BA", "GO", "MT", "MS"];
const REGIONS = ["Sul", "Sudeste", "Centro-Oeste", "Norte", "Nordeste"];
const SEGMENTS = ["Soja", "Milho", "Algodão", "Café", "Cana"];

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  const sellers = await prisma.user.findMany({
    where: { role: "vendedor", isActive: true },
    select: { id: true },
  });

  if (!sellers.length) {
    console.error("No sellers found. Run the default seed first.");
    process.exit(1);
  }

  for (const seller of sellers) {
    console.log(`Creating fixture data for seller ${seller.id}...`);

    // Cleanup previous fixtures for this seller
    await prisma.activity.deleteMany({
      where: { ownerSellerId: seller.id, notes: { startsWith: "[fixture]" } },
    });
    await prisma.opportunity.deleteMany({
      where: { ownerSellerId: seller.id, title: { startsWith: "[fixture]" } },
    });
    await prisma.agendaEvent.deleteMany({
      where: { sellerId: seller.id, title: { startsWith: "[fixture]" } },
    });
    await prisma.client.deleteMany({
      where: { ownerSellerId: seller.id, name: { startsWith: "[fixture]" } },
    });

    // Create 20 clients
    const clients = [];
    for (let i = 1; i <= 20; i++) {
      const state = BR_STATES[i % BR_STATES.length];
      const client = await prisma.client.create({
        data: {
          name: `[fixture] Cliente ${i} - ${seller.id.slice(0, 6)}`,
          city: `Cidade ${i}`,
          state,
          region: REGIONS[i % REGIONS.length],
          segment: SEGMENTS[i % SEGMENTS.length],
          ownerSellerId: seller.id,
        },
      });
      clients.push(client);
    }

    // Create 30 opportunities
    const stages = [
      ...Array(12).fill("prospeccao"),
      ...Array(8).fill("negociacao"),
      ...Array(6).fill("proposta"),
      ...Array(3).fill("ganho"),
      ...Array(1).fill("perdido"),
    ];
    for (let i = 0; i < 30; i++) {
      const client = clients[i % clients.length];
      const isOverdue = i < 6;
      const followDays = isOverdue ? -randomBetween(1, 30) : randomBetween(1, 90);
      const followUpDate = daysFromNow(followDays);
      await prisma.opportunity.create({
        data: {
          title: `[fixture] Oportunidade ${i + 1} - ${seller.id.slice(0, 6)}`,
          value: randomBetween(5000, 250000),
          stage: stages[i] as any,
          probability: randomBetween(10, 90),
          proposalDate: daysFromNow(-randomBetween(0, 30)),
          followUpDate,
          expectedCloseDate: isOverdue
            ? daysFromNow(-randomBetween(1, 15))
            : daysFromNow(randomBetween(1, 90)),
          clientId: client.id,
          ownerSellerId: seller.id,
        },
      });
    }

    // Create 60 activities (5 per week, 12 weeks)
    const activityTypes = ["visita", "follow_up", "envio_proposta"];
    for (let week = 0; week < 12; week++) {
      for (let day = 0; day < 5; day++) {
        const dayOffset = (week - 6) * 7 + day;
        const dueDate = daysFromNow(dayOffset);
        const isPast = dayOffset < 0;
        await prisma.activity.create({
          data: {
            type: activityTypes[(week + day) % activityTypes.length] as any,
            notes: `[fixture] Atividade semana ${week + 1} dia ${day + 1}`,
            dueDate,
            done: isPast,
            ownerSellerId: seller.id,
          },
        });
      }
    }

    // Create 36 agenda events (3 per week, 12 weeks)
    const eventTypes = ["reuniao_online", "reuniao_presencial", "roteiro_visita"];
    for (let week = 0; week < 12; week++) {
      for (let e = 0; e < 3; e++) {
        const dayOffset = (week - 6) * 7 + e * 2;
        const startDateTime = daysFromNow(dayOffset);
        const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
        const type = eventTypes[e];
        const event = await prisma.agendaEvent.create({
          data: {
            title: `[fixture] Evento semana ${week + 1} - ${type}`,
            type: type as any,
            startDateTime,
            endDateTime,
            status: dayOffset < 0 ? "realizado" : "agendado",
            sellerId: seller.id,
          },
        });

        // Add stops for roteiro_visita
        if (type === "roteiro_visita") {
          const stopCount = randomBetween(4, 6);
          for (let s = 0; s < stopCount; s++) {
            const client = clients[s % clients.length];
            await prisma.agendaStop.create({
              data: {
                agendaEventId: event.id,
                order: s + 1,
                clientId: client.id,
                city: client.city,
                notes: `[fixture] Parada ${s + 1}`,
              },
            });
          }
        }
      }
    }

    console.log(`Done for seller ${seller.id}`);
  }

  console.log("Fixture seed complete.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
