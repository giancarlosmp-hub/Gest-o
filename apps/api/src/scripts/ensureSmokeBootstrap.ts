import { prisma } from "../config/prisma.js";
import { seedDefaultUsers } from "./seedDefaultUsers.js";

const DEFAULT_SELLER_EMAIL = "vendedor1@empresa.com";
const DEFAULT_SMOKE_CLIENT_ID = "smoke-client-bootstrap";
const DEFAULT_SMOKE_CLIENT_NAME = "[smoke] Cliente Bootstrap";

export async function ensureSmokeBootstrap() {
  const realUsersCount = await prisma.user.count({
    where: { email: { contains: '@demetraagronegocios.com.br' } }
  });

  if (realUsersCount > 0) {
    console.log('Produção detectada, pulando smoke bootstrap.');
    return;
  }

  await seedDefaultUsers();

  const seller = await prisma.user.findUnique({ where: { email: DEFAULT_SELLER_EMAIL }, select: { id: true, email: true } });
  if (!seller) {
    throw new Error(`Seed seller not found: ${DEFAULT_SELLER_EMAIL}`);
  }

  const existingClient = await prisma.client.findUnique({ where: { id: DEFAULT_SMOKE_CLIENT_ID }, select: { id: true } });

  if (existingClient) {
    await prisma.client.update({
      where: { id: DEFAULT_SMOKE_CLIENT_ID },
      data: {
        name: DEFAULT_SMOKE_CLIENT_NAME,
        city: "São Paulo",
        state: "SP",
        region: "Sudeste",
        ownerSellerId: seller.id,
        clientType: "PJ"
      }
    });
    console.log(`Seed client already exists: ${DEFAULT_SMOKE_CLIENT_ID}`);
  } else {
    await prisma.client.create({
      data: {
        id: DEFAULT_SMOKE_CLIENT_ID,
        name: DEFAULT_SMOKE_CLIENT_NAME,
        city: "São Paulo",
        state: "SP",
        region: "Sudeste",
        ownerSellerId: seller.id,
        clientType: "PJ"
      }
    });
    console.log(`Seed client created: ${DEFAULT_SMOKE_CLIENT_ID}`);
  }

  const month = new Date().toISOString().slice(0, 7);
  const existingGoal = await prisma.goal.findUnique({
    where: {
      sellerId_month: {
        sellerId: seller.id,
        month
      }
    },
    select: { id: true }
  });

  if (existingGoal) {
    console.log(`Seed goal already exists: ${seller.email} (${month})`);
  } else {
    await prisma.goal.create({
      data: {
        sellerId: seller.id,
        month,
        targetValue: 100000
      }
    });
    console.log(`Seed goal created: ${seller.email} (${month})`);
  }

  console.log("Bootstrap smoke garantido", {
    sellerEmail: seller.email,
    month
  });
}
