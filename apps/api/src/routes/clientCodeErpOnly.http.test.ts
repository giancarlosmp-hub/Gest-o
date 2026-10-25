import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE } from "@salesforce-pro/shared";

// Dados fictícios: o código do cliente vem só do ERP (sincronização de parceiros).
type Row = Record<string, any>;

const users: Record<string, "vendedor" | "gerente" | "diretor"> = { "seller-a": "vendedor", "director-a": "diretor" };
let clients: Row[] = [];
let opportunities: Row[] = [];
let createdClients: Row[] = [];
let updatedClients: Row[] = [];
let erpOrderSyncCounts = 0;
let erpOrderSyncCreates = 0;
let sequenceCalls = 0;

const resetData = () => {
  clients = [
    { id: "client-synced", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente Sincronizado", nameNormalized: "cliente sincronizado", city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "GO", region: "Centro", code: "90001", cnpj: null, cnpjNormalized: null, fantasyName: null, isArchived: false, erpUpdatedAt: new Date("2026-01-01T00:00:00.000Z") },
    { id: "client-no-code", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente Sem Codigo", nameNormalized: "cliente sem codigo", city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "GO", region: "Centro", code: null, cnpj: "00000000000191", cnpjNormalized: "00000000000191", fantasyName: null, isArchived: false, erpUpdatedAt: null },
  ];
  opportunities = [
    { id: "opp-no-code", clientId: "client-no-code" },
    { id: "opp-synced", clientId: "client-synced" },
  ];
  createdClients = [];
  updatedClients = [];
  erpOrderSyncCounts = 0;
  erpOrderSyncCreates = 0;
  sequenceCalls = 0;
};

const looseMatch = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "AND") return (expected as Row[]).every((branch) => looseMatch(row, branch));
    if (key === "OR") return (expected as Row[]).some((branch) => looseMatch(row, branch));
    if (key === "NOT") return true;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("not" in expected) return row[key] !== expected.not;
      if ("in" in expected) return (expected.in as unknown[]).includes(row[key]);
      if ("equals" in expected) return String(row[key] ?? "").toLowerCase() === String(expected.equals ?? "").toLowerCase();
      if ("contains" in expected || "startsWith" in expected || "mode" in expected) return true;
      return true;
    }
    return row[key] === expected;
  });
};

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

const opportunityView = (row: Row) => ({
  ...row,
  title: `Oportunidade ${row.id}`,
  stage: "ganho",
  ownerSellerId: "seller-a",
  priceTableCode: "1",
  client: clients.find((client) => client.id === row.clientId) ?? null,
  ownerSeller: { id: "seller-a", name: "Vendedor", erpCode: "10", erpOperatorCode: "20", erpLoginUsername: "login-ficticio", erpLoginPasswordEncrypted: "cifrado-ficticio" },
  items: [{ id: "item-1", lineNumber: 1, erpProductCode: "P1", erpProductClassCode: "C1", quantity: 1, unitPrice: 10, product: null }],
});

setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id], region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: where.id, role: users[where.id], isActive: true } : null),
  findMany: async () => Object.entries(users).map(([id, role]) => ({ id, name: id, email: `${id}@test.invalid`, role, isActive: true })),
});
setModel("tenantMembership", {
  findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []),
});
setModel("client", {
  findFirst: async ({ where }: any) => clients.find((row) => looseMatch(row, where)) ?? null,
  findUnique: async ({ where }: any) => clients.find((row) => row.id === where.id) ?? null,
  findMany: async ({ where }: any) => clients.filter((row) => looseMatch(row, where)),
  create: async ({ data }: any) => {
    const created = { id: `client-new-${createdClients.length + 1}`, isArchived: false, ...data };
    createdClients.push(data);
    clients.push(created);
    return created;
  },
  update: async ({ where, data }: any) => {
    const index = clients.findIndex((row) => row.id === where.id);
    updatedClients.push(data);
    clients[index] = { ...clients[index], ...data };
    return clients[index];
  },
});
setModel("clientCodeAudit", { create: async ({ data }: any) => data });
setModel("opportunity", {
  findFirst: async ({ where }: any) => {
    const row = opportunities.find((opportunity) => opportunity.id === where.id);
    return row ? opportunityView(row) : null;
  },
});
setModel("erpOrderSync", {
  count: async () => { erpOrderSyncCounts += 1; return 0; },
  create: async () => { erpOrderSyncCreates += 1; throw new Error("tentativa não deveria ser criada no teste"); },
  findFirst: async () => null,
  findMany: async () => [],
});
setModel("timelineEvent", { create: async ({ data }: any) => data });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));
(prisma as any).$queryRaw = async () => { sequenceCalls += 1; return [{ nextval: 1 }]; };
(prisma as any).$queryRawUnsafe = async () => { sequenceCalls += 1; return [{ nextval: 1 }]; };
(prisma as any).$executeRaw = async () => { sequenceCalls += 1; return 0; };

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId] })}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};

