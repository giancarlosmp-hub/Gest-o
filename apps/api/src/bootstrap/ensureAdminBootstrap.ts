import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

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

  const generatedPasswordHash = await hashPassword(PREVIEW_ADMIN.password);
  console.log('[BOOTSTRAP_DEBUG] hash gerado para "123456":', generatedPasswordHash);
  console.log(
    '[BOOTSTRAP_DEBUG] bcrypt.compare("123456", hashGerado):',
    await verifyPassword(PREVIEW_ADMIN.password, generatedPasswordHash)
  );

  const existingPreviewAdminForDebug = await prisma.user.findFirst({
    where: {
      email: { in: ["admin@preview.local", "admin@preview.com"] }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      role: true,
      region: true,
      isActive: true
    }
  });

  console.log("[BOOTSTRAP_DEBUG] usuário salvo no banco (antes do bootstrap):", existingPreviewAdminForDebug);
  if (existingPreviewAdminForDebug?.passwordHash) {
    console.log(
      '[BOOTSTRAP_DEBUG] bcrypt.compare("123456", hashBancoAntesBootstrap):',
      await verifyPassword(PREVIEW_ADMIN.password, existingPreviewAdminForDebug.passwordHash)
    );
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

  const createdUser = await prisma.user.create({
    data: {
      name: PREVIEW_ADMIN.name,
      email: PREVIEW_ADMIN.email,
      passwordHash: generatedPasswordHash,
      role: PREVIEW_ADMIN.role,
      region: PREVIEW_ADMIN.region,
      isActive: PREVIEW_ADMIN.isActive
    },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      role: true,
      region: true,
      isActive: true
    }
  });

  console.log("[BOOTSTRAP_DEBUG] usuário salvo no banco:", createdUser);
  console.log(
    '[BOOTSTRAP_DEBUG] bcrypt.compare("123456", hashSalvo):',
    await verifyPassword(PREVIEW_ADMIN.password, createdUser.passwordHash)
  );

  logApiEvent("INFO", "Usuário admin de preview criado automaticamente", {
    email: PREVIEW_ADMIN.email,
    role: PREVIEW_ADMIN.role,
    region: PREVIEW_ADMIN.region
  });
}
