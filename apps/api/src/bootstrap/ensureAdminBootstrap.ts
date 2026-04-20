import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
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

export async function ensureAdminBootstrap() {
  if (!isAdminBootstrapExplicitlyEnabled()) {
    return;
  }

  const adminConfig = {
    name: env.adminBootstrapName || DEFAULT_PREVIEW_ADMIN.name,
    email: env.adminBootstrapEmail || DEFAULT_PREVIEW_ADMIN.email,
    password: env.adminBootstrapPassword || DEFAULT_PREVIEW_ADMIN.password,
    role: (env.adminBootstrapRole as Role | undefined) || DEFAULT_PREVIEW_ADMIN.role,
    region: env.adminBootstrapRegion || DEFAULT_PREVIEW_ADMIN.region,
    isActive: true
  };

  const existing = await prisma.user.findUnique({
    where: { email: adminConfig.email },
    select: { id: true, passwordHash: true, role: true, region: true, isActive: true, name: true }
  });

  const shouldRotatePassword = existing ? !(await verifyPassword(adminConfig.password, existing.passwordHash)) : true;
  const passwordHash = shouldRotatePassword ? await hashPassword(adminConfig.password) : existing?.passwordHash;

  const user = await prisma.user.upsert({
    where: { email: adminConfig.email },
    create: {
      name: adminConfig.name,
      email: adminConfig.email,
      passwordHash: passwordHash!,
      role: adminConfig.role,
      region: adminConfig.region,
      isActive: true
    },
    update: {
      name: adminConfig.name,
      role: adminConfig.role,
      region: adminConfig.region,
      isActive: true,
      ...(shouldRotatePassword && passwordHash ? { passwordHash } : {})
    },
    select: { id: true, email: true, role: true, region: true }
  });

  logApiEvent("INFO", "Usuário admin técnico garantido via bootstrap", {
    email: user.email,
    role: user.role,
    region: user.region,
    passwordRotated: shouldRotatePassword
  });
}
