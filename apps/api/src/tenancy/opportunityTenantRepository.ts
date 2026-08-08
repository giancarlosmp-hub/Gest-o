import type { AuthTenantContext } from "./tenantContext.js";
import { TenantDataAccessError, tenantIdFromAuthContext } from "./tenantDataAccess.js";

type Row = { id: string; clientId: string; [key: string]: unknown };
type Create = { clientId: string; [key: string]: unknown };
type Update = { clientId?: never; [key: string]: unknown };
type Where = { id?: string; client: { tenantId: string } };

export type OpportunityTenantTransaction = {
  client: { findFirst(args: { where: { id: string; tenantId: string }; select: { id: true } }): Promise<{ id: string } | null> };
  opportunity: {
    findMany(args: { where: Where; orderBy: { createdAt: "desc" } }): Promise<Row[]>;
    findFirst(args: { where: Where }): Promise<Row | null>;
    create(args: { data: Create }): Promise<Row>;
    updateMany(args: { where: Where; data: Update | { clientId: string } }): Promise<{ count: number }>;
    deleteMany(args: { where: Where }): Promise<{ count: number }>;
    count(args: { where: Where }): Promise<number>;
    aggregate(args: { where: Where; _sum: { value: true }; _count: true }): Promise<unknown>;
  };
};

export type OpportunityTenantDelegate = {
  $transaction<T>(operation: (transaction: OpportunityTenantTransaction) => Promise<T>): Promise<T>;
};

const scope = (tenantId: string, id?: string): Where => ({ ...(id ? { id } : {}), client: { tenantId } });

/** Additive relational-ownership pilot; deliberately disconnected from runtime and Prisma singleton. */
export class OpportunityTenantRepository {
  constructor(private readonly database: OpportunityTenantDelegate) {}

  private async ownedClient(transaction: OpportunityTenantTransaction, tenantId: string, clientId: string): Promise<void> {
    const parent = await transaction.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!parent) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
  }

  list(context: AuthTenantContext): Promise<Row[]> {
    const tenantId = tenantIdFromAuthContext(context);
    return this.database.$transaction((tx) => tx.opportunity.findMany({ where: scope(tenantId), orderBy: { createdAt: "desc" } }));
  }

  findById(context: AuthTenantContext, id: string): Promise<Row | null> {
    const tenantId = tenantIdFromAuthContext(context);
    return this.database.$transaction((tx) => tx.opportunity.findFirst({ where: scope(tenantId, id) }));
  }

  create(context: AuthTenantContext, data: Create): Promise<Row> {
    const tenantId = tenantIdFromAuthContext(context);
    return this.database.$transaction(async (tx) => { await this.ownedClient(tx, tenantId, data.clientId); return tx.opportunity.create({ data }); });
  }

  updateById(context: AuthTenantContext, id: string, data: Update): Promise<boolean> {
    const tenantId = tenantIdFromAuthContext(context);
    if (Object.prototype.hasOwnProperty.call(data, "clientId")) throw new TenantDataAccessError("TENANT_OWNERSHIP_MISMATCH");
    return this.database.$transaction(async (tx) => (await tx.opportunity.updateMany({ where: scope(tenantId, id), data })).count === 1);
  }

  moveToClient(context: AuthTenantContext, id: string, clientId: string): Promise<boolean> {
    const tenantId = tenantIdFromAuthContext(context);
    return this.database.$transaction(async (tx) => { await this.ownedClient(tx, tenantId, clientId); return (await tx.opportunity.updateMany({ where: scope(tenantId, id), data: { clientId } })).count === 1; });
  }

  deleteById(context: AuthTenantContext, id: string): Promise<boolean> {
    const tenantId = tenantIdFromAuthContext(context);
    return this.database.$transaction(async (tx) => (await tx.opportunity.deleteMany({ where: scope(tenantId, id) })).count === 1);
  }

  count(context: AuthTenantContext): Promise<number> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.opportunity.count({ where: scope(tenantId) })); }
  aggregate(context: AuthTenantContext): Promise<unknown> { const tenantId = tenantIdFromAuthContext(context); return this.database.$transaction((tx) => tx.opportunity.aggregate({ where: scope(tenantId), _sum: { value: true }, _count: true })); }
}
