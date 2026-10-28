import type { TenantRole } from "@prisma/client";
import { prisma } from "../config/prisma.js";

// Banco descartável (compose do CI): prisma/seed.js não cria tenant, e as rotas que exigem tenant recusam os usuários
// dele. Cria um tenant fictício, vincula os usuários do seed e preenche o tenant dos clientes sem tenant (inclusive o
// do ensureSmokeBootstrap). Idempotente. Fora de DATABASE_SCHEMA_MODE=ephemeral-push não faz nada.
export const SEED_TENANT_ID = "seed-tenant-ficticio";
const SEED_USER_EMAILS = [
  "diretor@empresa.com",
  "gerente@empresa.com",
  "vendedor1@empresa.com",
  "vendedor2@empresa.com",
  "vendedor3@empresa.com",
  "vendedor4@empresa.com"
];

export async function ensureSeedTenant(schemaMode: string | undefined = process.env.DATABASE_SCHEMA_MODE) {
  if (schemaMode !== "ephemeral-push") {
    console.log("Tenant do seed ignorado: DATABASE_SCHEMA_MODE não é ephemeral-push");
    return;
  }

  const realUsersCount = await prisma.user.count({ where: { email: { contains: "@demetraagronegocios.com.br" } } });
  if (realUsersCount > 0) {
    console.log("Usuários reais encontrados, pulando tenant do seed.");
    return;
  }

  await prisma.tenant.upsert({
    where: { id: SEED_TENANT_ID },
    update: {},
    create: { id: SEED_TENANT_ID, slug: "seed-ficticio", legalName: "Tenant Fictício do Seed", displayName: "Seed Fictício", status: "active" }
  });

  const users = await prisma.user.findMany({ where: { email: { in: SEED_USER_EMAILS } }, select: { id: true, role: true } });
  for (const user of users) {
    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: SEED_TENANT_ID, userId: user.id } },
      update: { status: "active" },
      create: {
        id: `seed-membership-${user.id}`,
        tenantId: SEED_TENANT_ID,
        userId: user.id,
        role: user.role as TenantRole,
        status: "active",
        version: 1,
        acceptedAt: new Date()
      }
    });
  }

  const clients = await prisma.client.updateMany({ where: { tenantId: null }, data: { tenantId: SEED_TENANT_ID } });
  console.log("Tenant do seed pronto", { tenantId: SEED_TENANT_ID, memberships: users.length, clientsLinked: clients.count });
}
