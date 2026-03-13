import { Role } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword } from "../utils/password.js";

type AdminBootstrapConfig = {
  name: string;
  email: string;
  password: string;
  role: Role;
  region: string;
};

function toRole(roleRaw: string): Role {
  const normalized = roleRaw.trim().toLowerCase();
  const allowedRoles = Object.values(Role);

  if (!allowedRoles.includes(normalized as Role)) {
    throw new Error(`ADMIN_BOOTSTRAP_ROLE inválido. Use um destes valores: ${allowedRoles.join(", ")}`);
  }

  return normalized as Role;
}

function readRequiredEnv(name: string, value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Variável obrigatória ausente: ${name}`);
  }

  return normalized;
}

function getAdminBootstrapConfig(): AdminBootstrapConfig {
  return {
    name: readRequiredEnv("ADMIN_BOOTSTRAP_NAME", env.adminBootstrapName),
    email: readRequiredEnv("ADMIN_BOOTSTRAP_EMAIL", env.adminBootstrapEmail).toLowerCase(),
    password: readRequiredEnv("ADMIN_BOOTSTRAP_PASSWORD", env.adminBootstrapPassword),
    role: toRole(readRequiredEnv("ADMIN_BOOTSTRAP_ROLE", env.adminBootstrapRole)),
    region: readRequiredEnv("ADMIN_BOOTSTRAP_REGION", env.adminBootstrapRegion)
  };
}

export async function ensureAdminBootstrap() {
  if (!env.adminBootstrapEnabled) {
    return;
  }

  const realUsersCount = await prisma.user.count({
    where: { email: { contains: '@demetraagronegocios.com.br' } }
  });

  if (realUsersCount > 0) {
    console.log('Produção detectada, pulando admin bootstrap.');
    return;
  }

  const config = getAdminBootstrapConfig();
  const passwordHash = await hashPassword(config.password);

  const existingUser = await prisma.user.findUnique({
    where: { email: config.email },
    select: { id: true }
  });

  if (!existingUser) {
    await prisma.user.create({
      data: {
        name: config.name,
        email: config.email,
        passwordHash,
        role: config.role,
        region: config.region,
        isActive: true
      }
    });

    logApiEvent("INFO", "Usuário administrativo inicial criado", {
      email: config.email,
      role: config.role,
      region: config.region
    });
    return;
  }

  await prisma.user.update({
    where: { id: existingUser.id },
    data: {
      name: config.name,
      passwordHash,
      role: config.role,
      region: config.region,
      isActive: true
    }
  });

  logApiEvent("INFO", "Usuário administrativo inicial atualizado", {
    email: config.email,
    role: config.role,
    region: config.region
  });
}
