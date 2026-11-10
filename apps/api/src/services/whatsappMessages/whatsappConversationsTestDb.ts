import type { PrismaClient } from "@prisma/client";

// Apoio dos testes da Fase B2 do WhatsApp (não é carregado pela aplicação): Prisma em memória para usuários,
// tenant, clientes, oportunidades (com itens e histórico de alterações), contatos, índice de telefones, conversas, mensagens e AppConfig, com um
// filtro "where" pequeno (igualdade, null, in, not, gte/gt/lt/lte, OR, relações por id). Só dados fictícios.

type Row = Record<string, any>;
type Relation = { model: string; resolve: (row: Row) => Row | null | undefined };

export function createWhatsAppConversationsTestDb(prisma: PrismaClient) {
  const tables: Record<string, Row[]> = {
    user: [
      { id: "director-a", name: "Diretor Ficticio", email: "director-a@test.invalid", role: "diretor", region: null, isActive: true },
      { id: "manager-a", name: "Gerente Ficticio", email: "manager-a@test.invalid", role: "gerente", region: null, isActive: true },
      { id: "seller-a", name: "Vendedor Ficticio A", email: "seller-a@test.invalid", role: "vendedor", region: null, isActive: true },
      { id: "seller-b", name: "Vendedor Ficticio B", email: "seller-b@test.invalid", role: "vendedor", region: null, isActive: true },
      { id: "seller-c", name: "Vendedor Ficticio C", email: "seller-c@test.invalid", role: "vendedor", region: null, isActive: true },
      { id: "seller-other-tenant", name: "Vendedor Ficticio Outro", email: "seller-x@test.invalid", role: "vendedor", region: null, isActive: true }
    ],
    client: [],
    opportunity: [],
    opportunityItem: [],
    opportunityChangeLog: [],
    contact: [],
    clientPhoneIndex: [],
    communicationConversation: [],
    communicationMessage: [],
    appConfig: [],
    whatsAppConnection: []
  };
  const tenantOf: Record<string, string> = { "seller-other-tenant": "tenant-b" };
  let sequence = 0;

  const byId = (model: string, id: unknown) => tables[model].find((row) => row.id === id) ?? null;
  const relations: Record<string, Record<string, Relation>> = {
    opportunity: { client: { model: "client", resolve: (row) => byId("client", row.clientId) } },
    contact: { client: { model: "client", resolve: (row) => byId("client", row.clientId) } },
    clientPhoneIndex: { client: { model: "client", resolve: (row) => byId("client", row.clientId) } },
    communicationConversation: {
      client: { model: "client", resolve: (row) => byId("client", row.clientId) },
      numberOwner: { model: "user", resolve: (row) => byId("user", row.numberOwnerUserId) }
    },
    communicationMessage: { conversation: { model: "communicationConversation", resolve: (row) => byId("communicationConversation", row.conversationId) } }
  };

  const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : value);
  const same = (a: unknown, b: unknown) => comparable(a) === comparable(b);
  const isOperator = (value: unknown) =>
    Boolean(value) && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value) &&
    Object.keys(value as Row).every((key) => ["equals", "not", "in", "notIn", "gte", "gt", "lt", "lte"].includes(key));

  const fieldMatches = (actual: unknown, filter: unknown): boolean => {
    if (filter === null) return actual === null || actual === undefined;
    if (!isOperator(filter)) return same(actual, filter);
    const ops = filter as Row;
    if ("equals" in ops && !same(actual, ops.equals)) return false;
    if ("not" in ops && (ops.not === null ? actual === null || actual === undefined : same(actual, ops.not))) return false;
    if ("in" in ops && !ops.in.some((item: unknown) => same(actual, item))) return false;
    if ("notIn" in ops && ops.notIn.some((item: unknown) => same(actual, item))) return false;
    const value = comparable(actual) as number;
    if (("gte" in ops || "gt" in ops || "lt" in ops || "lte" in ops) && (actual === null || actual === undefined)) return false;
    if ("gte" in ops && !(value >= (comparable(ops.gte) as number))) return false;
    if ("gt" in ops && !(value > (comparable(ops.gt) as number))) return false;
    if ("lt" in ops && !(value < (comparable(ops.lt) as number))) return false;
    if ("lte" in ops && !(value <= (comparable(ops.lte) as number))) return false;
    return true;
  };

  const matches = (model: string, row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, filter]) => {
      if (filter === undefined) return true;
      if (key === "OR") return (filter as Row[]).some((item) => matches(model, row, item));
      if (key === "AND") return (filter as Row[]).every((item) => matches(model, row, item));
      if (key === "NOT") return !matches(model, row, filter as Row);
      const relation = relations[model]?.[key];
      if (relation) {
        const target = relation.resolve(row);
        if (filter === null) return !target;
        return Boolean(target) && matches(relation.model, target!, filter as Row);
      }
      return fieldMatches(row[key], filter);
    });

  const project = (model: string, row: Row | null | undefined, select?: Row, include?: Row): Row | null => {
    if (!row) return null;
    if (!select && !include) return { ...row };
    const out: Row = select ? {} : { ...row };
    for (const [key, spec] of Object.entries(select ?? include ?? {})) {
      if (!spec) continue;
      if (key === "messages" && model === "communicationConversation") {
        out.messages = findMany("communicationMessage", { ...(spec as Row), where: { ...((spec as Row).where ?? {}), conversationId: row.id } });
        continue;
      }
      const relation = relations[model]?.[key];
      if (relation) out[key] = project(relation.model, relation.resolve(row), spec === true ? undefined : (spec as Row).select);
      else out[key] = row[key];
    }
    return out;
  };

  const sort = (rows: Row[], orderBy: Row | Row[] | undefined) => {
    const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    return [...rows].sort((a, b) => {
      for (const order of orders) {
        const [field, spec] = Object.entries(order)[0] as [string, "asc" | "desc" | { sort: "asc" | "desc" }];
        const direction = typeof spec === "string" ? spec : spec.sort;
        const x = comparable(a[field]) as any;
        const y = comparable(b[field]) as any;
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    });
  };

  function findMany(model: string, args: Row = {}) {
    let rows = sort(tables[model].filter((row) => matches(model, row, args.where)), args.orderBy);
    if (args.cursor) {
      const index = rows.findIndex((row) => row.id === args.cursor.id);
      rows = index < 0 ? [] : rows.slice(index);
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((row) => project(model, row, args.select, args.include)!);
  }

  const calls: Array<{ model: string; method: string; args: Row }> = [];
  const install = (model: string) => {
    const target = (prisma as any)[model];
    const log = (method: string, args: Row) => calls.push({ model, method, args });
    target.findMany = async (args: Row = {}) => (log("findMany", args), findMany(model, args));
    target.findFirst = async (args: Row = {}) => (log("findFirst", args), findMany(model, { ...args, take: 1 })[0] ?? null);
    target.findUnique = async (args: Row = {}) => (log("findUnique", args), findMany(model, { ...args, take: 1 })[0] ?? null);
    target.count = async (args: Row = {}) => (log("count", args), tables[model].filter((row) => matches(model, row, args.where)).length);
    target.create = async (args: Row) => {
      log("create", args);
      const now = new Date();
      const row = { id: `${model}-${++sequence}`, createdAt: now, updatedAt: now, ...args.data };
      tables[model].push(row);
      return project(model, row, args.select);
    };
    target.update = async (args: Row) => {
      log("update", args);
      const row = tables[model].find((item) => matches(model, item, args.where));
      if (!row) throw new Error("registro inexistente");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return project(model, row, args.select);
    };
    target.updateMany = async (args: Row) => {
      log("updateMany", args);
      const rows = tables[model].filter((row) => matches(model, row, args.where));
      for (const row of rows) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: rows.length };
    };
    target.deleteMany = async (args: Row = {}) => {
      log("deleteMany", args);
      const removed = tables[model].filter((row) => matches(model, row, args.where));
      tables[model] = tables[model].filter((row) => !removed.includes(row));
      // Cascata do banco: apagar a conversa apaga as mensagens dela.
      if (model === "communicationConversation") {
        const ids = new Set(removed.map((row) => row.id));
        tables.communicationMessage = tables.communicationMessage.filter((row) => !ids.has(row.conversationId));
      }
      return { count: removed.length };
    };
    target.upsert = async (args: Row) => {
      log("upsert", args);
      const existing = tables[model].find((row) => matches(model, row, args.where));
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return { ...existing };
      }
      return target.create({ data: args.create });
    };
  };
  for (const model of Object.keys(tables)) install(model);
  (prisma as any).tenantMembership.findMany = async ({ where }: Row) =>
    byId("user", where?.userId) ? [{ tenantId: tenantOf[where.userId] ?? "tenant-a" }] : [];
  (prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

  return { tables, calls };
}
