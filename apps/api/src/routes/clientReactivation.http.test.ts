import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import {
  ARCHIVED_DUPLICATE_REACTIVATION_MESSAGE,
  PORTFOLIO_CLEANUP_MANUAL_REACTIVATION_AUDIT_ORIGIN,
  buildPortfolioCleanupArchiveReason,
} from "../services/portfolioCleanupArchive.js";

// Dados fictícios: POST /clients/:id/reactivate e o filtro "Mostrar arquivados" de GET /clients.
type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; name: string }> = {
  "seller-a": { role: "vendedor", name: "Vendedor Ficticio" },
  "manager-a": { role: "gerente", name: "Gerente Ficticio" },
  "director-a": { role: "diretor", name: "Diretor Ficticio" },
};
const archivedAt = new Date("2026-10-01T12:00:00.000Z");
const clients: Row[] = [
  { id: "client-ativo", code: "90001", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-limpeza-1", code: "90002", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: buildPortfolioCleanupArchiveReason(archivedAt) },
  { id: "client-limpeza-2", code: "90003", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: buildPortfolioCleanupArchiveReason(archivedAt) },
  { id: "client-fundido", code: "90004__MERGED__1", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: "MERGED_INTO:client-ativo" },
  { id: "client-legado", code: "90005", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: "legacy_duplicate_cleanup" },
  { id: "client-fusao-manual", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: "manual_duplicate_merge" },
];
const createdEvents: Row[] = [];
const createdAudits: Row[] = [];
const listWheres: Row[] = [];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const sameRow = (row: Row, where: Row) => Object.entries(where).every(([key, value]) => row[key] === value);
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: users[where.id].name, role: users[where.id].role, isActive: true } : null),
  findMany: async () => Object.entries(users).map(([id, user]) => ({ id, name: user.name, email: `${id}@test.invalid`, role: user.role, isActive: true })),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => {
    const row = clients.find((client) => client.id === where?.id);
    return row ? pick(row, select) : null;
  },
  findUnique: async ({ where, select }: any) => {
    const row = clients.find((client) => client.id === where.id);
    return row ? pick(row, select) : null;
  },
  updateMany: async ({ where, data }: any) => {
    const matched = clients.filter((row) => sameRow(row, where));
    matched.forEach((row) => Object.assign(row, data));
    return { count: matched.length };
  },
  findMany: async ({ where }: any) => {
    listWheres.push(where);
    return clients.filter((row) => where.isArchived === undefined || row.isArchived === where.isArchived).map((row) => ({ ...row, ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio" } }));
  },
  count: async ({ where }: any) => clients.filter((row) => where.isArchived === undefined || row.isArchived === where.isArchived).length,
});
setModel("erpOrderSync", { findMany: async () => [] }); // selo da situação na lista
setModel("timelineEvent", { create: async ({ data }: any) => { createdEvents.push(data); return data; } });
setModel("clientCodeAudit", { create: async ({ data }: any) => { createdAudits.push(data); return data; } });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const request = async (userId: string, method: string, path: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`, "content-type": "application/json" },
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};
const reactivate = (userId: string, clientId: string) => request(userId, "POST", `/clients/${clientId}/reactivate`);
const snapshot = () => JSON.stringify(clients);

try {
  // Vendedor: 403 e nada gravado, nem para o cliente da própria carteira.
  const before = snapshot();
  const forbidden = await reactivate("seller-a", "client-limpeza-1");
  assert.equal(forbidden.status, 403, "vendedor não reativa");
  assert.equal(snapshot(), before);

  // Duplicados arquivados: 409 com a mensagem do cliente principal, nada gravado.
  for (const id of ["client-fundido", "client-legado", "client-fusao-manual"]) {
    const duplicate = await reactivate("manager-a", id);
    assert.equal(duplicate.status, 409, `${id}: duplicado`);
    assert.equal(duplicate.json?.message, ARCHIVED_DUPLICATE_REACTIVATION_MESSAGE);
  }
  assert.equal(snapshot(), before, "duplicado não muda");

  // Cliente ativo: 409; inexistente: 404.
  assert.equal((await reactivate("manager-a", "client-ativo")).status, 409);
  assert.equal((await reactivate("manager-a", "client-inexistente")).status, 404);
  assert.equal(createdEvents.length + createdAudits.length, 0, "recusas não gravam timeline nem auditoria");

  // Gerente e diretor reativam cliente da limpeza: estado, timeline e auditoria com o usuário.
  for (const [userId, clientId] of [["manager-a", "client-limpeza-1"], ["director-a", "client-limpeza-2"]] as const) {
    const ok = await reactivate(userId, clientId);
    assert.equal(ok.status, 200, `${userId} reativa`);
    assert.equal(ok.json?.isArchived, false);
    assert.equal(ok.json?.archiveReason, null);
    const row = clients.find((client) => client.id === clientId)!;
    assert.equal(row.isArchived, false);
    assert.equal(row.archiveReason, null);
    const event = createdEvents.find((item) => item.clientId === clientId);
    assert.deepEqual(event, { type: "status", clientId, ownerSellerId: "seller-a", description: `Cliente reativado manualmente por ${users[userId].name}` });
    const audit = createdAudits.find((item) => item.clientId === clientId);
    assert.equal(audit?.origin, PORTFOLIO_CLEANUP_MANUAL_REACTIVATION_AUDIT_ORIGIN);
    assert.equal(audit?.actorUserId, userId);
    assert.equal(audit?.actorEmail, `${userId}@test.invalid`);
    assert.equal(audit?.metadata?.operation, "portfolio_cleanup_manual_reactivation");
    assert.equal(audit?.metadata?.archivedAt, archivedAt.toISOString());
  }
  assert.equal(createdEvents.length, 2);
  assert.equal(createdAudits.length, 2);

  // Segunda tentativa: já está ativo.
  assert.equal((await reactivate("manager-a", "client-limpeza-1")).status, 409);

  // GET /clients: includeArchived só vale para gerente e diretor.
  const sellerList = await request("seller-a", "GET", "/clients?page=1&pageSize=10&includeArchived=1");
  assert.equal(sellerList.status, 200);
  assert.equal(listWheres.at(-1)?.isArchived, false, "vendedor continua vendo só ativos");
  assert.ok(sellerList.json.items.every((item: Row) => item.isArchived === false));
  for (const userId of ["manager-a", "director-a"]) {
    const list = await request(userId, "GET", "/clients?page=1&pageSize=10&includeArchived=1");
    assert.equal(list.status, 200);
    assert.equal(listWheres.at(-1)?.isArchived, true, `${userId}: com o filtro, só arquivados`);
    assert.ok(list.json.items.length > 0);
    assert.ok(list.json.items.every((item: Row) => item.isArchived === true), `${userId}: nenhum ativo com o filtro`);
    assert.ok(list.json.items.some((item: Row) => item.archiveReason === "MERGED_INTO:client-ativo"));
    const activeList = await request(userId, "GET", "/clients?page=1&pageSize=10");
    assert.equal(listWheres.at(-1)?.isArchived, false, `${userId}: sem o filtro, só ativos`);
    assert.ok(activeList.json.items.length > 0);
    assert.ok(activeList.json.items.every((item: Row) => item.isArchived === false), `${userId}: nenhum arquivado sem o filtro`);
  }
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_REACTIVATION=PASS seller_403=PASS duplicate_409=PASS timeline_audit=PASS list_filter_role=PASS");
