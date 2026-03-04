import { PrismaClient } from "@prisma/client";

const FIXTURE_PREFIX = "[fixture-90d]";
const REGIONS = [
  { region: "Sudeste", states: ["SP", "MG", "RJ"], cities: ["Campinas", "Ribeirão Preto", "Uberlândia", "Londrina"] },
  { region: "Sul", states: ["PR", "RS", "SC"], cities: ["Cascavel", "Passo Fundo", "Chapecó", "Pato Branco"] },
  { region: "Centro-Oeste", states: ["MT", "GO", "MS"], cities: ["Sorriso", "Rio Verde", "Dourados", "Rondonópolis"] },
  { region: "Nordeste", states: ["BA", "PE", "CE"], cities: ["Luís Eduardo Magalhães", "Petrolina", "Barreiras", "Fortaleza"] },
  { region: "Norte", states: ["PA", "TO", "RO"], cities: ["Paragominas", "Palmas", "Vilhena", "Santarém"] }
];

const stageDistribution = [
  { stage: "prospeccao", weight: 30 },
  { stage: "negociacao", weight: 30 },
  { stage: "proposta", weight: 20 },
  { stage: "ganho", weight: 12 },
  { stage: "perdido", weight: 8 }
];

const cropOptions = ["soja", "milho", "algodao", "cafe", "trigo", "sorgo", "feijao"];
const activityTypes = ["ligacao", "visita", "envio_proposta"];
const regularEventTypes = ["reuniao_online", "reuniao_presencial", "followup"];

