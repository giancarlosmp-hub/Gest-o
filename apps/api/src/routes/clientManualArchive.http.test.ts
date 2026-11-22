import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { buildPortfolioCleanupArchiveReason } from "../services/portfolioCleanupArchive.js";
import { isManualArchiveReason } from "../services/clientManualArchive.js";

// Dados fictícios: POST /clients/:id/archive ("Arquivar") e "Desarquivar" de um arquivado manual pelo /reactivate.
type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; name: string }> = {
  "seller-a": { role: "vendedor", name: "Vendedor Ficticio" },
  "manager-a": { role: "gerente", name: "Gerente Ficticio" },
  "director-a": { role: "diretor", name: "Diretor Ficticio" },
};
const clients: Row[] = [
  { id: "client-prospect", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-erp", code: "90020", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-opp-aberta", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-pedido", code: "90021", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-pedido-finalizado", code: "90022", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-limpeza", code: "90023", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: buildPortfolioCleanupArchiveReason(new Date("2026-10-01T12:00:00.000Z")) },
  { id: "client-outro-tenant", code: null, tenantId: "tenant-b", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
];
const opportunities: Row[] = [
  { clientId: "client-erp", stage: "ganho" },
  { clientId: "client-erp", stage: "perdido" },
  { clientId: "client-opp-aberta", stage: "proposta" },
];
const orders: Row[] = [
  { clientId: "client-pedido", status: "sent", operationalStatusRaw: "EM SEPARACAO", orderStatus: null },
  { clientId: "client-pedido-finalizado", status: "sent", operationalStatusRaw: "FINALIZADO", orderStatus: "entregue" },
];
const createdEvents: Row[] = [];
const createdAudits: Row[] = [];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const sameRow = (row: Row, where: Row) => Object.entries(where).every(([key, value]) => row[key] === value);
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: users[where.id].name, role: users[where.id].role, isActive: true } : null),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => {
    const row = clients.find((client) => client.id === where?.id && (where.tenantId === undefined || client.tenantId === where.tenantId));
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
});
setModel("opportunity", {
  count: async ({ where }: any) => {
    assert.deepEqual(where.stage, { notIn: ["ganho", "perdido"] }, "oportunidade aberta = fora de ganho/perdido");
    return opportunities.filter((row) => row.clientId === where.clientId && !where.stage.notIn.includes(row.stage)).length;
  },
});
setModel("erpOrderSync", {
  findMany: async ({ where }: any) => {
    assert.deepEqual(where.status, { in: ["pending", "sent"] });
    return orders.filter((row) => row.clientId === where.opportunity.clientId && where.status.in.includes(row.status));
  },
});
setModel("timelineEvent", { create: async ({ data }: any) => { createdEvents.push(data); return data; } });
setModel("clientCodeAudit", { create: async ({ data }: any) => { createdAudits.push(data); return data; } });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const request = async (userId: string, path: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`, "content-type": "application/json" },
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};
const archive = (userId: string, clientId: string) => request(userId, `/clients/${clientId}/archive`);
const reactivate = (userId: string, clientId: string) => request(userId, `/clients/${clientId}/reactivate`);
const snapshot = () => JSON.stringify(clients);

try {
  // Vendedor: 403 e nada gravado.
  const before = snapshot();
  assert.equal((await archive("seller-a", "client-prospect")).status, 403, "vendedor não arquiva");

  // Outro tenant: 404. Já arquivado: 409.
  assert.equal((await archive("manager-a", "client-outro-tenant")).status, 404);
  assert.equal((await archive("manager-a", "client-limpeza")).status, 409);

  // Oportunidade aberta e pedido pendente: 409 com o motivo, mesma proteção da limpeza da carteira.
  const openOpp = await archive("manager-a", "client-opp-aberta");
  assert.equal(openOpp.status, 409);
  assert.deepEqual(openOpp.json.protectionReasons, ["oportunidadeAberta"]);
  assert.match(openOpp.json.message, /oportunidade aberta/);
  const pendingOrder = await archive("director-a", "client-pedido");
  assert.equal(pendingOrder.status, 409);
  assert.deepEqual(pendingOrder.json.protectionReasons, ["pedidoPendente"]);
  assert.match(pendingOrder.json.message, /pedido pendente/);
  assert.equal(snapshot(), before, "recusas não mudam nada");
  assert.equal(createdEvents.length + createdAudits.length, 0, "recusas não gravam timeline nem auditoria");

  // Arquiva: sem código, com código e histórico fechado, e pedido já finalizado.
  for (const [userId, clientId] of [["manager-a", "client-prospect"], ["director-a", "client-erp"], ["manager-a", "client-pedido-finalizado"]] as const) {
    const ok = await archive(userId, clientId);
    assert.equal(ok.status, 200, `${clientId}: arquiva`);
    assert.equal(ok.json?.isArchived, true);
    assert.ok(isManualArchiveReason(ok.json?.archiveReason));
    assert.match(ok.json.archiveReason, /^MANUAL:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const event = createdEvents.find((item) => item.clientId === clientId);
    assert.deepEqual(event, { type: "status", clientId, ownerSellerId: "seller-a", description: `Cliente arquivado por ${users[userId].name}` });
  }
  assert.equal(clients.find((row) => row.id === "client-erp")!.code, "90020", "código não muda");
  assert.equal(createdAudits.length, 0, "arquivar não grava auditoria de código");

  // Desarquivar um manual: volta ativo, evento próprio e sem a auditoria que protege da limpeza.
  assert.equal((await reactivate("seller-a", "client-prospect")).status, 403, "vendedor não desarquiva");
  const unarchived = await reactivate("manager-a", "client-prospect");
  assert.equal(unarchived.status, 200);
  assert.equal(unarchived.json?.isArchived, false);
  assert.equal(unarchived.json?.archiveReason, null);
  assert.deepEqual(createdEvents.at(-1), { type: "status", clientId: "client-prospect", ownerSellerId: "seller-a", description: "Cliente desarquivado por Gerente Ficticio" });
  assert.equal(createdAudits.length, 0, "desarquivar manual não protege da limpeza da carteira");

  // A reativação da limpeza continua gravando a auditoria de proteção.
  assert.equal((await reactivate("director-a", "client-limpeza")).status, 200);
  assert.equal(createdAudits.length, 1);
  assert.equal(createdEvents.at(-1)?.description, "Cliente reativado manualmente por Diretor Ficticio");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_MANUAL_ARCHIVE=PASS role_403=PASS protection_409=PASS timeline=PASS unarchive_no_audit=PASS");
