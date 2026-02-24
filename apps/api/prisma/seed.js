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
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  for (const seller of vendedores) {
    await prisma.goal.create({ data: { month, targetValue: 100000, sellerId: seller.id } });
    const client = await prisma.client.create({
      data: {
        name: `Cliente ${seller.name}`,
        city: "São Paulo",
        state: "SP",
        region: seller.region || "Sudeste",
        ownerSellerId: seller.id
      }
    });
    const company = await prisma.company.create({
      data: {
        name: `Empresa ${seller.name}`,
        cnpj: null,
        segment: "Tecnologia",
        ownerSellerId: seller.id
      }
    });
    await prisma.contact.create({
      data: {
        name: `Contato ${seller.name}`,
        phone: "11999999999",
        email: seller.email,
        companyId: company.id,
        ownerSellerId: seller.id
      }
    });
    const followUpDate = new Date(now);
    followUpDate.setDate(now.getDate() + 2);

    const opp = await prisma.opportunity.create({
      data: {
        title: `Oportunidade ${seller.name}`,
        value: 25000,
        stage: "negociacao",
        proposalDate: now,
        followUpDate,
        expectedCloseDate: now,
        lastContactAt: now,
        probability: 70,
        notes: "Lead qualificado para fechamento nesta safra.",
        clientId: client.id,
        ownerSellerId: seller.id
      }
    });
    await prisma.activity.create({
      data: {
        type: "ligacao",
        notes: "Follow-up inicial",
        dueDate: now,
        ownerSellerId: seller.id,
        opportunityId: opp.id
      }
    });
    await prisma.sale.create({
      data: {
        date: now,
        value: 15000 + Math.floor(Math.random() * 5000),
        sellerId: seller.id
      }
    });
  }

  console.log("Seed finalizado", { diretor: diretor.email, gerente: gerente.email });
}

main()
  .catch((error) => {
    console.error("Falha no seed", error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
