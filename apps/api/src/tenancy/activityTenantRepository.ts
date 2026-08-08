import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError, tenantIdFromAuthContext } from "./tenantDataAccess.js";

export type ActivityLinks = { clientId: string | null; opportunityId: string | null };
type Row = ActivityLinks & { id: string; [key: string]: unknown };
type Create = ActivityLinks & { [key: string]: unknown };
type Update = { clientId?: never; opportunityId?: never; [key: string]: unknown };
type Scope = { id?: string; AND: Array<Record<string, unknown>> };
export type ActivityTenantTransaction = {
  client: { findFirst(args: { where: { id: string; tenantId: string }; select: { id: true } }): Promise<{ id: string } | null> };
  opportunity: { findFirst(args: { where: { id: string; client: { tenantId: string } }; select: { id: true; clientId: true } }): Promise<{ id: string; clientId: string } | null> };
  activity: {
    findMany(args: { where: Scope; orderBy: { createdAt: "desc" } }): Promise<Row[]>;
    findFirst(args: { where: Scope; select?: { clientId: true; opportunityId: true } }): Promise<Row | ActivityLinks | null>;
    create(args: { data: Create }): Promise<Row>;
    updateMany(args: { where: Scope; data: Update | ActivityLinks }): Promise<{ count: number }>;
    deleteMany(args: { where: Scope }): Promise<{ count: number }>;
    count(args: { where: Scope }): Promise<number>;
    aggregate(args: { where: Scope; _count: true; _sum: { duration: true } }): Promise<unknown>;
  };
};
export type ActivityTenantDelegate = { $transaction<T>(operation: (transaction: ActivityTenantTransaction) => Promise<T>): Promise<T> };

// At least one parent must prove ownership; every present parent must independently prove the same tenant.
const scope = (tenantId: string, id?: string): Scope => ({ ...(id ? { id } : {}), AND: [
  { OR: [{ client: { tenantId } }, { opportunity: { client: { tenantId } } }] },
  { OR: [{ clientId: null }, { client: { tenantId } }] },
  { OR: [{ opportunityId: null }, { opportunity: { client: { tenantId } } }] },
] });

/** Additive relational-ownership pilot; seller/user is never treated as tenant ownership. */
export class ActivityTenantRepository {
  constructor(private readonly database: ActivityTenantDelegate) {}

  private async authorizeLinks(tx: ActivityTenantTransaction, tenantId: string, links: ActivityLinks): Promise<void> {
    if (!links.clientId && !links.opportunityId) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    const client = links.clientId ? await tx.client.findFirst({ where: { id: links.clientId, tenantId }, select: { id: true } }) : null;
    const opportunity = links.opportunityId ? await tx.opportunity.findFirst({ where: { id: links.opportunityId, client: { tenantId } }, select: { id: true, clientId: true } }) : null;
    if ((links.clientId && !client) || (links.opportunityId && !opportunity) || (client && opportunity && opportunity.clientId !== client.id)) {
      throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    }
  }

  list(context: AuthTenantContext): Promise<Row[]> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.activity.findMany({ where: scope(tenantId), orderBy: { createdAt: "desc" } })); }
  findById(context: AuthTenantContext, id: string): Promise<Row | ActivityLinks | null> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.activity.findFirst({ where: scope(tenantId, id) })); }
  create(context: AuthTenantContext, data: Create): Promise<Row> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => { await this.authorizeLinks(tx, tenantId, data); return tx.activity.create({ data }); }); }
  updateById(context: AuthTenantContext, id: string, data: Update): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); if (Object.prototype.hasOwnProperty.call(data, "clientId") || Object.prototype.hasOwnProperty.call(data, "opportunityId")) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH"); return this.database.$transaction(async (tx) => (await tx.activity.updateMany({ where: scope(tenantId, id), data })).count === 1); }
  relink(context: AuthTenantContext, id: string, links: ActivityLinks): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => { await this.authorizeLinks(tx, tenantId, links); return (await tx.activity.updateMany({ where: scope(tenantId, id), data: links })).count === 1; }); }
  deleteById(context: AuthTenantContext, id: string): Promise<boolean> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction(async (tx) => (await tx.activity.deleteMany({ where: scope(tenantId, id) })).count === 1); }
  count(context: AuthTenantContext): Promise<number> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.activity.count({ where: scope(tenantId) })); }
  aggregate(context: AuthTenantContext): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.activity.aggregate({ where: scope(tenantId), _count: true, _sum: { duration: true } })); }
}
