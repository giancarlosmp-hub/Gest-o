export type TenantRole = "diretor" | "gerente" | "vendedor";
export type PlatformRole = "platform_admin" | "platform_support" | "platform_operator";
export type TenantContextSource = "access_token" | "webhook_account" | "scheduler_job" | "platform_break_glass";

/** Original cross-channel tenancy contract. Kept stable for repositories, jobs and integrations. */
export type TenantContext = Readonly<{
  tenantId: string;
  userId: string;
  membershipId: string;
  tenantRole: TenantRole;
  platformRole?: PlatformRole;
  requestId: string;
  membershipVersion: number;
  source: TenantContextSource;
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

export type TrustedTenantPrincipal = Readonly<{
  tenantId: string;
  userId: string;
  membershipId: string;
  tenantRole: TenantRole;
  platformRole?: PlatformRole;
  membershipVersion: number;
}>;

export type TenantContextEvidence =
  | Readonly<{ source: "access_token"; principal: TrustedTenantPrincipal }>
  | Readonly<{ source: "webhook_account"; principal: TrustedTenantPrincipal; externalAccountId: string }>
  | Readonly<{ source: "scheduler_job"; principal: TrustedTenantPrincipal; jobId: string }>
  | Readonly<{ source: "platform_break_glass"; principal: TrustedTenantPrincipal; reason: string; auditId: string; expiresAt: Date }>;

export interface TenantControlPlaneReader {
  findTenant(tenantId: string): Promise<TenantRecord | null>;
  findMembership(membershipId: string): Promise<MembershipRecord | null>;
  findMembershipsForUser(userId: string): Promise<readonly MembershipRecord[]>;
}

export class TenantContextError extends Error {
  constructor(public readonly code: "TENANT_REQUIRED" | "TENANT_DENIED" | "BREAK_GLASS_DENIED" | "TENANT_AMBIGUOUS" | "TENANT_CLAIM_INVALID") {
    super(code);
  }
}

export type TenantContextFactoryOptions = Readonly<{ defaultTenantId: string; defaultOnly: boolean }>;

/** Original trusted-evidence resolver, including break-glass validation. */
export async function createTenantContext(
  evidence: TenantContextEvidence,
  requestId: string,
  reader: TenantControlPlaneReader,
  options: TenantContextFactoryOptions,
): Promise<TenantContext> {
  const principal = evidence.principal;
  if (!requestId || !principal.tenantId || !principal.userId || !principal.membershipId) throw new TenantContextError("TENANT_REQUIRED");
  if (options.defaultOnly && principal.tenantId !== options.defaultTenantId) throw new TenantContextError("TENANT_DENIED");
  if (evidence.source === "platform_break_glass" &&
      (!evidence.reason.trim() || !evidence.auditId || evidence.expiresAt.getTime() <= Date.now() || !principal.platformRole)) {
    throw new TenantContextError("BREAK_GLASS_DENIED");
  }
  const [tenant, membership] = await Promise.all([reader.findTenant(principal.tenantId), reader.findMembership(principal.membershipId)]);
  if (tenant?.status !== "active" || !membership || membership.status !== "active" || membership.tenantId !== principal.tenantId ||
      membership.userId !== principal.userId || membership.role !== principal.tenantRole || membership.version !== principal.membershipVersion) {
    throw new TenantContextError("TENANT_DENIED");
  }
  return Object.freeze({ ...principal, requestId, source: evidence.source });
}

export type LegacyUserRole = TenantRole;
export type TenantResolutionSource = "tenant_claim" | "active_membership" | "legacy_default_only" | "synthetic_test";
export const TENANT_CONTEXT_VERSION = 1 as const;

/** Auth-specific additive contract; it does not reinterpret the original TenantContext. */
export type AuthTenantContext = Readonly<{
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

/** Claims are accepted only after the caller has cryptographically verified the JWT. */
export type VerifiedTenantClaims = Readonly<{
  userId: string;
  legacyUserRole: LegacyUserRole;
  tenantId?: string;
  membershipId?: string;
  membershipVersion?: number;
  contextVersion?: number;
}>;

export type TenantResolverOptions = Readonly<{
  legacyCompatibility: "disabled" | "default-only";
  defaultTenantId?: string;
  resolutionSourceOverride?: "synthetic_test";
}>;

const freezeAuthContext = (tenant: TenantRecord, membership: MembershipRecord, claims: VerifiedTenantClaims, source: TenantResolutionSource): AuthTenantContext =>
  Object.freeze({ tenantId: tenant.id, ...(tenant.slug ? { tenantSlug: tenant.slug } : {}), userId: claims.userId,
    membershipId: membership.id, membershipStatus: "active" as const, membershipRole: membership.role,
    legacyUserRole: claims.legacyUserRole, resolutionSource: source, contextVersion: TENANT_CONTEXT_VERSION });

/** Auth-only request-scoped resolver. HTTP header/body/query values are intentionally not inputs. */
export async function resolveTenantContext(
  claims: VerifiedTenantClaims,
  reader: TenantControlPlaneReader,
  options: TenantResolverOptions,
): Promise<AuthTenantContext> {
  if (!claims.userId || !claims.legacyUserRole) throw new TenantContextError("TENANT_REQUIRED");
  const memberships = await reader.findMembershipsForUser(claims.userId);
  const active = memberships.filter((membership) => membership.status === "active" && membership.userId === claims.userId);
  if (claims.tenantId !== undefined) {
    if (!claims.membershipId || claims.contextVersion !== TENANT_CONTEXT_VERSION || !Number.isInteger(claims.membershipVersion)) throw new TenantContextError("TENANT_CLAIM_INVALID");
    const tenant = await reader.findTenant(claims.tenantId);
    const matches = active.filter((membership) => membership.tenantId === claims.tenantId && membership.id === claims.membershipId);
    if (tenant?.status !== "active" || matches.length !== 1 || matches[0].version !== claims.membershipVersion || matches[0].role !== claims.legacyUserRole) {
      throw new TenantContextError("TENANT_DENIED");
    }
    return freezeAuthContext(tenant, matches[0], claims, options.resolutionSourceOverride ?? "tenant_claim");
  }
  if (claims.membershipId !== undefined || claims.membershipVersion !== undefined || claims.contextVersion !== undefined) throw new TenantContextError("TENANT_CLAIM_INVALID");
  if (options.legacyCompatibility !== "default-only" || !options.defaultTenantId) throw new TenantContextError("TENANT_REQUIRED");
  if (active.length !== 1) throw new TenantContextError(active.length > 1 ? "TENANT_AMBIGUOUS" : "TENANT_DENIED");
  const membership = active.find((candidate) => candidate.tenantId === options.defaultTenantId);
  if (!membership) throw new TenantContextError("TENANT_DENIED");
  const tenant = await reader.findTenant(options.defaultTenantId);
  if (tenant?.status !== "active") throw new TenantContextError("TENANT_DENIED");
  return freezeAuthContext(tenant, membership, claims, options.resolutionSourceOverride ?? "legacy_default_only");
}

export const sanitizeTenantContext = (context: AuthTenantContext) => Object.freeze({ tenantId: context.tenantId,
  membershipId: context.membershipId, membershipStatus: context.membershipStatus,
  resolutionSource: context.resolutionSource, contextVersion: context.contextVersion });
