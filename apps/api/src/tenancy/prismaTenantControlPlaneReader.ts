import type { PrismaClient } from "@prisma/client";
import type { TenantControlPlaneReader } from "./tenantContext.js";

export class PrismaTenantControlPlaneReader implements TenantControlPlaneReader {
  constructor(private readonly prisma: PrismaClient) {}

  async findTenant(tenantId: string) {
    return this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true } });
  }

  async findMembership(membershipId: string) {
    return this.prisma.tenantMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, tenantId: true, userId: true, role: true, status: true, version: true }
    });
  }
}
