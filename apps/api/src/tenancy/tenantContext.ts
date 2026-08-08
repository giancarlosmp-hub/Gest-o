export type TenantRole = "diretor" | "gerente" | "vendedor";
export type LegacyUserRole = TenantRole;
export type PlatformRole = "platform_admin" | "platform_support" | "platform_operator";
export type TenantResolutionSource = "tenant_claim" | "active_membership" | "legacy_default_only" | "synthetic_test";
export type TenantContextSource = TenantResolutionSource;

export const TENANT_CONTEXT_VERSION = 1 as const;

/** Backend-only authorization result. It contains identifiers, roles and lifecycle state, never PII or credentials. */
export type TenantContext = Readonly<{
  tenantId: string;
  tenantSlug?: string;
  userId: string;
  membershipId: string;
  membershipStatus: "active";
  membershipRole: TenantRole;
  legacyUserRole: LegacyUserRole;
  resolutionSource: TenantResolutionSource;
  contextVersion: typeof TENANT_CONTEXT_VERSION;
}>;

export type TenantRecord = Readonly<{ id: string; slug?: string; status: "active" | "suspended" | "archived" }>;
export type MembershipRecord = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: "invited" | "active" | "revoked";
  version: number;
}>;

/** Claims are accepted only after the caller has cryptographically verified the JWT. */
export type VerifiedTenantClaims = Readonly<{
  userId: string;
  legacyUserRole: LegacyUserRole;
  tenantId?: string;
  membershipId?: string;
  membershipVersion?: number;
  contextVersion?: number;
}>;

export interface TenantControlPlaneReader {
  findTenant(tenantId: string): Promise<TenantRecord | null>;
  findMembershipsForUser(userId: string): Promise<readonly MembershipRecord[]>;
}

export class TenantContextError extends Error {
  constructor(public readonly code: "TENANT_REQUIRED" | "TENANT_DENIED" | "TENANT_AMBIGUOUS" | "TENANT_CLAIM_INVALID") {
    super(code);
  }
}

export type TenantResolverOptions = Readonly<{
  legacyCompatibility: "disabled" | "default-only";
  defaultTenantId?: string;
  resolutionSourceOverride?: "synthetic_test";
}>;

const freezeContext = (tenant: TenantRecord, membership: MembershipRecord, claims: VerifiedTenantClaims, source: TenantResolutionSource): TenantContext =>
  Object.freeze({
    tenantId: tenant.id,
    ...(tenant.slug ? { tenantSlug: tenant.slug } : {}),
    userId: claims.userId,
    membershipId: membership.id,
    membershipStatus: "active" as const,
    membershipRole: membership.role,
    legacyUserRole: claims.legacyUserRole,
    resolutionSource: source,
    contextVersion: TENANT_CONTEXT_VERSION,
  });

/** Purely request-scoped resolver. HTTP header/body/query values are intentionally not inputs. */
export async function resolveTenantContext(
  claims: VerifiedTenantClaims,
  reader: TenantControlPlaneReader,
  options: TenantResolverOptions,
): Promise<TenantContext> {
  if (!claims.userId || !claims.legacyUserRole) throw new TenantContextError("TENANT_REQUIRED");
  const memberships = await reader.findMembershipsForUser(claims.userId);
  const active = memberships.filter((membership) => membership.status === "active" && membership.userId === claims.userId);

  if (claims.tenantId !== undefined) {
    if (!claims.membershipId || claims.contextVersion !== TENANT_CONTEXT_VERSION || !Number.isInteger(claims.membershipVersion)) {
      throw new TenantContextError("TENANT_CLAIM_INVALID");
    }
    const tenant = await reader.findTenant(claims.tenantId);
    const matches = active.filter((membership) => membership.tenantId === claims.tenantId && membership.id === claims.membershipId);
    if (tenant?.status !== "active" || matches.length !== 1 || matches[0].version !== claims.membershipVersion ||
        matches[0].role !== claims.legacyUserRole) {
      throw new TenantContextError("TENANT_DENIED");
    }
    return freezeContext(tenant, matches[0], claims, options.resolutionSourceOverride ?? "tenant_claim");
  }

  if (claims.membershipId !== undefined || claims.membershipVersion !== undefined || claims.contextVersion !== undefined) {
    throw new TenantContextError("TENANT_CLAIM_INVALID");
  }
  if (options.legacyCompatibility !== "default-only" || !options.defaultTenantId) {
    throw new TenantContextError("TENANT_REQUIRED");
  }
  if (active.length !== 1) throw new TenantContextError(active.length > 1 ? "TENANT_AMBIGUOUS" : "TENANT_DENIED");
  const membership = active.find((candidate) => candidate.tenantId === options.defaultTenantId);
  if (!membership) throw new TenantContextError("TENANT_DENIED");
  const tenant = await reader.findTenant(options.defaultTenantId);
  if (tenant?.status !== "active") throw new TenantContextError("TENANT_DENIED");
  return freezeContext(tenant, membership, claims, options.resolutionSourceOverride ?? "legacy_default_only");
}

/** Safe, deliberately small observability projection. */
export const sanitizeTenantContext = (context: TenantContext) => Object.freeze({
  tenantId: context.tenantId,
  membershipId: context.membershipId,
  membershipStatus: context.membershipStatus,
  resolutionSource: context.resolutionSource,
  contextVersion: context.contextVersion,
});
