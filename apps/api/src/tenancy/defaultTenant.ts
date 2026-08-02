import { createHash } from "node:crypto";

export const DEFAULT_TENANT_IDENTITY_VERSION = 1 as const;
export const DEFAULT_TENANT = Object.freeze({
  id: "tenant-default-v1",
  slug: "default-v1",
  legalName: "Gest-o Compatibility Tenant",
  displayName: "Gest-o Default"
});

export type ClosedTenantRole = "diretor" | "gerente" | "vendedor";

export function mapUserRole(role: string): ClosedTenantRole {
  if (role === "diretor" || role === "gerente" || role === "vendedor") return role;
  throw new Error(`UNKNOWN_USER_ROLE:${role}`);
}

export const deterministicMembershipId = (userId: string) =>
  `tm_${createHash("sha256").update(`${DEFAULT_TENANT.id}\0${userId}`).digest("hex").slice(0, 32)}`;

export function membershipAggregateHash(rows: ReadonlyArray<{ userId: string; tenantId: string; role: string; version: number }>) {
  const canonical = [...rows]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map(({ userId, tenantId, role, version }) => `${userId}\t${tenantId}\t${role}\t${version}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
