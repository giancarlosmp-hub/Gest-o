import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

const DEFAULT_PREVIEW_ADMIN = {
  name: "Admin Preview",
  email: "admin@preview.local",
  password: "123456",
  role: Role.diretor,
  region: "Nacional",
  isActive: true
} as const;

function isAdminBootstrapExplicitlyEnabled() {
  return process.env.ADMIN_BOOTSTRAP_ENABLED === "true";
}

function resolveAdminRole(role: string | undefined): Role {
  if (!role) {
    return DEFAULT_PREVIEW_ADMIN.role;
  }

  const normalizedRole = role.trim().toLowerCase() as Role;
  return Object.values(Role).includes(normalizedRole) ? normalizedRole : DEFAULT_PREVIEW_ADMIN.role;
}

function resolveAdminBootstrapConfig() {
  return {
    name: (process.env.ADMIN_BOOTSTRAP_NAME || DEFAULT_PREVIEW_ADMIN.name).trim(),
    email: (process.env.ADMIN_BOOTSTRAP_EMAIL || DEFAULT_PREVIEW_ADMIN.email).trim().toLowerCase(),
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD || DEFAULT_PREVIEW_ADMIN.password,
    role: resolveAdminRole(process.env.ADMIN_BOOTSTRAP_ROLE),
    region: (process.env.ADMIN_BOOTSTRAP_REGION || DEFAULT_PREVIEW_ADMIN.region).trim(),
    isActive: true
  } as const;
}

export async function ensureAdminBootstrap() {
  if (!isAdminBootstrapExplicitlyEnabled()) {
    return;
  }

  const adminBootstrap = resolveAdminBootstrapConfig();
  const passwordHash = await hashPassword(adminBootstrap.password);

  const upsertedUser = await prisma.user.upsert({
    where: { email: adminBootstrap.email },
    create: {
      name: adminBootstrap.name,
      email: adminBootstrap.email,
      passwordHash: passwordHash!,
      role: adminBootstrap.role,
      region: adminBootstrap.region,
      isActive: adminBootstrap.isActive
    },
    update: {
      name: adminBootstrap.name,
      passwordHash,
      role: adminBootstrap.role,
      region: adminBootstrap.region,
      isActive: adminBootstrap.isActive
    },
    select: {
      id: true,
      email: true,
      role: true,
      region: true,
      isActive: true,
      passwordHash: true
    }
  });

  const passwordMatches = await verifyPassword(adminBootstrap.password, upsertedUser.passwordHash);

  logApiEvent("INFO", "Usuário admin técnico garantido via bootstrap", {
    id: upsertedUser.id,
    email: upsertedUser.email,
    role: upsertedUser.role,
    region: upsertedUser.region,
    isActive: upsertedUser.isActive,
    passwordLength: adminBootstrap.password.length,
    hashPrefix: upsertedUser.passwordHash.slice(0, 4),
    hashLength: upsertedUser.passwordHash.length,
    passwordMatches
  });
}
