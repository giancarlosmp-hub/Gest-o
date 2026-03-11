import { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../src/utils/password.ts";

const prisma = new PrismaClient();

async function upsertUser(name, email, role, region) {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });

  if (!existing) {
    const passwordHash = await hashPassword("123456");
    const createdUser = await prisma.user.create({
      data: { name, email, role, region, passwordHash, isActive: true }
    });
    console.log(`Seed user created: ${email}`);
    return createdUser;
  }

  const hasDefaultPassword = await verifyPassword("123456", existing.passwordHash);
  if (!hasDefaultPassword) {
    const passwordHash = await hashPassword("123456");
    const refreshedUser = await prisma.user.update({
      where: { id: existing.id },
      data: { name, role, region, passwordHash, isActive: true }
    });
    console.log(`Seed user password refreshed: ${email}`);
    return refreshedUser;
  }

  const updatedUser = await prisma.user.update({
    where: { id: existing.id },
    data: { name, role, region, isActive: true }
  });
  console.log(`Seed user already valid: ${email}`);
  return updatedUser;
}

const cropOptions = ["soja", "milho", "algodão", "café", "trigo"];
const stageOptions = ["prospeccao", "negociacao", "proposta", "ganho", "perdido"];

const baseCultures = [
  { slug: "sorgo", label: "Sorgo", category: "Grãos", defaultKgHaMin: 8, defaultKgHaMax: 18, goalsJson: { silagem: { min: 12, max: 18 }, grao: { min: 8, max: 12 } }, notes: "Ajustar conforme PMS e vigor do lote.", pmsDefault: 28, germinationDefault: 85, purityDefault: 98, populationTargetDefault: 180000, rowSpacingCmDefault: 45, tags: ["verao", "forrageira", "graos"] },
  { slug: "milho", label: "Milho", category: "Grãos", defaultKgHaMin: 14, defaultKgHaMax: 24, goalsJson: { grao: { min: 14, max: 20 }, silagem: { min: 18, max: 24 } }, notes: "Regular a semeadora conforme híbrido e espaçamento.", pmsDefault: 32, germinationDefault: 90, purityDefault: 98, populationTargetDefault: 65000, rowSpacingCmDefault: 50, tags: ["verao", "graos"] },
  { slug: "milheto", label: "Milheto", category: "Cobertura", defaultKgHaMin: 10, defaultKgHaMax: 20, goalsJson: { cobertura: { min: 15, max: 20 }, pastejo: { min: 10, max: 15 } }, notes: "Boa opção para cobertura rápida de solo.", pmsDefault: 8, germinationDefault: 80, purityDefault: 95, populationTargetDefault: 250000, rowSpacingCmDefault: 34, tags: ["cobertura", "verao", "forrageira"] },
  { slug: "trigo", label: "Trigo", category: "Grãos", defaultKgHaMin: 100, defaultKgHaMax: 140, goalsJson: { grao: { min: 100, max: 140 } }, notes: "Refinar pela população alvo e ambiente.", pmsDefault: 35, germinationDefault: 85, purityDefault: 98, populationTargetDefault: 2800000, rowSpacingCmDefault: 17, tags: ["inverno", "graos"] },
  { slug: "triticale", label: "Triticale", category: "Grãos", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["inverno", "graos"] },
  { slug: "aveia-preta", label: "Aveia Preta", category: "Cobertura", defaultKgHaMin: 60, defaultKgHaMax: 90, goalsJson: { cobertura: { min: 60, max: 90 } }, notes: "Pode ser usada para cobertura e pastejo.", pmsDefault: 28, germinationDefault: 85, purityDefault: 98, populationTargetDefault: 2400000, rowSpacingCmDefault: 17, tags: ["inverno", "cobertura"] },
  { slug: "aveia-branca", label: "Aveia Branca", category: "Cobertura", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["inverno", "cobertura"] },
  { slug: "centeio", label: "Centeio", category: "Cobertura", defaultKgHaMin: 70, defaultKgHaMax: 120, goalsJson: { cobertura: { min: 70, max: 120 } }, notes: "Alto potencial de produção de palha.", tags: ["inverno", "cobertura"] },
  { slug: "trigo-mourisco", label: "Trigo Mourisco", category: "Cobertura", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["cobertura"] },
  { slug: "nabo-forrageiro", label: "Nabo Forrageiro", category: "Cobertura", defaultKgHaMin: 8, defaultKgHaMax: 14, goalsJson: { cobertura: { min: 8, max: 14 } }, notes: "Dose depende do arranjo e do mix de cobertura.", pmsDefault: 11, germinationDefault: 85, purityDefault: 97, populationTargetDefault: 500000, rowSpacingCmDefault: 17, tags: ["inverno", "cobertura"] },
  { slug: "ervilhaca", label: "Ervilhaca", category: "Leguminosas", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["leguminosa", "cobertura"] },
  { slug: "crotalaria-spectabilis", label: "Crotalária Spectabilis", category: "Leguminosas", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["leguminosa", "cobertura"] },
  { slug: "crotalaria-juncea", label: "Crotalária Juncea", category: "Leguminosas", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["leguminosa", "cobertura"] },
  { slug: "estilosantes", label: "Estilosantes", category: "Leguminosas", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["leguminosa", "forrageira"] },
  { slug: "capim-sudao", label: "Capim-Sudão", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "pastejo"] },
  { slug: "panicum-mombaca", label: "Panicum Mombaça", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "pastejo"] },
  { slug: "panicum-quenia", label: "Panicum Quênia", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "pastejo"] },
  { slug: "brachiaria-ruziziensis", label: "Brachiaria Ruziziensis", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "cobertura"] },
  { slug: "brachiaria-brizantha", label: "Brachiaria Brizantha", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "cobertura"] },
  { slug: "brachiaria-decumbens", label: "Brachiaria Decumbens", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "cobertura"] },
  { slug: "mulato-ii", label: "Brachiaria Híbrida Mulato II", category: "Forrageiras", defaultKgHaMin: null, defaultKgHaMax: null, goalsJson: {}, notes: "Ajustar conforme recomendação técnica interna.", tags: ["forrageira", "pastejo"] }
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
