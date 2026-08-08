import { TENANT_CONTEXT_VERSION, TenantContextError, type AuthTenantContext } from "./tenantContext.js";

export class TenantDataAccessError extends TenantContextError {
  constructor(public readonly dataAccessCode: "TENANT_CONTEXT_INVALID" | "TENANT_OWNERSHIP_MISMATCH") {
    super(dataAccessCode === "TENANT_CONTEXT_INVALID" ? "TENANT_REQUIRED" : "TENANT_DENIED");
    this.name = "TenantDataAccessError";
  }
}

/** Validates an already resolved auth context at every data-access entry point. */
export function tenantIdFromAuthContext(context: AuthTenantContext | null | undefined): string {
  if (!context || typeof context !== "object" || typeof context.tenantId !== "string" || !context.tenantId.trim()
    || typeof context.userId !== "string" || !context.userId || typeof context.membershipId !== "string" || !context.membershipId
    || context.membershipStatus !== "active" || context.contextVersion !== TENANT_CONTEXT_VERSION) {
    throw new TenantDataAccessError("TENANT_CONTEXT_INVALID");
  }
  return context.tenantId;
}

export function assertTenantOwnership(context: AuthTenantContext, suppliedTenantId: unknown): string {
  const tenantId = tenantIdFromAuthContext(context);
  if (suppliedTenantId !== undefined && suppliedTenantId !== tenantId) {
    throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
  }
  return tenantId;
}

export function rejectTenantOwnershipMutation(data: object): void {
  if (Object.prototype.hasOwnProperty.call(data, "tenantId")) {
    throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
  }
}
