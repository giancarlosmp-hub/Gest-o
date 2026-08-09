import type { AuthTenantContext, TenantControlPlaneReader } from "./tenantContext.js";
import { resolveTenantContext } from "./tenantContext.js";
import { ClientTenantRepository, type ClientTenantDelegate } from "./clientTenantRepository.js";

export type TenantReadPilotConfig = Readonly<{
  tenancyMode: "disabled" | "default-only";
  enabled: boolean;
  deploymentEnvironment: "test" | "preview" | "production" | "other";
  defaultTenantId: string;
}>;

export function validateTenantReadPilotConfig(input: Readonly<Record<string, string | undefined>>): TenantReadPilotConfig {
  const tenancyMode = input.TENANCY_MODE === "default-only" ? "default-only" : input.TENANCY_MODE === "disabled" ? "disabled" : null;
  if (!tenancyMode) throw new Error("TENANCY_MODE must be explicitly disabled or default-only");
  const enabled = input.TENANT_READ_PILOT_ENABLED === "true";
  const deploymentEnvironment = input.DEPLOYMENT_ENV === "preview" || input.NODE_ENV === "test"
    ? (input.NODE_ENV === "test" ? "test" : "preview")
    : input.NODE_ENV === "production" ? "production" : "other";
  if (enabled && (tenancyMode !== "default-only" || !["test", "preview"].includes(deploymentEnvironment))) {
    throw new Error("TENANT_READ_PILOT_UNSAFE_CONFIGURATION");
  }
  const defaultTenantId = input.DEFAULT_TENANT_ID?.trim() || "";
  if (enabled && !defaultTenantId) throw new Error("TENANT_READ_PILOT_DEFAULT_TENANT_REQUIRED");
  return Object.freeze({ tenancyMode, enabled, deploymentEnvironment, defaultTenantId });
}

export const tenantReadPilotConfig = validateTenantReadPilotConfig({ ...process.env, TENANCY_MODE: process.env.TENANCY_MODE ?? "disabled" });
export const isTenantReadPilotActive = (config = tenantReadPilotConfig) => config.tenancyMode === "default-only" && config.enabled;

export type TenantReadPilotEvent = Readonly<{
  requestId: string;
  tenantId: string;
  resolutionSource: AuthTenantContext["resolutionSource"];
  contextVersion: AuthTenantContext["contextVersion"];
  pilotMode: "shadow";
  legacyCount: number;
  tenantScopedCount: number;
  result: "MATCH" | "MISMATCH";
  durationMs: number;
}>;

/** Stable, single-line evidence for automation; deliberately contains only approved technical metadata. */
export function formatTenantReadPilotMarker(event: TenantReadPilotEvent): string {
  return `TENANT_READ_SHADOW_EVENT=${JSON.stringify({
    requestId: event.requestId,
    tenantId: event.tenantId,
    contextVersion: event.contextVersion,
    resolutionSource: event.resolutionSource,
    legacyCount: event.legacyCount,
    tenantScopedCount: event.tenantScopedCount,
    result: event.result,
    durationMs: event.durationMs,
  })}`;
}

/** Dependencies are request-local and explicit; no HTTP tenant input or ambient context exists. */
export async function runClientListShadowPilot(args: {
  config: TenantReadPilotConfig;
  verifiedUser: Readonly<{ id: string; role: "diretor" | "gerente" | "vendedor" }>;
  requestId: string;
  functionalWhere: Readonly<Record<string, unknown>>;
  legacyCount: number;
  reader: TenantControlPlaneReader;
  clientDelegate: ClientTenantDelegate;
  observe(event: TenantReadPilotEvent): void;
}): Promise<TenantReadPilotEvent | null> {
  if (!isTenantReadPilotActive(args.config)) return null;
  const startedAt = Date.now();
  const context = await resolveTenantContext(
    { userId: args.verifiedUser.id, legacyUserRole: args.verifiedUser.role },
    args.reader,
    { legacyCompatibility: "default-only", defaultTenantId: args.config.defaultTenantId },
  );
  const tenantScopedCount = await new ClientTenantRepository(args.clientDelegate).countMatching(context, args.functionalWhere);
  const event: TenantReadPilotEvent = Object.freeze({ requestId: args.requestId, tenantId: context.tenantId,
    resolutionSource: context.resolutionSource, contextVersion: context.contextVersion, pilotMode: "shadow",
    legacyCount: args.legacyCount, tenantScopedCount, result: args.legacyCount === tenantScopedCount ? "MATCH" : "MISMATCH",
    durationMs: Math.max(0, Date.now() - startedAt) });
  args.observe(event);
  return event;
}
