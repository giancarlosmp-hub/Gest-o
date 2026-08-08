import type { TenantContext } from "./tenantContext.js";

export interface TenantRepository<T> {
  findById(context: TenantContext, id: string): Promise<T | null>;
  save(context: TenantContext, value: T): Promise<T>;
}

export interface PlatformAdministration {
  executeBreakGlass(input: Readonly<{ auditId: string; reason: string; expiresAt: Date }>): Promise<void>;
}

export type TenantJobEnvelope<T> = Readonly<{ tenantId: string; jobId: string; payload: T }>;

export const tenantCacheKey = (context: TenantContext, area: string, key: string) =>
  `tenant:${context.tenantId}:${area}:${key}`;

const SAFE_LOG_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const tenantLogFields = (context: TenantContext) => {
  if (!SAFE_LOG_ID.test(context.tenantId) || !SAFE_LOG_ID.test(context.requestId)) throw new Error("UNSAFE_TENANT_LOG_CONTEXT");
  return Object.freeze({ tenantId: context.tenantId, requestId: context.requestId });
};

export type ResolvedWebhook = Readonly<{ tenantId: string; externalAccountId: string }>;
export interface WebhookTenantResolver {
  resolveVerifiedAccount(externalAccountId: string): Promise<ResolvedWebhook | null>;
}

export type AuditedTenantSql = Readonly<{
  name: `tenant_${string}`;
  text: string;
  tenantIdParameter: number;
  auditEvent: string;
}>;

export const defineAuditedTenantSql = (definition: AuditedTenantSql) => Object.freeze(definition);
