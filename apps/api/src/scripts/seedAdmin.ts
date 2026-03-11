import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const DEFAULT_ADMIN = {
  name: "Diretor",
  email: "diretor@empresa.com",
  password: "123456",
  role: Role.diretor
};

export async function seedAdmin() {
  const existingAdmin = await prisma.user.findUnique({
    where: { email: DEFAULT_ADMIN.email },
    select: { id: true }
  });

  if (existingAdmin) {
    return;
  }

  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return;
  }

  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);

  await prisma.user.create({
    data: {
      name: DEFAULT_ADMIN.name,
      email: DEFAULT_ADMIN.email,
      passwordHash,
      role: DEFAULT_ADMIN.role
    }
  });

  console.log("Default admin user created: diretor@empresa.com");
}
