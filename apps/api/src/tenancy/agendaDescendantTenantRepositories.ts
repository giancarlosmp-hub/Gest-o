import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError, tenantIdFromAuthContext } from "./tenantDataAccess.js";

type AgendaScope = { OR: Array<Record<string, unknown>> };
type DescendantScope = { id?: string; agendaEventId?: string; agendaEvent: AgendaScope; clientId?: unknown; client?: { tenantId: string }; AND?: unknown[]; opportunityId?: unknown };
type Row = { id: string; agendaEventId: string | null; clientId?: string | null; opportunityId?: string | null; [key: string]: unknown };
type Model = {
  findMany(args: { where: DescendantScope; orderBy: { createdAt: "desc" } }): Promise<Row[]>;
  findFirst(args: { where: DescendantScope }): Promise<Row | null>;
  create(args: { data: Record<string, unknown> }): Promise<Row>;
  updateMany(args: { where: DescendantScope; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: DescendantScope }): Promise<{ count: number }>;
  count(args: { where: DescendantScope }): Promise<number>;
  aggregate(args: { where: DescendantScope; _count: true }): Promise<unknown>;
  groupBy(args: { where: DescendantScope; by: readonly string[]; _count: true }): Promise<unknown>;
};
export type AgendaDescendantTransaction = {
  agendaEvent: { findFirst(args: { where: { id: string } & AgendaScope; select: { id: true } }): Promise<{ id: string } | null> };
  client: { findFirst(args: { where: { id: string; tenantId: string }; select: { id: true } }): Promise<{ id: string } | null> };
  agendaStop: Model;
  activity: Model;
};
export type AgendaDescendantDelegate = { $transaction<T>(operation: (tx: AgendaDescendantTransaction) => Promise<T>): Promise<T> };

// Keep this identical in meaning to the 1.0B.2-G XOR policy: an Agenda has exactly one root.
const agendaScope = (tenantId: string): AgendaScope => ({ OR: [
  { tenantId, clientId: null, opportunityId: null },
  { tenantId: null, clientId: { not: null }, opportunityId: null, client: { tenantId } },
  { tenantId: null, clientId: null, opportunityId: { not: null }, opportunity: { client: { tenantId } } },
] });
const stopScope = (tenantId: string, id?: string, agendaEventId?: string): DescendantScope => ({
  ...(id ? { id } : {}), ...(agendaEventId ? { agendaEventId } : {}), agendaEvent: agendaScope(tenantId),
  // Client is not an authority, but when present must independently belong to the same tenant.
  AND: [{ OR: [{ clientId: null }, { clientId: { not: null }, client: { tenantId } }] }],
});
const activityScope = (tenantId: string, id?: string, agendaEventId?: string): DescendantScope => ({
  ...(id ? { id } : {}), ...(agendaEventId ? { agendaEventId } : {}), agendaEvent: agendaScope(tenantId),
  clientId: null, opportunityId: null,
});

abstract class AgendaDescendantRepository {
  constructor(protected readonly database: AgendaDescendantDelegate) {}
  protected abstract model(tx: AgendaDescendantTransaction): Model;
  protected abstract where(tenantId: string, id?: string, agendaEventId?: string): DescendantScope;
  protected abstract validateExtra(tx: AgendaDescendantTransaction, tenantId: string, data: Record<string, unknown>): Promise<void>;
  private async authorizeAgenda(tx: AgendaDescendantTransaction, tenantId: string, agendaEventId: unknown): Promise<string> {
    if (typeof agendaEventId !== "string" || !agendaEventId || !await tx.agendaEvent.findFirst({ where: { id: agendaEventId, ...agendaScope(tenantId) }, select: { id: true } })) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    return agendaEventId;
  }
  list(context: AuthTenantContext): Promise<Row[]> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).findMany({ where: this.where(tenantId), orderBy: { createdAt: "desc" } })); }
  findById(context: AuthTenantContext, id: string): Promise<Row | null> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).findFirst({ where: this.where(tenantId, id) })); }
  create(context: AuthTenantContext, data: Record<string, unknown>): Promise<Row> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => { const agendaEventId = await this.authorizeAgenda(tx, tenantId, data.agendaEventId); await this.validateExtra(tx, tenantId, data); return this.model(tx).create({ data: { ...data, agendaEventId } }); }); }
  updateById(context: AuthTenantContext, id: string, data: Record<string, unknown>): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); for (const key of ["agendaEventId", "clientId", "opportunityId"]) if (Object.prototype.hasOwnProperty.call(data, key)) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH"); return this.database.$transaction(async (tx) => (await this.model(tx).updateMany({ where: this.where(tenantId, id), data })).count === 1); }
  relink(context: AuthTenantContext, id: string, agendaEventId: string): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => (await this.model(tx).updateMany({ where: this.where(tenantId, id), data: { agendaEventId: await this.authorizeAgenda(tx, tenantId, agendaEventId) } })).count === 1); }
  deleteById(context: AuthTenantContext, id: string): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => (await this.model(tx).deleteMany({ where: this.where(tenantId, id) })).count === 1); }
  count(context: AuthTenantContext): Promise<number> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).count({ where: this.where(tenantId) })); }
  aggregate(context: AuthTenantContext): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).aggregate({ where: this.where(tenantId), _count: true })); }
  groupBy(context: AuthTenantContext, by: readonly string[]): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).groupBy({ where: this.where(tenantId), by, _count: true })); }
  // Includes are intentionally absent: neither direction is independently authorized.
}

export class AgendaStopTenantRepository extends AgendaDescendantRepository {
  protected model(tx: AgendaDescendantTransaction): Model { return tx.agendaStop; }
  protected where(tenantId: string, id?: string, agendaEventId?: string): DescendantScope { return stopScope(tenantId, id, agendaEventId); }
  protected async validateExtra(tx: AgendaDescendantTransaction, tenantId: string, data: Record<string, unknown>): Promise<void> { const clientId = data.clientId ?? null; if (clientId !== null && (typeof clientId !== "string" || !await tx.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } }))) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH"); }
}

/** Deliberately narrow channel: Activity must have Agenda as its only relational parent. */
export class AgendaActivityTenantRepository extends AgendaDescendantRepository {
  protected model(tx: AgendaDescendantTransaction): Model { return tx.activity; }
  protected where(tenantId: string, id?: string, agendaEventId?: string): DescendantScope { return activityScope(tenantId, id, agendaEventId); }
  protected async validateExtra(_tx: AgendaDescendantTransaction, _tenantId: string, data: Record<string, unknown>): Promise<void> { if ((data.clientId ?? null) !== null || (data.opportunityId ?? null) !== null) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH"); }
}
