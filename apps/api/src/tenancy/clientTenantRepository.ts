import type { AuthTenantContext } from "./tenantContext.js";
import { assertTenantOwnership, rejectTenantOwnershipMutation, tenantIdFromAuthContext } from "./tenantDataAccess.js";

type ClientRow = { id: string; tenantId: string | null; name: string; [key: string]: unknown };
type ClientCreate = { name: string; tenantId?: string; [key: string]: unknown };
type ClientUpdate = Partial<Omit<ClientCreate, "tenantId">> & { tenantId?: never };
type ScopedWhere = { id?: string; tenantId: string; [key: string]: unknown };

export type ClientTenantDelegate = {
  findMany(args: { where: ScopedWhere; orderBy?: { createdAt: "asc" | "desc" } }): Promise<ClientRow[]>;
  findFirst(args: { where: ScopedWhere }): Promise<ClientRow | null>;
  create(args: { data: ClientCreate & { tenantId: string } }): Promise<ClientRow>;
  updateMany(args: { where: ScopedWhere; data: ClientUpdate }): Promise<{ count: number }>;
  deleteMany(args: { where: ScopedWhere }): Promise<{ count: number }>;
  count(args: { where: ScopedWhere }): Promise<number>;
};

/** Additive pilot only: intentionally not wired to HTTP handlers or the global Prisma singleton. */
export class ClientTenantRepository {
  constructor(private readonly client: ClientTenantDelegate) {}

  list(context: AuthTenantContext): Promise<ClientRow[]> {
    return this.client.findMany({ where: { tenantId: tenantIdFromAuthContext(context) }, orderBy: { createdAt: "desc" } });
  }

  findById(context: AuthTenantContext, id: string): Promise<ClientRow | null> {
    return this.client.findFirst({ where: { id, tenantId: tenantIdFromAuthContext(context) } });
  }

  create(context: AuthTenantContext, data: ClientCreate): Promise<ClientRow> {
    const tenantId = assertTenantOwnership(context, data.tenantId);
    return this.client.create({ data: { ...data, tenantId } });
  }

  async updateById(context: AuthTenantContext, id: string, data: ClientUpdate): Promise<boolean> {
    rejectTenantOwnershipMutation(data);
    const result = await this.client.updateMany({ where: { id, tenantId: tenantIdFromAuthContext(context) }, data });
    return result.count === 1;
  }

  async deleteById(context: AuthTenantContext, id: string): Promise<boolean> {
    const result = await this.client.deleteMany({ where: { id, tenantId: tenantIdFromAuthContext(context) } });
    return result.count === 1;
  }

  count(context: AuthTenantContext): Promise<number> {
    return this.client.count({ where: { tenantId: tenantIdFromAuthContext(context) } });
  }

  /** Read-only shadow primitive. Functional/RBAC filters are retained and tenant always wins. */
  countMatching(context: AuthTenantContext, functionalWhere: Readonly<Record<string, unknown>>): Promise<number> {
    return this.client.count({ where: { ...functionalWhere, tenantId: tenantIdFromAuthContext(context) } });
  }
}
