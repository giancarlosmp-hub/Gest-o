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

  const existing = await prisma.user.findUnique({
    where: { email: adminBootstrap.email },
    select: { id: true, passwordHash: true }
  });

  const shouldRotatePassword = existing
    ? !(await verifyPassword(adminBootstrap.password, existing.passwordHash))
    : true;

  const passwordHash = shouldRotatePassword
    ? await hashPassword(adminBootstrap.password)
    : existing?.passwordHash;

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
      role: adminBootstrap.role,
      region: adminBootstrap.region,
      isActive: adminBootstrap.isActive,
      ...(shouldRotatePassword && passwordHash ? { passwordHash } : {})
    },
    select: {
      id: true,
      email: true,
      role: true,
      region: true,
      isActive: true
    }
  });

  logApiEvent("INFO", "Usuário admin técnico garantido via bootstrap", {
    id: upsertedUser.id,
    email: upsertedUser.email,
    role: upsertedUser.role,
    region: upsertedUser.region,
    isActive: upsertedUser.isActive,
    passwordRotated: shouldRotatePassword
  });
}