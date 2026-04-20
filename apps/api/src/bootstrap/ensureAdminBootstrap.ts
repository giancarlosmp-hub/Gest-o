import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword } from "../utils/password.js";

function isAdminBootstrapExplicitlyEnabled() {
  return process.env.ADMIN_BOOTSTRAP_ENABLED === "true";
}

function resolveAdminBootstrapConfig() {
  const roleFromEnv = (process.env.ADMIN_BOOTSTRAP_ROLE || "diretor").trim().toLowerCase();
  const role = Object.values(Role).includes(roleFromEnv as Role) ? (roleFromEnv as Role) : Role.diretor;

  return {
    name: (process.env.ADMIN_BOOTSTRAP_NAME || "Admin Preview").trim(),
    email: (process.env.ADMIN_BOOTSTRAP_EMAIL || "admin@preview.local").trim().toLowerCase(),
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD || "123456",
    role,
    region: (process.env.ADMIN_BOOTSTRAP_REGION || "Nacional").trim(),
    isActive: true
  } as const;
}

export async function ensureAdminBootstrap() {
  if (!isAdminBootstrapExplicitlyEnabled()) {
    return;
  }

  const adminBootstrap = resolveAdminBootstrapConfig();
  const generatedPasswordHash = await hashPassword(adminBootstrap.password);

  const upsertedUser = await prisma.user.upsert({
    where: { email: adminBootstrap.email },
    create: {
      name: adminBootstrap.name,
      email: adminBootstrap.email,
      passwordHash: generatedPasswordHash,
      role: adminBootstrap.role,
      region: adminBootstrap.region,
      isActive: adminBootstrap.isActive
    },
    update: {
      name: adminBootstrap.name,
      passwordHash: generatedPasswordHash,
      role: adminBootstrap.role,
      region: adminBootstrap.region,
      isActive: adminBootstrap.isActive
    },
    select: {
      id: true,
      email: true,
      role: true,
      region: true,
      isActive: true
    }
  });

  logApiEvent("INFO", "Usuário admin de bootstrap garantido", {
    id: upsertedUser.id,
    email: upsertedUser.email,
    role: upsertedUser.role,
    region: upsertedUser.region,
    isActive: upsertedUser.isActive
  });
}
