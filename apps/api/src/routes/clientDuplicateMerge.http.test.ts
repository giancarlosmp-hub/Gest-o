import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { ARCHIVED_DUPLICATE_REACTIVATION_MESSAGE } from "../services/portfolioCleanupArchive.js";

// Dados fictícios: POST /clients/diagnostics/merge-duplicates ("Mesclar duplicado").
type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; name: string }> = {
  "seller-a": { role: "vendedor", name: "Vendedor Ficticio" },
  "manager-a": { role: "gerente", name: "Gerente Ficticio" },
  "director-a": { role: "diretor", name: "Diretor Ficticio" },
};
const client = (over: Row): Row => ({
  tenantId: "tenant-a", code: null, name: "Cliente Ficticio", cnpj: null, cnpjNormalized: null, nameNormalized: "cliente ficticio",
  ownerSellerId: "seller-a", isArchived: false, archiveReason: null, ...over,
});
let clients: Row[] = [];
let rows: Record<string, Row[]> = {};
const audits: Row[] = [];
const resetData = () => {
  clients = [
    client({ id: "fica", code: "81001", name: "Fazenda Ficticia", nameNormalized: "fazenda ficticia" }),
    client({ id: "sai", code: "81002", name: "Fazenda Ficticia Nova", cnpj: "101.202.303-40", cnpjNormalized: "10120230340", ownerSellerId: "seller-b" }),
    client({ id: "sai-sem-codigo", name: "Fazenda Ficticia Sem Codigo" }),
    client({ id: "arquivado", code: "81003__MERGED__1", isArchived: true, archiveReason: "MERGED_INTO:fica" }),
    client({ id: "outro-tenant", tenantId: "tenant-b", code: "81004" }),
  ];
  rows = {
    opportunity: [{ id: "opp-1", clientId: "sai", ownerSellerId: "seller-b" }, { id: "opp-2", clientId: "fica", ownerSellerId: "seller-a" }],
    activity: [{ id: "act-1", clientId: "sai", ownerSellerId: "seller-b" }],
    timelineEvent: [{ id: "ev-1", clientId: "sai", ownerSellerId: "seller-b" }, { id: "ev-2", clientId: "sai", ownerSellerId: "seller-b" }],
    contact: [{ id: "ct-1", clientId: "fica", isPrimary: true }, { id: "ct-2", clientId: "sai", isPrimary: true }],
    agendaEvent: [{ id: "ag-1", clientId: "sai" }],
    agendaStop: [{ id: "st-1", clientId: "sai" }],
    communicationConversation: [{ id: "cv-1", clientId: "sai" }],
    clientCodeAudit: [{ id: "au-1", clientId: "sai", newValue: "81002" }],
  };
  audits.length = 0;
};

const sameRow = (row: Row, where: Row) => Object.entries(where).every(([key, value]) =>
  value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value);
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: users[where.id].name } : null),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where, select }: any) => { const row = clients.find((c) => sameRow(c, where)); return row ? pick(row, select) : null; },
  findMany: async ({ where, select }: any) => clients.filter((c) => sameRow(c, where)).map((c) => pick(c, select)),
  updateMany: async ({ where, data }: any) => {
    const matched = clients.filter((c) => sameRow(c, where));
    matched.forEach((c) => Object.assign(c, data));
    return { count: matched.length };
  },
});
for (const model of ["opportunity", "activity", "timelineEvent", "contact", "agendaEvent", "agendaStop", "communicationConversation"]) {
  setModel(model, {
    updateMany: async ({ where, data }: any) => {
      const matched = rows[model].filter((row) => sameRow(row, where));
      matched.forEach((row) => Object.assign(row, data));
      return { count: matched.length };
    },
    count: async ({ where }: any) => rows[model].filter((row) => sameRow(row, where)).length,
    create: async ({ data }: any) => { rows[model].push({ id: `new-${rows[model].length}`, ...data }); return data; },
  });
}
setModel("clientCodeAudit", { create: async ({ data }: any) => { audits.push(data); return data; } });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = async (userId: string, method: string, path: string, body?: Row) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};
const merge = (userId: string, primaryClientId: string, duplicateClientIds: string[], reason?: string) =>
  call(userId, "POST", "/clients/diagnostics/merge-duplicates", { primaryClientId, duplicateClientIds, reason });

