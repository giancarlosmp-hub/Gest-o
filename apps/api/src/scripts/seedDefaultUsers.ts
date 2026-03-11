import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

const DEFAULT_PASSWORD = "123456";

const DEFAULT_USERS: Array<{ name: string; email: string; role: Role; region: string }> = [
  { name: "Diretor", email: "diretor@empresa.com", role: Role.diretor, region: "Nacional" },
  { name: "Gerente", email: "gerente@empresa.com", role: Role.gerente, region: "Nacional" },
  { name: "Vendedor 1", email: "vendedor1@empresa.com", role: Role.vendedor, region: "Sudeste" },
  { name: "Vendedor 2", email: "vendedor2@empresa.com", role: Role.vendedor, region: "Sul" },
  { name: "Vendedor 3", email: "vendedor3@empresa.com", role: Role.vendedor, region: "Nordeste" },
  { name: "Vendedor 4", email: "vendedor4@empresa.com", role: Role.vendedor, region: "Centro-Oeste" }
];

export async function seedDefaultUsers() {
  const defaultPasswordHash = await hashPassword(DEFAULT_PASSWORD);

  for (const user of DEFAULT_USERS) {
    const existing = await prisma.user.findUnique({
      where: { email: user.email },
      select: { id: true, passwordHash: true }
    });

    if (!existing) {
      await prisma.user.create({
        data: {
          name: user.name,
          email: user.email,
          role: user.role,
          region: user.region,
          passwordHash: defaultPasswordHash,
          isActive: true
        }
      });

      console.log(`Seed user created: ${user.email}`);
      continue;
    }

    const hasValidDefaultPassword = await verifyPassword(DEFAULT_PASSWORD, existing.passwordHash);
    if (!hasValidDefaultPassword) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: user.name,
          role: user.role,
          region: user.region,
          passwordHash: defaultPasswordHash,
          isActive: true
        }
      });
      console.log(`Seed user password refreshed: ${user.email}`);
      continue;
    }

    await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: user.name,
        role: user.role,
        region: user.region,
        isActive: true
      }
    });

    console.log(`Seed user already valid: ${user.email}`);
  }
}