// Cidade da lista oficial do IBGE (o cadastro recusa cidade fora dela).
const newClient = { name: "Cliente Novo Ficticio", city: "Sinop", state: "MT", region: "Norte", clientType: "PJ" };
const orderBody = { paymentMethodCode: "1", receivingConditionCode: "1", priceTableCode: "1", branchCode: "1", operationCode: "1", expectedDeliveryDate: "2026-12-01" };

try {
  // POST/PUT com code: 400 explícito, nada gravado, para qualquer perfil.
  resetData();
  for (const userId of ["seller-a", "director-a"]) {
    const created = await call(userId, "POST", "/api/clients", { ...newClient, code: "7405" });
    assert.equal(created.status, 400, `POST /clients com code deve ser recusado (${userId})`);
    assert.match(created.json?.message ?? "", /código do cliente vem somente do ERP/);
    const updated = await call(userId, "PUT", "/api/clients/client-no-code", { code: "7405" });
    assert.equal(updated.status, 400, `PUT /clients com code deve ser recusado (${userId})`);
    const emptyCode = await call(userId, "PUT", "/api/clients/client-synced", { name: "Cliente Sincronizado", code: "" });
    assert.equal(emptyCode.status, 400, "code vazio também é recusado: não pode apagar o código do ERP");
  }
  assert.equal(createdClients.length, 0, "nenhum cliente criado quando code vem no corpo");
  assert.equal(updatedClients.length, 0, "nenhum cliente alterado quando code vem no corpo");
  assert.equal(clients.find((row) => row.id === "client-synced")?.code, "90001");

  // Cadastro e edição sem code continuam funcionando, sem tocar no código.
  const created = await call("seller-a", "POST", "/api/clients", newClient);
  assert.equal(created.status, 201, `cadastro sem code deve funcionar: ${JSON.stringify(created.json)}`);
  assert.equal(createdClients.length, 1);
  assert.equal("code" in createdClients[0], false, "cadastro do CRM não grava código");
  const edited = await call("seller-a", "PUT", "/api/clients/client-synced", { name: "Cliente Sincronizado Editado" });
  assert.equal(edited.status, 200, `edição sem code deve funcionar: ${JSON.stringify(edited.json)}`);
  assert.equal(clients.find((row) => row.id === "client-synced")?.code, "90001", "edição preserva o código do ERP");

  // Importação: a coluna de código e erpUpdatedAt da planilha não são gravadas.
  resetData();
  const imported = await call("director-a", "POST", "/api/clients/import", {
    rows: [
      { ...newClient, ownerSellerId: "seller-a", code: "7406", erpUpdatedAt: "2026-01-02" },
      { name: "Cliente Sem Codigo", city: "Rio Verde", state: "GO", region: "Centro", clientType: "PJ", ownerSellerId: "seller-a", cnpj: "00000000000191", fantasyName: "Fantasia Ficticia", code: "7407", erpUpdatedAt: "2026-01-03" },
    ],
  });
  assert.equal(imported.status, 200, `importação deve responder 200: ${JSON.stringify(imported.json)}`);
  assert.equal(imported.json?.created, 1, `uma linha nova: ${JSON.stringify(imported.json)}`);
  assert.equal(imported.json?.updated, 1, `uma linha enriquecida: ${JSON.stringify(imported.json)}`);
  for (const data of [...createdClients, ...updatedClients]) {
    assert.equal("code" in data, false, "importação não grava código");
    assert.equal("erpUpdatedAt" in data, false, "importação não finge confirmação do ERP");
  }
  assert.equal(clients.find((row) => row.id === "client-no-code")?.code, null);

  // Pedido de cliente sem código: 422 antes de criar tentativa ou reservar número.
  resetData();
  const blocked = await call("seller-a", "POST", "/api/opportunities/opp-no-code/erp/orders", orderBody);
  assert.equal(blocked.status, 422, `pedido sem código deve ser 422: ${JSON.stringify(blocked.json)}`);
  assert.equal(JSON.stringify(blocked.json).includes(CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE), true, "mensagem clara para o vendedor");
  assert.equal(erpOrderSyncCounts, 0, "verificação vem antes de qualquer leitura de tentativas");
  assert.equal(erpOrderSyncCreates, 0, "nenhuma tentativa criada");
  assert.equal(sequenceCalls, 0, "nenhum número da sequência consumido");

  // Cliente com código segue o fluxo existente (a verificação não bloqueia).
  const allowed = await call("seller-a", "POST", "/api/opportunities/opp-synced/erp/orders", orderBody);
  assert.notEqual(allowed.status, 422, "cliente com código do ERP não é bloqueado pela verificação");
  assert.equal(JSON.stringify(allowed.json).includes(CLIENT_WITHOUT_ERP_CODE_ORDER_MESSAGE), false);
  assert.equal(erpOrderSyncCounts, 1, "cliente com código passa da verificação prévia");

  console.log("client code ERP-only HTTP regression passed");
} finally {
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}
