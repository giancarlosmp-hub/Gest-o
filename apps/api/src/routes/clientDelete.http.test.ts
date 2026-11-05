import assert from "node:assert/strict";
import { once } from "node:events";
import { Prisma } from "@prisma/client";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: DELETE /clients/:id só exclui cliente sem vínculo; com vínculo, 409 legível e nada é apagado.
type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor" }> = {
  "seller-a": { role: "vendedor" },
  "seller-b": { role: "vendedor" },
  "manager-a": { role: "gerente" },
};
const zero = { codeAuditEvents: 0, opportunities: 0, timelineEvents: 0, activities: 0, agendaEvents: 0, agendaStops: 0, contacts: 0, communicationConversations: 0 };
const clients: Row[] = [
  { id: "client-livre", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", _count: { ...zero } },
  { id: "client-livre-2", code: "  ", tenantId: "tenant-a", ownerSellerId: "seller-a", _count: { ...zero } },
  { id: "client-codigo", code: "90010", tenantId: "tenant-a", ownerSellerId: "seller-a", _count: { ...zero, codeAuditEvents: 1 } },
  { id: "client-historico", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", _count: { ...zero, opportunities: 2, timelineEvents: 3, contacts: 1 } },
  { id: "client-corrida", code: null, tenantId: "tenant-a", ownerSellerId: "seller-a", _count: { ...zero } },
  { id: "client-outro-tenant", code: null, tenantId: "tenant-b", ownerSellerId: "seller-a", _count: { ...zero } },
];
const deletedIds: string[] = [];
const cascadeCalls: string[] = [];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null, isActive: true } : null),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where }: any) => {
    const row = clients.find((client) => client.id === where?.id && client.tenantId === where?.tenantId);
    return row ? { id: row.id, code: row.code, ownerSellerId: row.ownerSellerId, _count: { ...row._count } } : null;
  },
  delete: async ({ where }: any) => {
    if (where.id === "client-corrida") {
      // Vínculo criado entre a contagem e a exclusão: o banco recusa (P2003).
      throw new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", { code: "P2003", clientVersion: "test" });
    }
    deletedIds.push(where.id);
    return { id: where.id };
  },
});
for (const model of ["activity", "timelineEvent", "contact", "agendaStop", "agendaEvent", "opportunityChangeLog", "opportunity"]) {
  setModel(model, { deleteMany: async () => { cascadeCalls.push(model); return { count: 0 }; } });
}
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const remove = async (userId: string, clientId: string) => {
  const response = await fetch(`${baseUrl}/clients/${clientId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}` },
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

try {
  // Código ERP (ou auditoria de código): 409 citando "Mesclar duplicado", nunca 500/408.
  const withCode = await remove("manager-a", "client-codigo");
  assert.equal(withCode.status, 409);
  assert.deepEqual(withCode.json.blockingReasons, ["código ERP"]);
  assert.match(withCode.json.message, /código ERP/);
  assert.match(withCode.json.message, /Mesclar duplicado/);
  assert.doesNotMatch(withCode.json.message, /Arquivar/);

  // Histórico: lista os vínculos na ordem fixa.
  const withHistory = await remove("seller-a", "client-historico");
  assert.equal(withHistory.status, 409);
  assert.deepEqual(withHistory.json.blockingReasons, ["oportunidades", "linha do tempo", "contatos"]);

  // Corrida com o banco: P2003 vira 409 legível.
  const race = await remove("manager-a", "client-corrida");
  assert.equal(race.status, 409);
  assert.match(race.json.message, /Mesclar duplicado/);

  // Escopo: outro tenant não existe para o usuário; vendedor só exclui o próprio.
  assert.equal((await remove("manager-a", "client-outro-tenant")).status, 404);
  assert.equal((await remove("seller-b", "client-livre")).status, 403);

  assert.deepEqual(deletedIds, [], "nada foi excluído até aqui");
  assert.deepEqual(cascadeCalls, [], "nenhuma exclusão em cascata");

  // Sem nenhum vínculo: exclui (204), e só o cliente.
  assert.equal((await remove("seller-a", "client-livre")).status, 204);
  assert.equal((await remove("manager-a", "client-livre-2")).status, 204);
  assert.deepEqual(deletedIds, ["client-livre", "client-livre-2"]);
  assert.deepEqual(cascadeCalls, [], "nenhuma exclusão em cascata");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_DELETE=PASS linked_409=PASS fk_race_409=PASS tenant_scope=PASS no_cascade=PASS");
