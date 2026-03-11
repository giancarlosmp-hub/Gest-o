import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";

type SeedUser = {
  name: string;
  email: string;
  password: string;
  role: Role;
};

const SEED_USERS: SeedUser[] = [
  { name: "Diretor", email: "diretor@empresa.com", password: "123456", role: Role.diretor },
  { name: "Gerente", email: "gerente@empresa.com", password: "123456", role: Role.gerente },
  { name: "Vendedor 1", email: "vendedor1@empresa.com", password: "123456", role: Role.vendedor },
  { name: "Vendedor 2", email: "vendedor2@empresa.com", password: "123456", role: Role.vendedor },
  { name: "Vendedor 3", email: "vendedor3@empresa.com", password: "123456", role: Role.vendedor },
  { name: "Vendedor 4", email: "vendedor4@empresa.com", password: "123456", role: Role.vendedor }
];

async function createSeedUserIfMissing(user: SeedUser) {
  const existingUser = await prisma.user.findUnique({
    where: { email: user.email },
    select: { id: true }
  });

  if (existingUser) {
    return;
  }

  const passwordHash = await bcrypt.hash(user.password, 10);

  await prisma.user.create({
    data: {
      name: user.name,
      email: user.email,
      passwordHash,
      role: user.role
    }
  });

  console.log(`Seed user created: ${user.email}`);
}

export async function seedAdmin() {
  for (const user of SEED_USERS) {
    await createSeedUserIfMissing(user);
  }
}
