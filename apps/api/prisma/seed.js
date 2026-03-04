import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function upsertUser(name, email, role, region) {
  const passwordHash = await bcrypt.hash("123456", 10);
  return prisma.user.upsert({
    where: { email },
    update: { name, role, region, passwordHash },
    create: { name, email, role, region, passwordHash }
  });
}

const cropOptions = ["soja", "milho", "algodão", "café", "trigo"];
const stageOptions = ["prospeccao", "negociacao", "proposta", "ganho", "perdido"];

const baseCultures = [
  {
    slug: "sorgo",
    label: "Sorgo",
    defaultKgHaMin: 8,
    defaultKgHaMax: 18,
    goalsJson: { silagem: { min: 12, max: 18 }, grao: { min: 8, max: 12 } },
    notes: "Ajustar conforme PMS e vigor do lote.",
    pmsDefault: 28,
    germinationDefault: 85,
    purityDefault: 98,
    populationTargetDefault: 180000,
    tags: ["verao", "forrageira", "graos"]
  },
  {
    slug: "milho",
    label: "Milho",
    defaultKgHaMin: 14,
    defaultKgHaMax: 24,
    goalsJson: { grao: { min: 14, max: 20 }, silagem: { min: 18, max: 24 } },
    notes: "Regular a semeadora conforme híbrido e espaçamento.",
    pmsDefault: 32,
    germinationDefault: 90,
    purityDefault: 98,
    populationTargetDefault: 65000,
    tags: ["verao", "graos"]
  },
  {
    slug: "milheto", label: "Milheto", defaultKgHaMin: 10, defaultKgHaMax: 20,
    goalsJson: { cobertura: { min: 15, max: 20 }, pastejo: { min: 10, max: 15 } },
    notes: "Boa opção para cobertura rápida de solo.", tags: ["cobertura", "verao", "forrageira"]
  },
  {
    slug: "trigo", label: "Trigo", defaultKgHaMin: 100, defaultKgHaMax: 140,
    goalsJson: { grao: { min: 100, max: 140 } },
    notes: "Refinar pela população alvo e ambiente.", tags: ["inverno", "graos"]
  },
  {
    slug: "aveia", label: "Aveia", defaultKgHaMin: 60, defaultKgHaMax: 100,
    goalsJson: { cobertura: { min: 60, max: 90 }, pastejo: { min: 80, max: 100 } },
    notes: "Pode ser usada para cobertura e pastejo.", tags: ["inverno", "cobertura", "forrageira"]
  },
  {
    slug: "brachiaria", label: "Braquiária", defaultKgHaMin: 8, defaultKgHaMax: 15,
    goalsJson: { cobertura: { min: 8, max: 12 }, pastejo: { min: 10, max: 15 } },
    notes: "Avaliar valor cultural e pureza do lote.", tags: ["forrageira", "cobertura"]
  },
  {
    slug: "soja", label: "Soja", defaultKgHaMin: 45, defaultKgHaMax: 80,
    goalsJson: { grao: { min: 45, max: 80 } },
    notes: "Ajustar à população por cultivar e ciclo.", tags: ["verao", "graos"]
  },
  {
    slug: "feijao", label: "Feijão", defaultKgHaMin: 50, defaultKgHaMax: 80,
    goalsJson: { grao: { min: 50, max: 80 } },
    notes: "Verificar PMS e stand final desejado.", tags: ["graos"]
  },
  {
    slug: "centeio", label: "Centeio", defaultKgHaMin: 70, defaultKgHaMax: 120,
    goalsJson: { cobertura: { min: 70, max: 120 } },
    notes: "Alto potencial de produção de palha.", tags: ["inverno", "cobertura"]
  },
  {
    slug: "azevem", label: "Azevém", defaultKgHaMin: 20, defaultKgHaMax: 35,
    goalsJson: { pastejo: { min: 20, max: 35 } },
    notes: "Muito utilizado para pastejo no inverno.", tags: ["inverno", "forrageira", "pastejo"]
  }
];

const cityByRegion = {
  Sudeste: ["Ribeirão Preto", "Uberaba", "Patrocínio"],
  Sul: ["Londrina", "Cascavel", "Passo Fundo"],
  Nordeste: ["Luís Eduardo Magalhães", "Barreiras", "Balsas"],
  "Centro-Oeste": ["Sorriso", "Rio Verde", "Dourados"]
};

