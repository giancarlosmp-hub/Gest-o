import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { PrismaTenantControlPlaneReader } from "./prismaTenantControlPlaneReader.js";

const rows = [
  { id: "membership-a", tenantId: "tenant-a", userId: "user-both", role: "vendedor", status: "active", version: 1 },
  { id: "membership-b", tenantId: "tenant-b", userId: "user-both", role: "vendedor", status: "active", version: 1 },
] as const;
let receivedWhere: unknown;
const prisma = {
  tenant: { findUnique: async () => ({ id: "tenant-a", status: "active" }) },
  tenantMembership: {
    findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
    findMany: async ({ where }: { where: { userId: string } }) => {
      receivedWhere = where;
      return rows.filter((row) => row.userId === where.userId);
    },
  },
} as unknown as PrismaClient;

const reader = new PrismaTenantControlPlaneReader(prisma);
assert.equal((await reader.findMembership("membership-a"))?.id, "membership-a", "specific lookup remains compatible");
const all = await reader.findMembershipsForUser("user-both");
assert.deepEqual(receivedWhere, { userId: "user-both" });
assert.deepEqual(all.map((item) => item.id), ["membership-a", "membership-b"], "adapter returns every membership without positional selection");
assert.equal(await reader.findMembership("missing"), null);
assert(!all.some((item) => item.status !== "active"));
console.log("Prisma tenant control-plane reader contract: PASS");
