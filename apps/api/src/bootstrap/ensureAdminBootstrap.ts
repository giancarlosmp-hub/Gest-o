import { Role } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword } from "../utils/password.js";

const DEFAULT_PREVIEW_ADMIN = {
  name: "Admin Preview",
  email: "admin@preview.com",
  password: "123456",
  role: Role.diretor,
  region: "Nacional",
  isActive: true
} as const;

function getBootstrapAdminConfig() {
  return {
    name: env.adminBootstrapName?.trim() || DEFAULT_PREVIEW_ADMIN.name,
    email: env.adminBootstrapEmail?.trim().toLowerCase() || DEFAULT_PREVIEW_ADMIN.email,
    password: env.adminBootstrapPassword || DEFAULT_PREVIEW_ADMIN.password,
    role: Role.diretor,
    region: env.adminBootstrapRegion?.trim() || DEFAULT_PREVIEW_ADMIN.region,
    isActive: true
  } as const;
}

function isAdminBootstrapExplicitlyEnabled() {
  return env.adminBootstrapEnabled;
}

export async function ensureAdminBootstrap() {
  if (!isAdminBootstrapExplicitlyEnabled()) {
    return;
  }

  const existingDirector = await prisma.user.findFirst({
    where: { role: Role.diretor },
    select: { id: true, email: true }
  });

  if (existingDirector) {
    logApiEvent("INFO", "Admin bootstrap ignorado: já existe usuário diretor", {
      email: existingDirector.email
    });
    return;
  }

  const bootstrapAdmin = getBootstrapAdminConfig();

  const existingPreviewAdmin = await prisma.user.findUnique({
    where: { email: bootstrapAdmin.email },
    select: { id: true, role: true }
  });

  if (existingPreviewAdmin) {
    logApiEvent("WARN", "Admin bootstrap não criou usuário: email padrão já existe sem role diretor", {
      email: bootstrapAdmin.email,
      role: existingPreviewAdmin.role
    });
    return;
  }

  const passwordHash = await hashPassword(bootstrapAdmin.password);

  await prisma.user.create({
    data: {
      name: bootstrapAdmin.name,
      email: bootstrapAdmin.email,
      passwordHash,
      role: bootstrapAdmin.role,
      region: bootstrapAdmin.region,
      isActive: bootstrapAdmin.isActive
    }
  });

  logApiEvent("INFO", "Usuário admin de preview criado automaticamente", {
    email: bootstrapAdmin.email,
    role: bootstrapAdmin.role,
    region: bootstrapAdmin.region
  });
}
