export type TenantRole = "diretor" | "gerente" | "vendedor";
export type PlatformRole = "platform_admin" | "platform_support" | "platform_operator";
export type TenantContextSource = "access_token" | "webhook_account" | "scheduler_job" | "platform_break_glass";

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

export type TenantRecord = Readonly<{ id: string; status: "active" | "suspended" | "archived" }>;
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
}

export class TenantContextError extends Error {
  constructor(public readonly code: "TENANT_REQUIRED" | "TENANT_DENIED" | "BREAK_GLASS_DENIED") {
    super(code);
  }
}

export type TenantContextFactoryOptions = Readonly<{ defaultTenantId: string; defaultOnly: boolean }>;

/** Accepts trusted evidence only. HTTP body, query and arbitrary headers are deliberately absent. */
export async function createTenantContext(
  evidence: TenantContextEvidence,
  requestId: string,
  reader: TenantControlPlaneReader,
  options: TenantContextFactoryOptions
): Promise<TenantContext> {
  const principal = evidence.principal;
  if (!requestId || !principal.tenantId || !principal.userId || !principal.membershipId) {
    throw new TenantContextError("TENANT_REQUIRED");
  }
  if (options.defaultOnly && principal.tenantId !== options.defaultTenantId) {
    throw new TenantContextError("TENANT_DENIED");
  }
  if (evidence.source === "platform_break_glass" &&
      (!evidence.reason.trim() || !evidence.auditId || evidence.expiresAt.getTime() <= Date.now() || !principal.platformRole)) {
    throw new TenantContextError("BREAK_GLASS_DENIED");
  }

  const [tenant, membership] = await Promise.all([
    reader.findTenant(principal.tenantId),
    reader.findMembership(principal.membershipId)
  ]);
  if (tenant?.status !== "active" || !membership || membership.status !== "active" ||
      membership.tenantId !== principal.tenantId || membership.userId !== principal.userId ||
      membership.role !== principal.tenantRole || membership.version !== principal.membershipVersion) {
    throw new TenantContextError("TENANT_DENIED");
  }

  return Object.freeze({ ...principal, requestId, source: evidence.source });
}