try {
  resetData();
  // Permissão e escopo.
  assert.equal((await merge("seller-a", "fica", ["sai"])).status, 403, "vendedor não mescla");
  assert.equal((await merge("manager-a", "fica", ["fica"])).status, 400, "precisa de um duplicado diferente");
  assert.equal((await merge("manager-a", "outro-tenant", ["sai"])).status, 404, "cadastro que fica de outro tenant");
  assert.equal((await merge("manager-a", "fica", ["outro-tenant"])).status, 404, "duplicado de outro tenant");
  assert.equal((await merge("manager-a", "arquivado", ["sai"])).status, 409, "cadastro que fica arquivado");
  const again = await merge("manager-a", "fica", ["arquivado"]);
  assert.equal(again.status, 409, "duplicado já arquivado");
  assert.match(again.json.message, /já arquivado/);
  assert.equal(clients.find((c) => c.id === "sai")!.isArchived, false, "nada mudou nas recusas");

  // Mesclagem.
  const ok = await merge("director-a", "fica", ["sai"], "Cadastro repetido no ERP");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.archivedDuplicateIds, ["sai"]);
  assert.deepEqual(ok.json.moved[0].moved, {
    opportunities: 1, activities: 1, timelineEvents: 2, contacts: 1, agendaEvents: 1, agendaStops: 1, communicationConversations: 1,
  });
  for (const model of ["opportunity", "activity", "agendaEvent", "agendaStop", "communicationConversation"]) {
    assert.ok(rows[model].every((row) => row.clientId === "fica"), `${model} foi para o cadastro que fica`);
  }
  assert.equal(rows.opportunity.find((row) => row.id === "opp-1")!.ownerSellerId, "seller-b", "dono da oportunidade preservado");
  assert.equal(rows.contact.find((row) => row.id === "ct-1")!.isPrimary, true, "contato principal do que fica continua principal");
  assert.equal(rows.contact.find((row) => row.id === "ct-2")!.isPrimary, false, "contato trazido não disputa o principal");
  assert.equal(rows.clientCodeAudit[0].clientId, "sai", "auditoria de código antiga fica no duplicado");

  const duplicate = clients.find((c) => c.id === "sai")!;
  assert.equal(duplicate.isArchived, true);
  assert.equal(duplicate.archiveReason, "MERGED_INTO:fica");
  assert.match(duplicate.code, /^81002__MERGED__\d+$/);
  assert.equal(duplicate.cnpjNormalized, null, "documento liberado para a sincronização");
  assert.equal(duplicate.cnpj, "101.202.303-40 [MERGED INTO fica]");
  assert.match(duplicate.name, /^\[ARQUIVADO ERP DUP\] /);
  assert.match(duplicate.nameNormalized, / sai$/, "nome normalizado único");
  const primary = clients.find((c) => c.id === "fica")!;
  assert.equal(primary.code, "81001");
  assert.equal(primary.isArchived, false);

  const event = rows.timelineEvent.find((row) => row.description)!;
  assert.equal(event.clientId, "fica");
  assert.equal(event.ownerSellerId, "seller-a");
  assert.match(event.description, /código 81002/);
  assert.match(event.description, /Diretor Ficticio/);
  assert.match(event.description, /Motivo: Cadastro repetido no ERP/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].clientId, "sai");
  assert.equal(audits[0].oldValue, "81002");
  assert.equal(audits[0].newValue, duplicate.code);
  assert.equal(audits[0].actorUserId, "director-a");
  assert.equal(audits[0].metadata.operation, "manual_duplicate_merge");
  assert.equal(audits[0].metadata.primaryClientId, "fica");

  // Duplicado sem código: também arquiva e audita a mesclagem.
  assert.equal((await merge("manager-a", "fica", ["sai-sem-codigo"])).status, 200);
  assert.equal(audits.length, 2);
  assert.equal(audits[1].oldValue, null);
  assert.equal(audits[1].newValue, null);

  // Corrida: alguém arquivou entre a leitura e a gravação. 409 e nada é movido.
  resetData();
  const originalUpdateMany = (prisma as any).client.updateMany;
  (prisma as any).client.updateMany = async () => ({ count: 0 });
  const race = await merge("manager-a", "fica", ["sai"]);
  (prisma as any).client.updateMany = originalUpdateMany;
  assert.equal(race.status, 409);
  assert.ok(rows.opportunity.some((row) => row.clientId === "sai"), "nada movido na corrida");

  // O duplicado mesclado não pode ser reativado (regra existente).
  assert.match(ARCHIVED_DUPLICATE_REACTIVATION_MESSAGE, /duplicado/);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_DUPLICATE_MERGE=PASS scope_tenant=PASS archived_409=PASS moves=PASS audit_stays=PASS document_released=PASS race_409=PASS");
