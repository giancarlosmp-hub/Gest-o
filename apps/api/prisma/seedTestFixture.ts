import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const SOURCE_TAG = "source=fixture";
const FIXTURE_PREFIX = `[fixture|${SOURCE_TAG}]`;
const WINDOW_PAST_DAYS = 45;
const WINDOW_FUTURE_DAYS = 15;

const BR_STATES = ["SP", "RJ", "MG", "RS", "PR", "SC", "BA", "GO", "MT", "MS", "TO", "MS"];
const REGIONS = ["Sul", "Sudeste", "Centro-Oeste", "Norte", "Nordeste"];
const SEGMENTS = ["Soja", "Milho", "Algodão", "Café", "Cana", "HF"];
const ACTIVITY_TYPES: Prisma.ActivityType[] = ["ligacao", "follow_up", "envio_proposta", "visita"];
const AGENDA_TYPES: Prisma.AgendaEventType[] = ["followup", "reuniao_online", "reuniao_presencial"];

type StageSeed = {
  stage: Prisma.OpportunityStage;
  count: number;
  probabilityMin: number;
  probabilityMax: number;
  closed: boolean;
};

const STAGE_DISTRIBUTION: StageSeed[] = [
  { stage: "prospeccao", count: 3, probabilityMin: 10, probabilityMax: 35, closed: false },
  { stage: "negociacao", count: 3, probabilityMin: 40, probabilityMax: 65, closed: false },
  { stage: "proposta", count: 3, probabilityMin: 70, probabilityMax: 90, closed: false },
  { stage: "ganho", count: 2, probabilityMin: 100, probabilityMax: 100, closed: true },
  { stage: "perdido", count: 1, probabilityMin: 0, probabilityMax: 10, closed: true },
];

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addDays(base: Date, days: number) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date;
}

function randomDateInWindow(today: Date, minOffset: number, maxOffset: number) {
  return addDays(today, randomBetween(minOffset, maxOffset));
}

function marker(text: string) {
  return `${FIXTURE_PREFIX} ${text}`;
}

async function cleanFixtureDataForSeller(sellerId: string) {
  await prisma.activity.deleteMany({
    where: {
      ownerSellerId: sellerId,
      notes: { contains: SOURCE_TAG },
    },
  });

  await prisma.agendaStop.deleteMany({
    where: {
      notes: { contains: SOURCE_TAG },
    },
  });

  await prisma.agendaEvent.deleteMany({
    where: {
      sellerId,
      title: { contains: SOURCE_TAG },
    },
  });

  await prisma.opportunity.deleteMany({
    where: {
      ownerSellerId: sellerId,
      title: { contains: SOURCE_TAG },
    },
  });

  await prisma.client.deleteMany({
    where: {
      ownerSellerId: sellerId,
      name: { contains: SOURCE_TAG },
    },
  });
}

async function cleanFixtureData() {
  const sellers = await prisma.user.findMany({
    where: { role: "vendedor", isActive: true },
    select: { id: true },
  });

  for (const seller of sellers) {
    await cleanFixtureDataForSeller(seller.id);
  }

  console.log("Fixture clean complete.");
}

async function seedFixtureData() {
  const sellers = await prisma.user.findMany({
    where: { role: "vendedor", isActive: true },
    select: { id: true },
  });

  if (!sellers.length) {
    console.error("No sellers found. Run the default seed first.");
    process.exit(1);
  }

  const today = new Date();

  for (const [sellerIndex, seller] of sellers.entries()) {
    console.log(`Creating fixture data for seller ${seller.id}...`);
    await cleanFixtureDataForSeller(seller.id);

    const clients = [];
    for (let i = 1; i <= 12; i++) {
      const client = await prisma.client.create({
        data: {
          name: marker(`Cliente ${i} vendedor ${sellerIndex + 1}`),
          city: `Cidade ${i}`,
          state: BR_STATES[(i + sellerIndex) % BR_STATES.length],
          region: REGIONS[(i + sellerIndex) % REGIONS.length],
          segment: SEGMENTS[(i + sellerIndex) % SEGMENTS.length],
          ownerSellerId: seller.id,
        },
      });
      clients.push(client);
    }

    const opportunities = [];
    let clientIndex = 0;

    for (const stageSeed of STAGE_DISTRIBUTION) {
      for (let i = 0; i < stageSeed.count; i++) {
        const sequence = opportunities.length + 1;
        const client = clients[clientIndex % clients.length];
        clientIndex += 1;

        const proposalDate = randomDateInWindow(today, -WINDOW_PAST_DAYS, -1);

        const followUpMode = sequence % 3;
        const followUpOffset =
          followUpMode === 0
            ? randomBetween(-10, -1)
            : followUpMode === 1
              ? randomBetween(1, 3)
              : randomBetween(4, WINDOW_FUTURE_DAYS);
        const followUpDate = addDays(today, followUpOffset);

        const expectedCloseDate = stageSeed.closed
          ? addDays(followUpDate, randomBetween(-3, 5))
          : addDays(followUpDate, randomBetween(2, 12));

        const closedAt = stageSeed.closed
          ? randomDateInWindow(
              today,
              Math.max(-WINDOW_PAST_DAYS, -30),
              stageSeed.stage === "ganho" ? 0 : 2,
            )
          : null;

        const opportunity = await prisma.opportunity.create({
          data: {
            title: marker(`Oportunidade ${sequence} ${stageSeed.stage}`),
            value: randomBetween(15000, 80000),
            stage: stageSeed.stage,
            probability: randomBetween(stageSeed.probabilityMin, stageSeed.probabilityMax),
            proposalDate,
            followUpDate,
            expectedCloseDate,
            closedAt,
            notes: marker("Oportunidade de teste guiado 60 dias"),
            clientId: client.id,
            ownerSellerId: seller.id,
          },
        });

        opportunities.push(opportunity);
      }
    }

    const activityTargets = opportunities.slice(0, 8);
    for (const [index, opportunity] of activityTargets.entries()) {
      const dueDate = addDays(today, randomBetween(-WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS));
      await prisma.activity.create({
        data: {
          type: ACTIVITY_TYPES[index % ACTIVITY_TYPES.length],
          notes: marker(`Atividade oportunidade ${index + 1}`),
          dueDate,
          done: dueDate < today,
          opportunityId: opportunity.id,
          ownerSellerId: seller.id,
        },
      });
    }

    const agendaTargets = opportunities.slice(2, 10);
    for (const [index, opportunity] of agendaTargets.entries()) {
      const start = addDays(today, randomBetween(-WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS));
      const end = addDays(start, 0);
      end.setHours(end.getHours() + 1);

      await prisma.agendaEvent.create({
        data: {
          title: marker(`Compromisso oportunidade ${index + 1}`),
          type: AGENDA_TYPES[index % AGENDA_TYPES.length],
          startDateTime: start,
          endDateTime: end,
          status: start < today ? "realizado" : "agendado",
          notes: marker("Compromisso criado via fixture"),
          city: clients[index % clients.length]?.city,
          clientId: opportunity.clientId,
          opportunityId: opportunity.id,
          sellerId: seller.id,
        },
      });
    }

    console.log(`Done for seller ${seller.id}`);
  }

  console.log("Fixture seed complete.");
}

async function main() {
  const cleanOnly = process.argv.includes("--clean") || process.env.SEED_FIXTURE_CLEAN === "1";

  if (cleanOnly) {
    await cleanFixtureData();
    return;
  }

  await seedFixtureData();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
