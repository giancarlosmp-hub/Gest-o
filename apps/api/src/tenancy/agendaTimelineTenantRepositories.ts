import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError, tenantIdFromAuthContext } from "./tenantDataAccess.js";

type Links = { tenantId?: string | null; clientId: string | null; opportunityId: string | null };
type Row = Links & { id: string; [key: string]: unknown };
type SafeUpdate = { tenantId?: never; clientId?: never; opportunityId?: never; [key: string]: unknown };
type Scope = { id?: string; OR: Array<Record<string, unknown>> };
type ModelDelegate = {
  findMany(args: { where: Scope; orderBy: { createdAt: "desc" } }): Promise<Row[]>;
  findFirst(args: { where: Scope }): Promise<Row | null>;
  create(args: { data: Record<string, unknown> }): Promise<Row>;
  updateMany(args: { where: Scope; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Scope }): Promise<{ count: number }>;
  count(args: { where: Scope }): Promise<number>;
  aggregate(args: { where: Scope; _count: true }): Promise<unknown>;
  groupBy(args: { where: Scope; by: readonly string[]; _count: true }): Promise<unknown>;
};
export type AgendaTimelineTransaction = {
  client: { findFirst(args: { where: { id: string; tenantId: string }; select: { id: true } }): Promise<{ id: string } | null> };
  opportunity: { findFirst(args: { where: { id: string; client: { tenantId: string } }; select: { id: true } }): Promise<{ id: string } | null> };
  agendaEvent: ModelDelegate;
  timelineEvent: ModelDelegate;
};
export type AgendaTimelineDelegate = { $transaction<T>(operation: (tx: AgendaTimelineTransaction) => Promise<T>): Promise<T> };

// Prisma cannot compare sibling foreign keys. Exactly one ownership source is therefore accepted;
// multi-parent rows (even apparently convergent ones) fail closed rather than choosing a parent.
const agendaScope = (tenantId: string, id?: string): Scope => ({ ...(id ? { id } : {}), OR: [
  { tenantId, clientId: null, opportunityId: null },
  { tenantId: null, clientId: { not: null }, opportunityId: null, client: { tenantId } },
  { tenantId: null, clientId: null, opportunityId: { not: null }, opportunity: { client: { tenantId } } },
] });
const timelineScope = (tenantId: string, id?: string): Scope => ({ ...(id ? { id } : {}), OR: [
  { clientId: { not: null }, opportunityId: null, client: { tenantId } },
  { clientId: null, opportunityId: { not: null }, opportunity: { client: { tenantId } } },
] });

abstract class ScopedRepository {
  constructor(protected readonly database: AgendaTimelineDelegate) {}
  protected abstract model(tx: AgendaTimelineTransaction): ModelDelegate;
  protected abstract where(tenantId: string, id?: string): Scope;
  protected abstract normalizeLinks(data: Links): Links;

  private async authorize(tx: AgendaTimelineTransaction, tenantId: string, supplied: Links): Promise<Links> {
    const links = this.normalizeLinks(supplied);
    const sources = [links.tenantId, links.clientId, links.opportunityId].filter((value) => typeof value === "string" && value.length > 0);
    if (sources.length !== 1) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    if (links.tenantId && links.tenantId !== tenantId) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    if (links.clientId && !await tx.client.findFirst({ where: { id: links.clientId, tenantId }, select: { id: true } })) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    if (links.opportunityId && !await tx.opportunity.findFirst({ where: { id: links.opportunityId, client: { tenantId } }, select: { id: true } })) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    return links;
  }

  list(context: AuthTenantContext): Promise<Row[]> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).findMany({ where: this.where(tenantId), orderBy: { createdAt: "desc" } })); }
  findById(context: AuthTenantContext, id: string): Promise<Row | null> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).findFirst({ where: this.where(tenantId, id) })); }
  create(context: AuthTenantContext, data: Links & Record<string, unknown>): Promise<Row> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => this.model(tx).create({ data: { ...data, ...await this.authorize(tx, tenantId, data) } })); }
  updateById(context: AuthTenantContext, id: string, data: SafeUpdate): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); for (const key of ["tenantId", "clientId", "opportunityId"]) if (Object.prototype.hasOwnProperty.call(data, key)) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH"); return this.database.$transaction(async (tx) => (await this.model(tx).updateMany({ where: this.where(tenantId, id), data })).count === 1); }
  relink(context: AuthTenantContext, id: string, links: Links): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => (await this.model(tx).updateMany({ where: this.where(tenantId, id), data: await this.authorize(tx, tenantId, links) })).count === 1); }
  deleteById(context: AuthTenantContext, id: string): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => (await this.model(tx).deleteMany({ where: this.where(tenantId, id) })).count === 1); }
  count(context: AuthTenantContext): Promise<number> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).count({ where: this.where(tenantId) })); }
  aggregate(context: AuthTenantContext): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).aggregate({ where: this.where(tenantId), _count: true })); }
  groupBy(context: AuthTenantContext, by: readonly string[]): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => this.model(tx).groupBy({ where: this.where(tenantId), by, _count: true })); }
  // Includes are intentionally absent: root scoping does not authorize independent descendants.
}

export class AgendaEventTenantRepository extends ScopedRepository {
  protected model(tx: AgendaTimelineTransaction): ModelDelegate { return tx.agendaEvent; }
  protected where(tenantId: string, id?: string): Scope { return agendaScope(tenantId, id); }
  protected normalizeLinks(data: Links): Links { return { tenantId: data.tenantId ?? null, clientId: data.clientId ?? null, opportunityId: data.opportunityId ?? null }; }
}
export class TimelineEventTenantRepository extends ScopedRepository {
  protected model(tx: AgendaTimelineTransaction): ModelDelegate { return tx.timelineEvent; }
  protected where(tenantId: string, id?: string): Scope { return timelineScope(tenantId, id); }
  protected normalizeLinks(data: Links): Links {
    if (Object.prototype.hasOwnProperty.call(data, "tenantId")) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    return { clientId: data.clientId ?? null, opportunityId: data.opportunityId ?? null };
  }
}
