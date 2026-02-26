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
const cityByRegion = {
  Sudeste: ["Ribeirão Preto", "Uberaba", "Patrocínio"],
  Sul: ["Londrina", "Cascavel", "Passo Fundo"],
  Nordeste: ["Luís Eduardo Magalhães", "Barreiras", "Balsas"],
  "Centro-Oeste": ["Sorriso", "Rio Verde", "Dourados"]
};

async function main() {
  const diretor = await upsertUser("Diretor Comercial", "diretor@empresa.com", "diretor", "Nacional");
  const gerente = await upsertUser("Gerente Regional", "gerente@empresa.com", "gerente", "Sudeste");
  const vendedores = await Promise.all([
    upsertUser("Vendedor 1", "vendedor1@empresa.com", "vendedor", "Sudeste"),
    upsertUser("Vendedor 2", "vendedor2@empresa.com", "vendedor", "Sul"),
    upsertUser("Vendedor 3", "vendedor3@empresa.com", "vendedor", "Nordeste"),
    upsertUser("Vendedor 4", "vendedor4@empresa.com", "vendedor", "Centro-Oeste")
  ]);

  await prisma.goal.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.client.deleteMany();

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  for (const seller of vendedores) {
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

  console.log("Seed finalizado", { diretor: diretor.email, gerente: gerente.email, sellers: vendedores.length });
}

main()
  .catch((error) => {
    console.error("Falha no seed", error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