function hashNumber(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function randomDateInRange(startDate, endDate, seed) {
  const start = startDate.getTime();
  const end = endDate.getTime();
  const ratio = hashNumber(seed);
  return new Date(start + Math.floor((end - start) * ratio));
}

function stageByIndex(index) {
  const total = stageDistribution.reduce((sum, item) => sum + item.weight, 0);
  const point = index % total;
  let cursor = 0;
  for (const item of stageDistribution) {
    cursor += item.weight;
    if (point < cursor) return item.stage;
  }
  return "prospeccao";
}

export async function runFixtureSeed(existingPrisma) {
  const prisma = existingPrisma || new PrismaClient();
  const shouldDisconnect = !existingPrisma;

  try {
    const sellers = await prisma.user.findMany({ where: { role: "vendedor", isActive: true }, orderBy: { email: "asc" } });

    if (sellers.length === 0) {
      console.log("Fixture seed ignorado: nenhum vendedor ativo encontrado.");
      return;
    }

    await prisma.agendaStop.deleteMany({ where: { agendaEvent: { title: { startsWith: FIXTURE_PREFIX } } } });
    await prisma.agendaEvent.deleteMany({ where: { title: { startsWith: FIXTURE_PREFIX } } });
    await prisma.activity.deleteMany({ where: { OR: [{ notes: { startsWith: FIXTURE_PREFIX } }, { opportunity: { title: { startsWith: FIXTURE_PREFIX } } }] } });
    await prisma.opportunity.deleteMany({ where: { title: { startsWith: FIXTURE_PREFIX } } });
    await prisma.contact.deleteMany({ where: { name: { startsWith: FIXTURE_PREFIX } } });
    await prisma.client.deleteMany({ where: { name: { startsWith: FIXTURE_PREFIX } } });

    const now = new Date();
    const rangeStart = addDays(now, -45);
    const rangeEnd = addDays(now, 45);

    for (const [sellerIndex, seller] of sellers.entries()) {
      const sellerClients = [];

      for (let i = 0; i < 20; i += 1) {
        const regionRef = REGIONS[(sellerIndex + i) % REGIONS.length];
        const state = regionRef.states[i % regionRef.states.length];
        const city = regionRef.cities[(i + sellerIndex) % regionRef.cities.length];

        const client = await prisma.client.create({
          data: {
            name: `${FIXTURE_PREFIX} Cliente ${sellerIndex + 1}-${String(i + 1).padStart(2, "0")}`,
            city,
            state,
            region: regionRef.region,
            potentialHa: 120 + ((i * 37) % 850),
            farmSizeHa: 180 + ((i * 53) % 1350),
            clientType: "PJ",
            segment: "Agronegócio",
            ownerSellerId: seller.id
          }
        });

        sellerClients.push(client);

        await prisma.contact.create({
          data: {
            name: `${FIXTURE_PREFIX} Contato ${sellerIndex + 1}-${i + 1}`,
            phone: `55${String(1100000000 + sellerIndex * 500000 + i * 17).slice(0, 11)}`,
            email: `fixture.s${sellerIndex + 1}.c${i + 1}@example.com`,
            role: "Comprador",
            clientId: client.id,
            ownerSellerId: seller.id
          }
        });
      }

      const opportunities = [];
      for (let i = 0; i < 30; i += 1) {
        const stage = stageByIndex(i + sellerIndex * 7);
        const client = sellerClients[i % sellerClients.length];
        const followUpDate = randomDateInRange(rangeStart, rangeEnd, sellerIndex * 1000 + i * 13 + 9);
        const isOverdue = i < 6;

        if (isOverdue && followUpDate > now) {
          followUpDate.setDate(now.getDate() - (1 + (i % 14)));
        }

        const proposalDate = addDays(followUpDate, -Math.max(2, 6 + (i % 15)));
        const expectedCloseDate = addDays(followUpDate, 5 + (i % 25));

        const value = 5000 + Math.round(hashNumber(i + sellerIndex * 11) * 245000);
        const probability = stage === "ganho" ? 100 : stage === "perdido" ? 0 : stage === "proposta" ? 65 : stage === "negociacao" ? 45 : 25;

        const opportunity = await prisma.opportunity.create({
          data: {
            title: `${FIXTURE_PREFIX} Oportunidade ${sellerIndex + 1}-${String(i + 1).padStart(2, "0")}`,
            value,
            stage,
            crop: cropOptions[(i + sellerIndex) % cropOptions.length],
            season: `${now.getFullYear()}/${now.getFullYear() + 1}`,
            areaHa: 80 + ((i * 19) % 420),
            productOffered: i % 3 === 0 ? "Tratamento de sementes" : i % 3 === 1 ? "Defensivos" : "Fertilizantes",
            plantingForecastDate: addDays(now, -20 + (i % 90)),
            expectedTicketPerHa: 130 + ((i * 11) % 220),
            proposalDate,
            followUpDate,
            expectedCloseDate,
            lastContactAt: addDays(followUpDate, -1),
            probability,
            notes: `${FIXTURE_PREFIX} oportunidade de validação da UI`,
            clientId: client.id,
            ownerSellerId: seller.id
          }
        });

        opportunities.push(opportunity);
      }

      for (let week = 0; week < 12; week += 1) {
        const weekStart = addDays(now, -42 + week * 7);

        for (let k = 0; k < 5; k += 1) {
          const dueDate = addDays(weekStart, k);
          const opp = opportunities[(week * 5 + k) % opportunities.length];

          await prisma.activity.create({
            data: {
              type: activityTypes[(week + k + sellerIndex) % activityTypes.length],
              notes: `${FIXTURE_PREFIX} Atividade semana ${week + 1} item ${k + 1}`,
              dueDate,
              done: dueDate < now,
              ownerSellerId: seller.id,
              opportunityId: opp.id
            }
          });
        }

        for (let k = 0; k < 3; k += 1) {
          const startDate = addDays(weekStart, 1 + k * 2);
          startDate.setHours(9 + k * 2, 0, 0, 0);
          const endDate = new Date(startDate);
          endDate.setHours(startDate.getHours() + 1);
          const opp = opportunities[(week * 3 + k) % opportunities.length];
          const client = sellerClients[(week * 3 + k) % sellerClients.length];

          const status = endDate < now ? "realizado" : "agendado";
          await prisma.agendaEvent.create({
            data: {
              title: `${FIXTURE_PREFIX} Evento ${week + 1}-${k + 1} (${k === 2 ? "kickoff" : "reunião"})`,
              type: regularEventTypes[(week + k + sellerIndex) % regularEventTypes.length],
              startDateTime: startDate,
              endDateTime: endDate,
              status,
              notes: `${FIXTURE_PREFIX} agenda para validação`,
              city: client.city,
              sellerId: seller.id,
              clientId: client.id,
              opportunityId: opp.id
            }
          });
        }

        const routeDate = addDays(weekStart, 4);
        routeDate.setHours(8, 0, 0, 0);
        const routeEnd = new Date(routeDate);
        routeEnd.setHours(17, 0, 0, 0);
        const routeStatus = week < 5 ? "realizado" : "agendado";

        const routeEvent = await prisma.agendaEvent.create({
          data: {
            title: `${FIXTURE_PREFIX} Roteiro Semana ${week + 1}`,
            type: "roteiro_visita",
            startDateTime: routeDate,
            endDateTime: routeEnd,
            status: routeStatus,
            notes: `${FIXTURE_PREFIX} roteiro semanal`,
            sellerId: seller.id
          }
        });

        const stopCount = 4 + ((week + sellerIndex) % 4);
        for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
          const client = sellerClients[(week * 7 + stopIndex) % sellerClients.length];
          const plannedTime = new Date(routeDate);
          plannedTime.setHours(8 + stopIndex * 2);
          const realized = routeStatus === "realizado" && stopIndex < stopCount - 1;

          await prisma.agendaStop.create({
            data: {
              agendaEventId: routeEvent.id,
              order: stopIndex + 1,
              clientId: client.id,
              city: client.city,
              address: `Estrada Rural ${100 + stopIndex}, ${client.city}`,
              plannedTime,
              notes: `${FIXTURE_PREFIX} parada ${stopIndex + 1}`,
              checkInAt: realized ? addDays(plannedTime, 0) : null,
              checkOutAt: realized ? new Date(plannedTime.getTime() + 60 * 60 * 1000) : null,
              resultStatus: realized ? "realizado" : "planejado",
              resultSummary: realized ? "Visita concluída" : "Planejada"
            }
          });
        }
      }
    }

    console.log("Fixture seed finalizado", { sellers: sellers.length });
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}
