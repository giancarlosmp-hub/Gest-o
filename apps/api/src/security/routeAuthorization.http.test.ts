import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; tenants: string[] }> = {
  "seller-a": { role: "vendedor", tenants: ["tenant-a"] },
  "seller-b": { role: "vendedor", tenants: ["tenant-a"] },
  "manager-a": { role: "gerente", tenants: ["tenant-a"] },
  "director-a": { role: "diretor", tenants: ["tenant-a"] },
  "seller-c": { role: "vendedor", tenants: ["tenant-b"] },
  "seller-no-tenant": { role: "vendedor", tenants: [] },
};

let clients: Row[] = [];
let opportunities: Row[] = [];
let contacts: Row[] = [];
let activities: Row[] = [];
let agendaEvents: Row[] = [];
let agendaStops: Row[] = [];

const resetData = () => {
  clients = [
    {
      id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente A", cnpjNormalized: "11111111000111", isArchived: false,
      // Payload ERP fictício com chaves fora da lista de permitidos.
      overdueTitlesTotal: 0,
      financialProfile: { DIAS_MEDIAATRASO: 20, DIAS_MAIORATRASO_AB: 0, QTD_CHEQUES_DEV: 0, VALOR_MEDIO: 100, LIMITE_CREDITO: 1, CPF_CNPJ: "synthetic-erp" },
      partnerTitles: [{ DOCTO: 1, PARCELA: "1", DATA_VENCIMENTO: "2099-01-01", DSCFORMA: "BOLETO", VALOR: 10, SALDO_CAPITAL: 5, NOSSO_NUMERO: "synthetic-erp" }],
    },
    { id: "client-b", tenantId: "tenant-a", ownerSellerId: "seller-b", name: "Cliente B", cnpjNormalized: "11111111000111", isArchived: false },
    { id: "client-other", tenantId: "tenant-b", ownerSellerId: "seller-c", name: "Cliente Outro Tenant", cnpjNormalized: "11111111000111", isArchived: false },
  ];
  opportunities = [
    { id: "opp-a", clientId: "client-a", ownerSellerId: "seller-a" },
    { id: "opp-a2", clientId: "client-a", ownerSellerId: "seller-a" },
    { id: "opp-b", clientId: "client-b", ownerSellerId: "seller-b" },
    { id: "opp-other", clientId: "client-other", ownerSellerId: "seller-c" },
  ];
  contacts = [
    { id: "contact-a", clientId: "client-a", ownerSellerId: "seller-a", name: "Contato A" },
    { id: "contact-b", clientId: "client-b", ownerSellerId: "seller-b", name: "Contato B" },
    { id: "contact-orphan-b", clientId: null, ownerSellerId: "seller-b", name: "Contato sem cliente B" },
    { id: "contact-other", clientId: "client-other", ownerSellerId: "seller-c", name: "Contato Outro Tenant" },
  ];
  activities = [
    {
      id: "act-a", type: "ligacao", done: true, description: "Resumo ficticio", result: null, date: new Date("2026-10-20T12:00:00.000Z"),
      dueDate: new Date("2026-10-20T12:00:00.000Z"), clientId: "client-a", opportunityId: null, agendaEventId: null, ownerSellerId: "seller-a",
    },
  ];
  agendaStops = [];
  const eventDates = { startDateTime: new Date("2026-11-03T12:00:00.000Z"), endDateTime: new Date("2026-11-03T13:00:00.000Z") };
  agendaEvents = [
    { id: "evt-a", title: "Compromisso A", type: "ligacao", status: "agendado", sellerId: "seller-a", clientId: "client-a", opportunityId: null, ...eventDates },
    { id: "evt-b", title: "Compromisso B", type: "ligacao", status: "agendado", sellerId: "seller-b", clientId: "client-b", opportunityId: null, ...eventDates },
    { id: "evt-other", title: "Compromisso Outro Tenant", type: "ligacao", status: "agendado", sellerId: "seller-c", clientId: "client-other", opportunityId: null, ...eventDates },
  ];
};

const membershipsOf = (userId: string) => (users[userId]?.tenants ?? []).map((tenantId) => ({ tenantId, status: "active" }));
const clientById = (id: string | null) => clients.find((client) => client.id === id) ?? null;

const opportunityView = (row: Row) => ({
  ...row,
  title: `Oportunidade ${row.id}`,
  stage: "prospeccao",
  crop: null,
  productOffered: null,
  value: 1000,
  probability: null,
  notes: null,
  followUpDate: null,
  lastContactAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  client: clientById(row.clientId),
  ownerSeller: { name: row.ownerSellerId },
  timelineEvents: [],
  activities: [],
});
const agendaEventView = (row: Row) => ({
  ...row,
  seller: { tenantMemberships: membershipsOf(row.sellerId) },
  stops: agendaStops.filter((stop) => stop.agendaEventId === row.id),
  _count: { activities: 0 },
});
const contactView = (row: Row) => ({ ...row, client: clientById(row.clientId), ownerSeller: { tenantMemberships: membershipsOf(row.ownerSellerId) } });