async function main() {
  await prisma.appConfig.upsert({
    where: { key: "weeklyVisitGoal" },
    update: { value: "25" },
    create: { key: "weeklyVisitGoal", value: "25" }
  });

  const diretor = await upsertUser("Diretor Comercial", "diretor@empresa.com", "diretor", "Nacional");
  const gerente = await upsertUser("Gerente Regional", "gerente@empresa.com", "gerente", "Sudeste");
  const vendedores = await Promise.all([
    upsertUser("Vendedor 1", "vendedor1@empresa.com", "vendedor", "Sudeste"),
    upsertUser("Vendedor 2", "vendedor2@empresa.com", "vendedor", "Sul"),
    upsertUser("Vendedor 3", "vendedor3@empresa.com", "vendedor", "Nordeste"),
    upsertUser("Vendedor 4", "vendedor4@empresa.com", "vendedor", "Centro-Oeste")
  ]);

  await prisma.agendaStop.deleteMany();
  await prisma.agendaEvent.deleteMany();
  await prisma.goal.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.client.deleteMany();

  for (const culture of baseCultures) {
    await prisma.cultureCatalog.upsert({
      where: { slug: culture.slug },
      update: { ...culture, isActive: true },
      create: { ...culture, isActive: true }
    });
  }

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let firstSellerId = "";
  let firstClientId = "";

  for (const seller of vendedores) {
    if (!firstSellerId) firstSellerId = seller.id;
    await prisma.goal.create({ data: { month, targetValue: 100000, sellerId: seller.id } });

    const cities = cityByRegion[seller.region] || ["São Paulo"];

    for (let idx = 0; idx < 3; idx += 1) {
      const farmSizeHa = 350 + idx * 200 + Math.floor(Math.random() * 150);
      const potentialHa = Math.round(farmSizeHa * (0.55 + Math.random() * 0.35));

      const client = await prisma.client.create({
        data: {
          name: `Cliente ${seller.name} ${idx + 1}`,
          city: cities[idx % cities.length],
          state: seller.region === "Sul" ? "PR" : seller.region === "Nordeste" ? "BA" : seller.region === "Centro-Oeste" ? "MT" : "SP",
          region: seller.region || "Sudeste",
          potentialHa,
          farmSizeHa,
          clientType: "PJ",
          segment: "Agronegócio",
          ownerSellerId: seller.id
        }
      });

      if (!firstClientId) firstClientId = client.id;

      await prisma.contact.create({
        data: {
          name: `Contato ${seller.name} ${idx + 1}`,
          phone: `1199999${String(idx).padStart(4, "0")}`,
          email: `${seller.email.replace("@", `.${idx + 1}@`)}`,
          clientId: client.id,
          ownerSellerId: seller.id
        }
      });

      for (let oppIdx = 0; oppIdx < 2; oppIdx += 1) {
        const proposalDate = new Date(now);
        proposalDate.setDate(now.getDate() - (idx * 8 + oppIdx * 5));

        const followUpDate = new Date(proposalDate);
        followUpDate.setDate(proposalDate.getDate() + 5);

        const expectedCloseDate = new Date(proposalDate);
        expectedCloseDate.setDate(proposalDate.getDate() + (oppIdx % 2 === 0 ? 15 : -5));

        const plantingForecastDate = new Date(now.getFullYear(), (now.getMonth() + idx + oppIdx) % 12, 10);
        const crop = cropOptions[(idx + oppIdx) % cropOptions.length];
        const stage = stageOptions[(idx + oppIdx + vendedores.indexOf(seller)) % stageOptions.length];

        const opportunity = await prisma.opportunity.create({
          data: {
            title: `Oportunidade ${crop.toUpperCase()} ${seller.name} ${idx + 1}.${oppIdx + 1}`,
            value: 28000 + idx * 12000 + oppIdx * 7000,
            stage,
            crop,
            season: `${now.getFullYear()}/${now.getFullYear() + 1}`,
            areaHa: 100 + idx * 50 + oppIdx * 30,
            productOffered: oppIdx % 2 === 0 ? "Tratamento de sementes" : "Defensivos",
            plantingForecastDate,
            expectedTicketPerHa: 180 + idx * 15,
            proposalDate,
            followUpDate,
            expectedCloseDate,
            lastContactAt: followUpDate,
            probability: stage === "ganho" ? 100 : stage === "perdido" ? 0 : 35 + idx * 20 + oppIdx * 10,
            notes: "Oportunidade estratégica para ampliação de carteira.",
            clientId: client.id,
            ownerSellerId: seller.id
          }
        });

        await prisma.activity.create({
          data: {
            type: oppIdx % 2 === 0 ? "visita" : "ligacao",
            notes: `Acompanhamento da oportunidade ${opportunity.title}`,
            dueDate: followUpDate,
            ownerSellerId: seller.id,
            opportunityId: opportunity.id
          }
        });
      }
    }

    await prisma.sale.create({
      data: {
        date: now,
        value: 15000 + Math.floor(Math.random() * 5000),
        sellerId: seller.id
      }
    });
  }


  if (firstSellerId) {
    const pastStart = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const pastEnd = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const futureStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const futureEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    await prisma.agendaEvent.createMany({
      data: [
        {
          title: "Evento Seed Vencido",
          type: "reuniao_online",
          startDateTime: pastStart,
          endDateTime: pastEnd,
          sellerId: firstSellerId,
          clientId: firstClientId || null
        },
        {
          title: "Evento Seed Agendado",
          type: "reuniao_online",
          startDateTime: futureStart,
          endDateTime: futureEnd,
          sellerId: firstSellerId,
          clientId: firstClientId || null
        }
      ]
    });
  }

  console.log("Seed finalizado", { diretor: diretor.email, gerente: gerente.email, sellers: vendedores.length });
}

main()
  .catch((error) => {
    console.error("Falha no seed", error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
