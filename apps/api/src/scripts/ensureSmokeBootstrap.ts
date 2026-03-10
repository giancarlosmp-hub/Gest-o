import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";

export async function ensureSmokeBootstrap() {
  if (!env.enableSmokeBootstrap) return;

  const [usersCount, clientsCount, opportunitiesCount] = await Promise.all([
    prisma.user.count(),
    prisma.client.count(),
    prisma.opportunity.count()
  ]);

  if (usersCount > 0 || clientsCount > 0 || opportunitiesCount > 0) {
    console.log("Bootstrap smoke ignorado: base já possui dados", {
      usersCount,
      clientsCount,
      opportunitiesCount
    });
    return;
  }

  const passwordHash = await bcrypt.hash(env.smokeDirectorPassword, 10);

  const director = await prisma.user.upsert({
    where: { email: env.smokeDirectorEmail },
    update: {
      name: "Diretor Smoke",
      role: "diretor",
      region: "Nacional",
      isActive: true,
      passwordHash
    },
    create: {
      name: "Diretor Smoke",
      email: env.smokeDirectorEmail,
      role: "diretor",
      region: "Nacional",
      isActive: true,
      passwordHash
    }
  });

  const seller = await prisma.user.upsert({
    where: { email: env.smokeSellerEmail },
    update: {
      name: "Vendedor Smoke",
      role: "vendedor",
      region: "Sudeste",
      isActive: true
    },
    create: {
      name: "Vendedor Smoke",
      email: env.smokeSellerEmail,
      role: "vendedor",
      region: "Sudeste",
      isActive: true,
      passwordHash
    }
  });

  await prisma.client.upsert({
    where: { id: "smoke-client-bootstrap" },
    update: {
      name: "[smoke] Cliente Bootstrap",
      city: "São Paulo",
      state: "SP",
      region: "Sudeste",
      ownerSellerId: seller.id,
      clientType: "PJ"
    },
    create: {
      id: "smoke-client-bootstrap",
      name: "[smoke] Cliente Bootstrap",
      city: "São Paulo",
      state: "SP",
      region: "Sudeste",
      ownerSellerId: seller.id,
      clientType: "PJ"
    }
  });

  await prisma.goal.upsert({
    where: {
      sellerId_month: {
        sellerId: seller.id,
        month: new Date().toISOString().slice(0, 7)
      }
    },
    update: {
      targetValue: 100000
    },
    create: {
      sellerId: seller.id,
      month: new Date().toISOString().slice(0, 7),
      targetValue: 100000
    }
  });

  console.log("Bootstrap smoke garantido", {
    directorEmail: director.email,
    sellerEmail: seller.email
  });
}