// Strict evaluator: any where key the fixture does not model fails the test instead of matching silently.
const matches = (row: Row | null, where: Row | undefined): boolean => {
  if (!where) return true;
  if (!row) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "OR") return (expected as Row[]).some((branch) => matches(row, branch));
    if (!(key in row)) throw new Error(`where key não modelada no teste: ${key}`);
    const actual = row[key];
    if (expected === null) return actual === null;
    if (typeof expected === "object" && "some" in expected) return (actual as Row[]).some((item) => matches(item, expected.some));
    if (typeof expected === "object" && "not" in expected) return actual !== expected.not;
    if (typeof expected === "object") return matches(actual, expected);
    return actual === expected;
  });
};

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { name: where.id } : null),
});
setModel("tenantMembership", {
  findMany: async ({ where }: any) => membershipsOf(where.userId).map(({ tenantId }) => ({ tenantId })),
});
setModel("knowledgeDocument", { findMany: async () => [] });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("activity", {
  aggregate: async () => ({ _max: { date: null, createdAt: null } }),
  count: async () => 0,
  findFirst: async ({ where }: any) => activities.find((row) => matches(row, where)) ?? null,
  create: async ({ data }: any) => {
    const created = { id: `act-new-${activities.length + 1}`, createdAt: new Date(), ...data };
    activities.push(created);
    return created;
  },
  update: async ({ where, data }: any) => {
    const index = activities.findIndex((row) => row.id === where.id);
    activities[index] = { ...activities[index], ...data };
    return activities[index];
  },
});
setModel("agendaEvent", {
  findFirst: async ({ where }: any) => agendaEvents.map(agendaEventView).find((row) => matches(row, where)) ?? null,
  findUnique: async ({ where }: any) => {
    const row = agendaEvents.find((candidate) => candidate.id === where.id);
    return row ? agendaEventView(row) : null;
  },
  create: async ({ data }: any) => {
    const { stops, ...rest } = data;
    const created = { id: `evt-new-${agendaEvents.length + 1}`, status: "agendado", ...rest };
    agendaEvents.push(created);
    for (const [index, stop] of (stops?.create ?? []).entries()) agendaStops.push({ id: `${created.id}-stop-${index + 1}`, agendaEventId: created.id, ...stop });
    return agendaEventView(created);
  },
  update: async ({ where, data }: any) => {
    const index = agendaEvents.findIndex((row) => row.id === where.id);
    agendaEvents[index] = { ...agendaEvents[index], ...data };
    return agendaEventView(agendaEvents[index]);
  },
});
setModel("agendaStop", {
  create: async ({ data }: any) => {
    const created = { id: `stop-new-${agendaStops.length + 1}`, ...data };
    agendaStops.push(created);
    return { ...created, client: null };
  },
});
setModel("opportunity", {
  count: async () => 0,
  findFirst: async ({ where }: any) => opportunities.map(opportunityView).find((row) => matches(row, where)) ?? null,
  updateMany: async () => ({ count: 0 }),
  create: async ({ data }: any) => {
    const created = { id: `opp-new-${opportunities.length + 1}`, ...data };
    opportunities.push(created);
    return created;
  },
  update: async ({ where, data }: any) => {
    const index = opportunities.findIndex((row) => row.id === where.id);
    opportunities[index] = { ...opportunities[index], ...data };
    return opportunityView(opportunities[index]);
  },
  delete: async ({ where }: any) => {
    const removed = opportunities.find((row) => row.id === where.id);
    opportunities = opportunities.filter((row) => row.id !== where.id);
    return removed;
  },
});
setModel("timelineEvent", { create: async ({ data }: any) => data });
// Itens: a oportunidade é conferida antes; sem itens na simulação, "Item não encontrado" prova que a conferência passou.
setModel("opportunityItem", { findMany: async () => [], findFirst: async () => null });
setModel("opportunityChangeLog", { create: async ({ data }: any) => data });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));
setModel("client", {
  findFirst: async ({ where }: any) => clients.find((row) => matches(row, where)) ?? null,
  findMany: async ({ where }: any) => clients.filter((row) => matches(row, where)).map((row) => ({ ...row, _count: { opportunities: 0, activities: 0, timelineEvents: 0 } })),
  groupBy: async ({ where }: any) => {
    const counts = new Map<string, number>();
    for (const row of clients.filter((client) => matches(client, where))) counts.set(row.cnpjNormalized, (counts.get(row.cnpjNormalized) ?? 0) + 1);
    return [...counts].filter(([, count]) => count > 1).map(([cnpjNormalized, count]) => ({ cnpjNormalized, _count: { cnpjNormalized: count } }));
  },
  delete: async ({ where }: any) => {
    const removed = clients.find((row) => row.id === where.id);
    clients = clients.filter((row) => row.id !== where.id);
    return removed;
  },
});
setModel("contact", {
  findFirst: async ({ where }: any) => contacts.map(contactView).find((row) => matches(row, where)) ?? null,
  create: async ({ data }: any) => {
    const created = { id: `contact-new-${contacts.length + 1}`, ...data };
    contacts.push(created);
    return created;
  },
  update: async ({ where, data }: any) => {
    const index = contacts.findIndex((row) => row.id === where.id);
    contacts[index] = { ...contacts[index], ...data };
    return contacts[index];
  },
  delete: async ({ where }: any) => {
    const removed = contacts.find((row) => row.id === where.id);
    contacts = contacts.filter((row) => row.id !== where.id);
    return removed;
  },
});

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = (userId: string, method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const status = async (userId: string, method: string, path: string, body?: unknown) => (await call(userId, method, path, body)).status;
const exists = (rows: Row[], id: string) => rows.some((row) => row.id === id);

try {
  // Vendedor A não lê, edita nem apaga registros do vendedor B: 404 sem revelar existência.
  resetData();
  assert.equal(await status("seller-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-b" }), 404);
  assert.equal(await status("seller-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-b"), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/opportunities/opp-b"), 403);
  assert.equal(await status("seller-a", "DELETE", "/api/companies/client-b"), 404);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-b", { name: "Invasor" }), 404);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-orphan-b", { name: "Invasor" }), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-b"), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-orphan-b"), 404);
  assert(exists(opportunities, "opp-b") && exists(clients, "client-b"), "registros de B não podem ser apagados por A");
  assert(exists(contacts, "contact-b") && exists(contacts, "contact-orphan-b"), "contatos de B não podem ser apagados por A");
  assert.equal(contacts.find((row) => row.id === "contact-b")?.name, "Contato B", "contato de B não pode ser editado por A");

  // Vendedor A mantém acesso aos próprios registros, sem poder repassar dono nem apontar para cliente alheio.
  assert.equal(await status("seller-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-a" }), 200);
  assert.equal(await status("seller-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-a"), 200);
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-a", { name: "Contato A2", ownerSellerId: "seller-b" }), 200);
  assert.equal(contacts.find((row) => row.id === "contact-a")?.ownerSellerId, "seller-a", "vendedor não pode transferir o contato para outro dono");
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-a", { clientId: "client-b" }), 404);
  assert.equal(contacts.find((row) => row.id === "contact-a")?.clientId, "client-a");
  // Vendedor encerra, mas não exclui oportunidade, nem a própria: 403 e o registro permanece.
  assert.equal(await status("seller-a", "DELETE", "/api/opportunities/opp-a2"), 403);
  assert(exists(opportunities, "opp-a2"), "vendedor não pode excluir a própria oportunidade");
  assert.equal(await status("seller-a", "DELETE", "/api/contacts/contact-a"), 204);

  // Gerente pode tudo dentro do próprio tenant, inclusive contato sem cliente vinculado.
  resetData();
  assert.equal(await status("manager-a", "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-b" }), 200);
  assert.equal(await status("manager-a", "GET", "/api/ai/opportunity-message?opportunityId=opp-b"), 200);
  assert.equal(await status("manager-a", "PUT", "/api/contacts/contact-b", { name: "Editado pelo gerente" }), 200);
  assert.equal(contacts.find((row) => row.id === "contact-b")?.name, "Editado pelo gerente");
  assert.equal(await status("manager-a", "PUT", "/api/contacts/contact-orphan-b", { name: "Órfão editado" }), 200);
  assert.equal(await status("manager-a", "DELETE", "/api/contacts/contact-orphan-b"), 204);
  assert.equal(await status("manager-a", "DELETE", "/api/opportunities/opp-b"), 204);
  assert.equal(await status("manager-a", "DELETE", "/api/companies/client-b"), 204);
  assert(!exists(opportunities, "opp-b") && !exists(clients, "client-b") && !exists(contacts, "contact-orphan-b"));

  // Diretor exclui oportunidade de qualquer vendedor do próprio tenant.
  resetData();
  assert.equal(await status("director-a", "DELETE", "/api/opportunities/opp-a"), 204);
  assert.equal(await status("director-a", "DELETE", "/api/opportunities/opp-b"), 204);
  assert(!exists(opportunities, "opp-a") && !exists(opportunities, "opp-b"));
  resetData();

  // Gerente e diretor não alcançam registros de outro tenant.
  for (const userId of ["manager-a", "director-a"]) {
    assert.equal(await status(userId, "POST", "/api/ai/opportunity-insight", { opportunityId: "opp-other" }), 404);
    assert.equal(await status(userId, "GET", "/api/ai/opportunity-message?opportunityId=opp-other"), 404);
    assert.equal(await status(userId, "DELETE", "/api/opportunities/opp-other"), 404);
    assert.equal(await status(userId, "DELETE", "/api/companies/client-other"), 404);
    assert.equal(await status(userId, "PUT", "/api/contacts/contact-other", { name: "Cross-tenant" }), 404);
    assert.equal(await status(userId, "DELETE", "/api/contacts/contact-other"), 404);
  }
  assert(exists(opportunities, "opp-other") && exists(clients, "client-other") && exists(contacts, "contact-other"));

  // duplicate-documents: 403 para vendedor; gerente/diretor só enxergam o próprio tenant.
  resetData();
  assert.equal(await status("seller-a", "GET", "/api/clients/diagnostics/duplicate-documents"), 403);
  for (const userId of ["manager-a", "director-a"]) {
    const response = await call(userId, "GET", "/api/clients/diagnostics/duplicate-documents");
    assert.equal(response.status, 200);
    const payload = await response.json() as { duplicates: Array<{ totalClients: number; clients: Row[] }> };
    assert.equal(payload.duplicates.length, 1);
    assert.equal(payload.duplicates[0].totalClients, 2);
    assert.deepEqual(payload.duplicates[0].clients.map((client) => client.id).sort(), ["client-a", "client-b"]);
  }

  // GET /clients e /clients/:id: só a projeção do ERP (lista de permitidos) e o creditAlert; vendedor A não vê o cliente de B.
  resetData();
  assert.equal(await status("seller-a", "GET", "/api/clients/client-b"), 404);
  const allowedProfileKeys = ["DIAS_MEDIAATRASO", "DIAS_MAIORATRASO_AB", "QTD_CHEQUES_DEV", "VALOR_MEDIO", "DATA_PRIMFATURA", "DATA_ULTFATURA", "VALOR_ULTFATURA"];
  const allowedTitleKeys = ["DOCTO", "PARCELA", "DATA_VENCIMENTO", "DSCFORMA", "VALOR", "SALDO_CAPITAL"];
  const assertProjectedClient = (client: Row) => {
    assert.doesNotMatch(JSON.stringify(client), /synthetic-erp|LIMITE_CREDITO|NOSSO_NUMERO/);
    for (const key of Object.keys(client.financialProfile ?? {})) assert(allowedProfileKeys.includes(key), key);
    for (const title of client.partnerTitles ?? []) for (const key of Object.keys(title)) assert(allowedTitleKeys.includes(key), key);
  };
  const detailResponse = await call("seller-a", "GET", "/api/clients/client-a");
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as Row;
  assertProjectedClient(detail);
  assert.deepEqual(detail.creditAlert, { level: "risco", reasons: ["Atraso médio de 20 dias"] });
  const listResponse = await call("seller-a", "GET", "/api/clients");
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as Row[];
  assert.deepEqual(list.map((client) => client.id), ["client-a"]);
  list.forEach(assertProjectedClient);

  // Oportunidade só em cliente do escopo (sellerWhere + tenant). Fora do escopo ou inexistente: 403 sem revelar existência.
  const addArchivedClientA = () => clients.push({ id: "client-a-archived", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente A Arquivado", cnpjNormalized: "22222222000122", isArchived: true, archiveReason: "MERGED_INTO:client-a" });
  resetData();
  addArchivedClientA();
  const newOpportunity = (clientId: string, extra: Row = {}) => ({
    title: "Oportunidade Ficticia", value: 100, stage: "prospeccao", clientId,
    proposalDate: "2026-10-18", followUpDate: "2026-10-25", expectedCloseDate: "2026-11-30", ...extra,
  });
  const outOfScope = async (userId: string, method: string, path: string, body: Row) => {
    const response = await call(userId, method, path, body);
    assert.equal(response.status, 403, `${userId} ${method} ${path} ${body.clientId}`);
    assert.equal(((await response.json()) as Row).message, "Cliente fora da sua carteira.");
  };
  const opportunityCount = () => opportunities.length;

  // Vendedor: só a própria carteira; o dono fica sempre com ele.
  const ownCreate = await call("seller-a", "POST", "/api/opportunities", newOpportunity("client-a", { ownerSellerId: "seller-b" }));
  assert.equal(ownCreate.status, 201);
  assert.equal(((await ownCreate.json()) as Row).ownerSellerId, "seller-a");
  const before = opportunityCount();
  await outOfScope("seller-a", "POST", "/api/opportunities", newOpportunity("client-b"));
  await outOfScope("seller-a", "POST", "/api/opportunities", newOpportunity("client-other"));
  await outOfScope("seller-a", "POST", "/api/opportunities", newOpportunity("client-inexistente"));
  assert.equal(opportunityCount(), before, "nada criado fora do escopo");
  const archived = await call("seller-a", "POST", "/api/opportunities", newOpportunity("client-a-archived"));
  assert.equal(archived.status, 409);
  assert.equal(((await archived.json()) as Row).message, "Cliente arquivado. Peça ao gerente para reativar o cadastro.");

  // Edição: sem trocar cliente segue como antes; troca exige o novo cliente no escopo; oportunidade de outro vendedor é 404.
  assert.equal(await status("seller-a", "PUT", "/api/opportunities/opp-a", { title: "Editada pelo vendedor", clientId: "client-a" }), 200);
  assert.equal(opportunities.find((row) => row.id === "opp-a")?.title, "Editada pelo vendedor");
  await outOfScope("seller-a", "PUT", "/api/opportunities/opp-a", { clientId: "client-b" });
  await outOfScope("seller-a", "PUT", "/api/opportunities/opp-a", { clientId: "client-inexistente" });
  assert.equal((await call("seller-a", "PUT", "/api/opportunities/opp-a", { clientId: "client-a-archived" })).status, 409);
  assert.equal(opportunities.find((row) => row.id === "opp-a")?.clientId, "client-a", "cliente da oportunidade não muda fora do escopo");
  const foreign = await call("seller-a", "PUT", "/api/opportunities/opp-b", { title: "Invasor" });
  assert.equal(foreign.status, 404);
  assert.equal(((await foreign.json()) as Row).message, "Oportunidade não encontrada");
  assert.equal(await status("seller-a", "PUT", "/api/opportunities/opp-other", { title: "Invasor" }), 404);
  assert.equal(opportunities.find((row) => row.id === "opp-b")?.title, undefined, "oportunidade de B não pode ser editada por A");
  assert.equal(await status("seller-a", "PUT", "/api/opportunities/opp-a", { ownerSellerId: "seller-b" }), 403);
  assert.equal(opportunities.find((row) => row.id === "opp-a")?.ownerSellerId, "seller-a", "vendedor não muda o dono");

  // Gerente e diretor: qualquer cliente do tenant; outro tenant é 403 (cliente) ou 404 (oportunidade).
  for (const userId of ["manager-a", "director-a"]) {
    assert.equal(await status(userId, "POST", "/api/opportunities", newOpportunity("client-b")), 201, `${userId}: cliente do tenant`);
    await outOfScope(userId, "POST", "/api/opportunities", newOpportunity("client-other"));
    await outOfScope(userId, "POST", "/api/opportunities", newOpportunity("client-inexistente"));
    assert.equal((await call(userId, "POST", "/api/opportunities", newOpportunity("client-a-archived"))).status, 409);
    await outOfScope(userId, "PUT", "/api/opportunities/opp-a2", { clientId: "client-other" });
    assert.equal(await status(userId, "PUT", "/api/opportunities/opp-other", { title: "Cross-tenant" }), 404);
  }
  assert.equal(await status("manager-a", "PUT", "/api/opportunities/opp-a2", { clientId: "client-b" }), 200);
  assert.equal(opportunities.find((row) => row.id === "opp-a2")?.clientId, "client-b");
  assert.equal(await status("director-a", "PUT", "/api/opportunities/opp-a2", { ownerSellerId: "seller-b" }), 200);
  assert.equal(opportunities.find((row) => row.id === "opp-a2")?.ownerSellerId, "seller-b", "diretor transfere dentro do tenant");
  assert.equal(opportunities.find((row) => row.id === "opp-other")?.clientId, "client-other");

  // Contatos: cliente no escopo (sellerWhere + tenant). POST /contacts fora do escopo ou inexistente é 403 sem revelar
  // existência; arquivado no escopo segue aceito. As rotas /clients/:id/contacts seguem 404, agora também por tenant.
  resetData();
  addArchivedClientA();
  const newContact = (clientId: string) => ({ name: "Contato Ficticio", phone: "11900000000", email: "contato@test.invalid", clientId });
  const contactCount = () => contacts.length;
  assert.equal(await status("seller-a", "POST", "/api/contacts", newContact("client-a")), 201);
  assert.equal(await status("seller-a", "POST", "/api/contacts", newContact("client-a-archived")), 201, "arquivado no escopo: resposta atual");
  const beforeContacts = contactCount();
  for (const clientId of ["client-b", "client-other", "client-inexistente"]) await outOfScope("seller-a", "POST", "/api/contacts", newContact(clientId));
  for (const userId of ["manager-a", "director-a"]) {
    await outOfScope(userId, "POST", "/api/contacts", newContact("client-other"));
    await outOfScope(userId, "POST", "/api/contacts", newContact("client-inexistente"));
  }
  assert.equal(contactCount(), beforeContacts, "nada criado fora do escopo");
  assert.equal(await status("manager-a", "POST", "/api/contacts", newContact("client-b")), 201);
  assert.equal(await status("director-a", "POST", "/api/contacts", newContact("client-b")), 201);
  // Edição sem trocar o cliente segue como antes.
  assert.equal(await status("seller-a", "PUT", "/api/contacts/contact-a", { name: "Contato A editado", clientId: "client-a" }), 200);

  const clientContact = { name: "Contato Ficticio", phone: "11900000000", email: "contato@test.invalid" };
  assert.equal(await status("seller-a", "POST", "/api/clients/client-a/contacts", clientContact), 201);
  assert.equal(await status("seller-a", "POST", "/api/clients/client-b/contacts", clientContact), 404);
  assert.equal(await status("seller-a", "POST", "/api/clients/client-a-archived/contacts", clientContact), 404, "arquivado: resposta atual");
  assert.equal(await status("seller-a", "PUT", "/api/clients/client-a/contacts/contact-a", { name: "Contato A2" }), 200);
  assert.equal(await status("seller-a", "PUT", "/api/clients/client-b/contacts/contact-b", { name: "Invasor" }), 404);
  assert.equal(await status("seller-a", "DELETE", "/api/clients/client-b/contacts/contact-b"), 404);
  for (const userId of ["manager-a", "director-a"]) {
    assert.equal(await status(userId, "POST", "/api/clients/client-b/contacts", clientContact), 201);
    assert.equal(await status(userId, "POST", "/api/clients/client-other/contacts", clientContact), 404);
    assert.equal(await status(userId, "PUT", "/api/clients/client-other/contacts/contact-other", { name: "Cross-tenant" }), 404);
    assert.equal(await status(userId, "DELETE", "/api/clients/client-other/contacts/contact-other"), 404);
  }
  assert.equal(contacts.find((row) => row.id === "contact-other")?.name, "Contato Outro Tenant", "contato de outro tenant intacto");
  assert.equal(contacts.find((row) => row.id === "contact-b")?.name, "Contato B");
  assert.equal(await status("manager-a", "DELETE", "/api/clients/client-b/contacts/contact-b"), 204);
  assert(!exists(contacts, "contact-b"));

  // Atividades. POST sem oportunidade: cliente no escopo (403). Com oportunidade do usuário (sellerWhere + tenant): vale o
  // cliente dela, mesmo de outra carteira; cliente diferente do dela segue 400. Oportunidade e compromisso fora: 404.
  resetData();
  addArchivedClientA();
  opportunities.push({ id: "opp-a-on-b", clientId: "client-b", ownerSellerId: "seller-a" });
  const newActivity = (extra: Row) => ({ type: "ligacao", description: "Resultado ficticio", date: "2026-10-20T12:00:00.000Z", noNextStepReason: "Motivo ficticio", ...extra });
  const activityCount = () => activities.length;
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-a" })), 201);
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-a-archived" })), 201, "arquivado no escopo: resposta atual");
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-b", opportunityId: "opp-a-on-b" })), 201, "cliente da oportunidade do vendedor");
  assert.equal(activities.at(-1)?.clientId, "client-b");
  const beforeActivities = activityCount();
  for (const clientId of ["client-b", "client-other", "client-inexistente"]) await outOfScope("seller-a", "POST", "/api/activities", newActivity({ clientId }));
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-a", opportunityId: "opp-a-on-b" })), 400);
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-b", opportunityId: "opp-b" })), 404);
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ opportunityId: "opp-other" })), 404);
  const foreignEvent = await call("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-a", agendaEventId: "evt-b" }));
  assert.equal(foreignEvent.status, 404);
  assert.equal(((await foreignEvent.json()) as Row).message, "Evento da agenda não encontrado.");
  for (const userId of ["manager-a", "director-a"]) {
    await outOfScope(userId, "POST", "/api/activities", newActivity({ clientId: "client-other" }));
    assert.equal(await status(userId, "POST", "/api/activities", newActivity({ opportunityId: "opp-other" })), 404);
    assert.equal(await status(userId, "POST", "/api/activities", newActivity({ clientId: "client-b", agendaEventId: "evt-other" })), 404, "compromisso de outro tenant");
  }
  assert.equal(activityCount(), beforeActivities, "nada criado fora do escopo");
  assert.equal(await status("seller-a", "POST", "/api/activities", newActivity({ clientId: "client-a", agendaEventId: "evt-a" })), 201);
  assert.equal(await status("manager-a", "POST", "/api/activities", newActivity({ clientId: "client-b" })), 201);
  assert.equal(await status("director-a", "POST", "/api/activities", newActivity({ clientId: "client-b", agendaEventId: "evt-b" })), 201);

  // PUT: só confere cliente, oportunidade e compromisso quando mudam; reenviar o mesmo segue como antes.
  const actA = () => activities.find((row) => row.id === "act-a")!;
  assert.equal(await status("seller-a", "PUT", "/api/activities/act-a", { clientId: "client-a", description: "Resumo editado" }), 200);
  assert.equal(actA().description, "Resumo editado");
  await outOfScope("seller-a", "PUT", "/api/activities/act-a", { clientId: "client-b" });
  await outOfScope("seller-a", "PUT", "/api/activities/act-a", { clientId: "client-inexistente" });
  assert.equal(await status("seller-a", "PUT", "/api/activities/act-a", { opportunityId: "opp-b" }), 404);
  assert.equal(await status("seller-a", "PUT", "/api/activities/act-a", { agendaEventId: "evt-b" }), 404);
  for (const userId of ["manager-a", "director-a"]) {
    await outOfScope(userId, "PUT", "/api/activities/act-a", { clientId: "client-other" });
    assert.equal(await status(userId, "PUT", "/api/activities/act-a", { opportunityId: "opp-other" }), 404);
    assert.equal(await status(userId, "PUT", "/api/activities/act-a", { agendaEventId: "evt-other" }), 404);
  }
  assert.deepEqual([actA().clientId, actA().opportunityId, actA().agendaEventId], ["client-a", null, null], "nada trocado fora do escopo");
  assert.equal(await status("seller-a", "PUT", "/api/activities/act-a", { opportunityId: "opp-a", agendaEventId: "evt-a" }), 200);
  assert.deepEqual([actA().opportunityId, actA().agendaEventId], ["opp-a", "evt-a"]);
  assert.equal(await status("seller-a", "PUT", "/api/activities/act-a", { opportunityId: "opp-a", agendaEventId: "evt-a", clientId: "client-a" }), 200, "mesmos valores");
  assert.equal(await status("manager-a", "PUT", "/api/activities/act-a", { clientId: "client-b", agendaEventId: "evt-b" }), 200);
  assert.deepEqual([actA().clientId, actA().agendaEventId], ["client-b", "evt-b"]);

  // Agenda. POST: cliente do compromisso e de cada parada no escopo (403), exceto o cliente da oportunidade do usuário;
  // oportunidade fora do escopo: 404. PATCH confere a oportunidade só quando muda; parada nova confere o cliente.
  resetData();
  addArchivedClientA();
  opportunities.push({ id: "opp-a-on-b", clientId: "client-b", ownerSellerId: "seller-a" });
  const newEvent = (extra: Row) => ({
    title: "Compromisso ficticio", type: "ligacao", startDateTime: "2026-11-04T12:00:00.000Z", endDateTime: "2026-11-04T13:00:00.000Z", ...extra,
  });
  const newRoute = (stopClientIds: string[], extra: Row = {}) => newEvent({
    type: "roteiro_visita", stops: stopClientIds.map((clientId) => ({ clientId, city: "Cidade Ficticia" })), ...extra,
  });
  const eventCount = () => agendaEvents.length;
  assert.equal(await status("seller-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-a" })), 201);
  assert.equal(await status("seller-a", "POST", "/api/agenda", newEvent({ clientId: "client-a-archived" })), 201, "arquivado no escopo: resposta atual");
  assert.equal(await status("seller-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-b", opportunityId: "opp-a-on-b" })), 201, "cliente da oportunidade do vendedor");
  assert.equal(await status("seller-a", "POST", "/api/agenda/events", newRoute(["client-a", "client-b"], { opportunityId: "opp-a-on-b" })), 201);
  assert.equal(await status("seller-a", "POST", "/api/agenda/events", newRoute(["client-a"])), 201);
  const beforeEvents = eventCount();
  for (const clientId of ["client-b", "client-other", "client-inexistente"]) {
    await outOfScope("seller-a", "POST", "/api/agenda/events", newEvent({ clientId }));
    await outOfScope("seller-a", "POST", "/api/agenda", newRoute(["client-a", clientId]));
  }
  await outOfScope("seller-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-b", opportunityId: "opp-b" }));
  await outOfScope("seller-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-other", opportunityId: "opp-a-on-b" }));
  const foreignOpportunity = await call("seller-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-a", opportunityId: "opp-b" }));
  assert.equal(foreignOpportunity.status, 404);
  assert.equal(((await foreignOpportunity.json()) as Row).message, "Oportunidade não encontrada");
  for (const userId of ["manager-a", "director-a"]) {
    await outOfScope(userId, "POST", "/api/agenda/events", newEvent({ clientId: "client-other", ownerSellerId: "seller-a" }));
    await outOfScope(userId, "POST", "/api/agenda/events", newRoute(["client-b", "client-other"], { ownerSellerId: "seller-a" }));
    assert.equal(await status(userId, "POST", "/api/agenda/events", newEvent({ clientId: "client-b", opportunityId: "opp-other", ownerSellerId: "seller-b" })), 404);
  }
  assert.equal(eventCount(), beforeEvents, "nada criado fora do escopo");
  assert.equal(await status("manager-a", "POST", "/api/agenda/events", newEvent({ clientId: "client-b", opportunityId: "opp-b", ownerSellerId: "seller-a" })), 201);
  assert.equal(await status("director-a", "POST", "/api/agenda/events", newRoute(["client-a", "client-b"], { ownerSellerId: "seller-b" })), 201);

  // PATCH: reenviar a mesma oportunidade segue; trocar exige a nova no escopo.
  const evtA = () => agendaEvents.find((row) => row.id === "evt-a")!;
  assert.equal(await status("seller-a", "PATCH", "/api/agenda/evt-a", { opportunityId: "opp-a", notes: "Nota ficticia" }), 200);
  assert.equal(await status("seller-a", "PATCH", "/api/agenda/events/evt-a", { opportunityId: "opp-a", notes: "Mesma oportunidade" }), 200);
  assert.equal(evtA().notes, "Mesma oportunidade");
  assert.equal(await status("seller-a", "PATCH", "/api/agenda/evt-a", { opportunityId: "opp-b" }), 404);
  for (const userId of ["manager-a", "director-a"]) {
    assert.equal(await status(userId, "PATCH", "/api/agenda/events/evt-a", { opportunityId: "opp-other" }), 404);
  }
  assert.equal(evtA().opportunityId, "opp-a", "oportunidade não trocada fora do escopo");
  assert.equal(await status("manager-a", "PATCH", "/api/agenda/evt-a", { opportunityId: "opp-b" }), 200);
  assert.equal(evtA().opportunityId, "opp-b");

  // Parada nova: cliente no escopo.
  assert.equal(await status("seller-a", "POST", "/api/agenda/events/evt-a/stops", { clientId: "client-a" }), 201);
  assert.equal(await status("seller-a", "POST", "/api/agenda/events/evt-a/stops", { clientId: "client-a-archived" }), 201, "arquivado no escopo: resposta atual");
  const stopsBefore = agendaStops.length;
  for (const clientId of ["client-b", "client-other", "client-inexistente"]) await outOfScope("seller-a", "POST", "/api/agenda/events/evt-a/stops", { clientId });
  for (const userId of ["manager-a", "director-a"]) await outOfScope(userId, "POST", "/api/agenda/events/evt-b/stops", { clientId: "client-other" });
  assert.equal(agendaStops.length, stopsBefore, "nenhuma parada fora do escopo");
  assert.equal(await status("manager-a", "POST", "/api/agenda/events/evt-b/stops", { clientId: "client-a" }), 201);

  // Itens da oportunidade e comentário (POST /events): oportunidade com sellerWhere + tenant; fora do escopo segue 404.
  resetData();
  const opportunityNotFound = async (userId: string, method: string, path: string, body?: Row) => {
    const response = await call(userId, method, path, body);
    assert.equal(response.status, 404, `${userId} ${method} ${path}`);
    assert.equal(((await response.json()) as Row).message, "Oportunidade não encontrada");
  };
  const itemRoutes = (opportunityId: string): Array<[string, string, Row?]> => [
    ["GET", `/api/opportunities/${opportunityId}/items`],
    ["POST", `/api/opportunities/${opportunityId}/items`, { quantity: 1, unitPrice: 10 }],
    ["PUT", `/api/opportunities/${opportunityId}/items/item-inexistente`, { quantity: 2 }],
    ["DELETE", `/api/opportunities/${opportunityId}/items/item-inexistente`],
  ];
  const comment = (opportunityId: string) => ({ description: "Comentario ficticio", opportunityId });
  for (const [method, path, body] of itemRoutes("opp-b")) await opportunityNotFound("seller-a", method, path, body);
  await opportunityNotFound("seller-a", "POST", "/api/events", comment("opp-b"));
  for (const userId of ["manager-a", "director-a"]) {
    for (const [method, path, body] of itemRoutes("opp-other")) await opportunityNotFound(userId, method, path, body);
    await opportunityNotFound(userId, "POST", "/api/events", comment("opp-other"));
    assert.equal(await status(userId, "GET", "/api/opportunities/opp-b/items"), 200);
    assert.equal(((await (await call(userId, "PUT", "/api/opportunities/opp-b/items/item-inexistente", { quantity: 2 })).json()) as Row).message, "Item não encontrado");
    assert.equal(await status(userId, "POST", "/api/events", comment("opp-b")), 201);
  }
  assert.equal(await status("seller-a", "GET", "/api/opportunities/opp-a/items"), 200);
  assert.equal(((await (await call("seller-a", "DELETE", "/api/opportunities/opp-a/items/item-inexistente")).json()) as Row).message, "Item não encontrado");
  assert.equal(await status("seller-a", "POST", "/api/opportunities/opp-a/items", { quantity: 0 }), 400, "payload validado depois da oportunidade");
  assert.equal(await status("seller-a", "POST", "/api/events", comment("opp-a")), 201);

  // Sem tenant ativo: 403 explícito, sem tocar nos dados.
  resetData();
  assert.equal(await status("seller-no-tenant", "POST", "/api/opportunities", newOpportunity("client-a")), 403);
  assert.equal(await status("seller-no-tenant", "POST", "/api/contacts", newContact("client-a")), 403);
  assert.equal(await status("seller-no-tenant", "DELETE", "/api/clients/client-a/contacts/contact-a"), 403);
  assert(exists(contacts, "contact-a"));
  const activitiesBeforeNoTenant = activities.length;
  assert.equal(await status("seller-no-tenant", "POST", "/api/activities", { type: "ligacao", description: "Ficticio", date: "2026-10-20T12:00:00.000Z" }), 403);
  assert.equal(activities.length, activitiesBeforeNoTenant);
  const eventsBeforeNoTenant = agendaEvents.length;
  assert.equal(await status("seller-no-tenant", "POST", "/api/agenda/events", { title: "Ficticio", type: "ligacao", startDateTime: "2026-11-04T12:00:00.000Z", endDateTime: "2026-11-04T13:00:00.000Z" }), 403);
  assert.equal(agendaEvents.length, eventsBeforeNoTenant);
  assert.equal(await status("seller-no-tenant", "GET", "/api/opportunities/opp-a/items"), 403);
  assert.equal(await status("seller-no-tenant", "POST", "/api/events", { description: "Comentario ficticio", opportunityId: "opp-a" }), 403);
  assert.equal(await status("seller-no-tenant", "DELETE", "/api/opportunities/opp-a"), 403);
  assert.equal(await status("seller-no-tenant", "GET", "/api/ai/opportunity-message?opportunityId=opp-a"), 403);
  assert(exists(opportunities, "opp-a"));

  console.log("route authorization HTTP regression passed");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}
