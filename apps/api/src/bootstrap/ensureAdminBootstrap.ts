import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword } from "../utils/password.js";

const PREVIEW_ADMIN = {
  name: "Admin Preview",
  email: "admin@preview.com",
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

  const existingPreviewAdmin = await prisma.user.findUnique({
    where: { email: PREVIEW_ADMIN.email },
    select: { id: true, role: true }
  });

  if (existingPreviewAdmin) {
    logApiEvent("WARN", "Admin bootstrap não criou usuário: email padrão já existe sem role diretor", {
      email: PREVIEW_ADMIN.email,
      role: existingPreviewAdmin.role
    });
    return;
  }

  const passwordHash = await hashPassword(PREVIEW_ADMIN.password);

  await prisma.user.create({
    data: {
      name: PREVIEW_ADMIN.name,
      email: PREVIEW_ADMIN.email,
      passwordHash,
      role: PREVIEW_ADMIN.role,
      region: PREVIEW_ADMIN.region,
      isActive: PREVIEW_ADMIN.isActive
    }
  });

  logApiEvent("INFO", "Usuário admin de preview criado automaticamente", {
    email: PREVIEW_ADMIN.email,
    role: PREVIEW_ADMIN.role,
    region: PREVIEW_ADMIN.region
  });
}
