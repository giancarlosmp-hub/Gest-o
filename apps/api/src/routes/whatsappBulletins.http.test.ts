import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: card "Boletins WhatsApp" (aceite/descadastro por telefone e culturas do cliente).
// Permissões: vendedor só na própria carteira, gerente e diretor em todos, sempre no tenant do usuário.
type Row = Record<string, any>;

const users: Record<string, { role: "vendedor" | "gerente" | "diretor"; name: string; tenantId: string | null }> = {
  "seller-a": { role: "vendedor", name: "Vendedor Ficticio", tenantId: "tenant-a" },
  "seller-b": { role: "vendedor", name: "Outro Vendedor Ficticio", tenantId: "tenant-a" },
  "manager-a": { role: "gerente", name: "Gerente Ficticio", tenantId: "tenant-a" },
  "director-b": { role: "diretor", name: "Diretor Outro Tenant", tenantId: "tenant-b" },
  "no-tenant": { role: "diretor", name: "Sem Tenant", tenantId: null },
};
const clients: Row[] = [
  { id: "client-a1", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
  { id: "client-a2", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false },
  { id: "client-b1", tenantId: "tenant-b", ownerSellerId: "seller-x", isArchived: false },
];
const phoneIndex: Row[] = [
  { id: "idx-a1-erp", clientId: "client-a1", phone: "5511900000001", source: "erp" },
  { id: "idx-a1-crm", clientId: "client-a1", phone: "5511900000001", source: "crm" },
  { id: "idx-a1-fixo", clientId: "client-a1", phone: "551130000001", source: "crm" },
  { id: "idx-a2", clientId: "client-a2", phone: "5511900000002", source: "erp" },
  { id: "idx-b1", clientId: "client-b1", phone: "5511900000001", source: "erp" },
];
const cultures: Row[] = [
  { id: "cult-soja", label: "Soja", category: "Grãos", isActive: true },
  { id: "cult-trigo", label: "Trigo", category: "Grãos", isActive: true },
  { id: "cult-velha", label: "Cultura Antiga", category: "Outras", isActive: false },
];
const consentEvents: Row[] = [];
const clientCultures: Row[] = [{ clientId: "client-a1", cultureId: "cult-velha" }];
const timeline: Row[] = [];
let clock = Date.parse("2026-11-01T12:00:00.000Z");
let seq = 0;

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in (value as Row)) return (value as Row).in.includes(row[key]);
    return row[key] === value;
  });

setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id].role, region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: users[where.id].name, role: users[where.id].role, isActive: true } : null),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId]?.tenantId ? [{ tenantId: users[where.userId].tenantId }] : []) });
setModel("client", {
  findFirst: async ({ where }: any) => {
    assert.ok(where.tenantId, "cliente sempre filtrado por tenant");
    const row = clients.find((client) => matches(client, where));
    return row ? { id: row.id, ownerSellerId: row.ownerSellerId } : null;
  },
});
setModel("clientPhoneIndex", {
  findMany: async ({ where }: any) => phoneIndex.filter((row) => matches(row, where)).sort((a, b) => (a.source === b.source ? (a.id < b.id ? -1 : 1) : a.source < b.source ? 1 : -1)),
  findFirst: async ({ where }: any) => phoneIndex.find((row) => matches(row, where)) ?? null,
});
setModel("marketingConsentEvent", {
  create: async ({ data }: any) => {
    seq += 1;
    clock += 1000;
    const row = { id: `evt-${String(seq).padStart(4, "0")}`, createdAt: new Date(clock), ...data };
    consentEvents.push(row);
    return { id: row.id };
  },
  findMany: async ({ where, distinct }: any) => {
    assert.ok(where.tenantId, "histórico sempre filtrado por tenant");
    const rows = consentEvents.filter((row) => matches(row, where)).sort((a, b) => b.createdAt - a.createdAt);
    const out = rows.map((row) => ({ ...row, recordedBy: row.recordedById ? { name: users[row.recordedById]?.name ?? null } : null }));
    if (distinct) return [...new Map(out.map((row) => [row.phone, row])).values()];
    return out;
  },
});
setModel("timelineEvent", { create: async ({ data }: any) => { timeline.push(data); return data; } });
setModel("cultureCatalog", {
  findMany: async ({ where }: any) => cultures.filter((row) => matches(row, where)).sort((a, b) => a.label.localeCompare(b.label)).map((row) => ({ ...row })),
});
setModel("clientCulture", {
  findMany: async ({ where, select }: any) => {
    const rows = clientCultures.filter((row) => row.clientId === where.clientId);
    if (select?.culture) {
      const fields = Object.keys(select.culture.select);
      return rows.map((row) => {
        const culture = cultures.find((item) => item.id === row.cultureId)!;
        return { culture: Object.fromEntries(fields.map((key) => [key, culture[key]])) };
      });
    }
    return rows.map((row) => ({ cultureId: row.cultureId }));
  },
  deleteMany: ({ where }: any) => ({ op: "delete", where }),
  createMany: ({ data }: any) => ({ op: "create", data }),
});
(prisma as any).$transaction = async (input: any) => {
  if (typeof input === "function") return input(prisma);
  for (const op of input) {
    if (op.op === "delete") {
      for (let i = clientCultures.length - 1; i >= 0; i -= 1) {
        if (clientCultures[i].clientId === op.where.clientId && op.where.cultureId.in.includes(clientCultures[i].cultureId)) clientCultures.splice(i, 1);
      }
    }
    if (op.op === "create") clientCultures.push(...op.data);
  }
  return [];
};

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}/whatsapp/bulletins/clients${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId].role })}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};

try {
  // Sem token: 401.
  assert.equal((await fetch(`${baseUrl}/whatsapp/bulletins/clients/client-a1/consent`)).status, 401);

  // Vendedor na própria carteira: telefones do índice, sem duplicar ERP/CRM, nenhum registro ainda.
  const initial = await call("seller-a", "GET", "/client-a1/consent");
  assert.equal(initial.status, 200);
  assert.equal(initial.json.phones.length, 2, "mesmo telefone no ERP e no CRM aparece uma vez");
  assert.deepEqual(initial.json.phones[0].sources, ["erp", "crm"]);
  assert.equal(initial.json.phones[0].phoneRef, "idx-a1-erp");
  assert.equal(initial.json.phones[0].display, "(11) 90000-0001");
  assert.equal(initial.json.phones[0].current, null);
  assert.equal(initial.json.phones[0].canReceive, false);

  // Vendedor fora da carteira: 404 em tudo e nada gravado.
  assert.equal((await call("seller-b", "GET", "/client-a1/consent")).status, 404);
  assert.equal((await call("seller-b", "POST", "/client-a1/consent", { phoneRef: "idx-a1-erp", status: "ACEITE", source: "VENDEDOR_MANUAL" })).status, 404);
  assert.equal((await call("seller-b", "GET", "/client-a1/cultures")).status, 404);
  assert.equal((await call("seller-b", "PUT", "/client-a1/cultures", { cultureIds: ["cult-soja"] })).status, 404);
  assert.equal(consentEvents.length, 0);

  // Outro tenant: o diretor do tenant B não vê o cliente do tenant A, e vice-versa.
  assert.equal((await call("director-b", "GET", "/client-a1/consent")).status, 404);
  assert.equal((await call("manager-a", "GET", "/client-b1/consent")).status, 404);
  assert.equal((await call("manager-a", "POST", "/client-b1/consent", { phoneRef: "idx-b1", status: "ACEITE", source: "OUTRO" })).status, 404);
  assert.equal((await call("no-tenant", "GET", "/client-a1/consent")).status, 403, "sem tenant ativo único");

  // phoneRef de outro cliente: 404, sem número digitado.
  const otherRef = await call("seller-a", "POST", "/client-a1/consent", { phoneRef: "idx-a2", status: "ACEITE", source: "VENDEDOR_MANUAL" });
  assert.equal(otherRef.status, 404);
  assert.equal(otherRef.json.code, "phone_not_found");
  assert.equal((await call("seller-a", "POST", "/client-a1/consent", { phone: "5511900000001", status: "ACEITE", source: "VENDEDOR_MANUAL" })).status, 400, "número solto é recusado");
  assert.equal((await call("seller-a", "POST", "/client-a1/consent", { phoneRef: "idx-a1-erp", status: "TALVEZ", source: "VENDEDOR_MANUAL" })).status, 400);
  assert.equal((await call("seller-a", "POST", "/client-a1/consent", { phoneRef: "idx-a1-erp", status: "ACEITE", source: "VENDEDOR_MANUAL", note: "x".repeat(281) })).status, 400);
  assert.equal(consentEvents.length, 0);

  // Aceite → descadastro → aceite pelo vendedor dono.
  const accept = await call("seller-a", "POST", "/client-a1/consent", { phoneRef: "idx-a1-erp", status: "ACEITE", source: "VENDEDOR_MANUAL", note: "Pediu na visita" });
  assert.equal(accept.status, 201);
  assert.equal(accept.json.phones[0].canReceive, true);
  assert.equal(consentEvents[0].tenantId, "tenant-a");
  assert.equal(consentEvents[0].phone, "5511900000001");
  assert.equal(consentEvents[0].clientId, "client-a1");
  assert.equal(consentEvents[0].recordedById, "seller-a");
  assert.equal(timeline[0].type, "comentario");
  assert.equal(timeline[0].ownerSellerId, "seller-a");
  assert.equal(timeline[0].description, "Aceite dos boletins WhatsApp registrado por Vendedor Ficticio (Vendedor (manual)).");

  const optOut = await call("manager-a", "POST", "/client-a1/consent", { phoneRef: "idx-a1-crm", status: "DESCADASTRO", source: "OUTRO" });
  assert.equal(optOut.status, 201, "gerente registra em qualquer cliente do tenant");
  assert.equal(optOut.json.phones[0].canReceive, false, "o mesmo telefone pela linha do CRM");
  assert.equal(optOut.json.phones[0].current.status, "DESCADASTRO");
  assert.equal(timeline[1].ownerSellerId, "seller-a", "linha do tempo em nome do dono da carteira");

  const again = await call("seller-a", "POST", "/client-a1/consent", { phoneRef: "idx-a1-erp", status: "ACEITE", source: "WHATSAPP_LINK" });
  assert.equal(again.json.phones[0].canReceive, true);
  assert.equal(again.json.phones[0].history.length, 3, "histórico completo, mais recente primeiro");
  assert.deepEqual(again.json.phones[0].history.map((item: Row) => item.status), ["ACEITE", "DESCADASTRO", "ACEITE"]);
  assert.equal(again.json.phones[0].history[2].note, "Pediu na visita");
  assert.equal(again.json.phones[0].history[2].recordedByName, "Vendedor Ficticio");
  assert.equal(again.json.phones[1].canReceive, false, "o fixo continua sem registro");

  // Telefone com histórico ligado ao cliente que saiu do índice: aparece sem referência para registrar.
  consentEvents.push({ id: "evt-legado", tenantId: "tenant-a", phone: "5511900000009", clientId: "client-a1", status: "ACEITE", source: "WHATSAPP_LINK", note: null, recordedById: null, createdAt: new Date(clock + 5000) });
  const withHistoryOnly = await call("seller-a", "GET", "/client-a1/consent");
  const historyOnly = withHistoryOnly.json.phones.find((phone: Row) => phone.display === "(11) 90000-0009");
  assert.equal(historyOnly.phoneRef, null);
  assert.equal(historyOnly.canReceive, true);

  // Culturas: lista do catálogo técnico (só ativas para escolher); desativada já ligada continua.
  const culturesView = await call("seller-a", "GET", "/client-a1/cultures");
  assert.equal(culturesView.status, 200);
  assert.deepEqual(culturesView.json.options.map((item: Row) => item.id), ["cult-soja", "cult-trigo"]);
  assert.deepEqual(culturesView.json.selected, [{ id: "cult-velha", label: "Cultura Antiga", isActive: false }]);

  const saved = await call("seller-a", "PUT", "/client-a1/cultures", { cultureIds: ["cult-soja", "cult-velha", "cult-soja"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.selected.map((item: Row) => item.id).sort(), ["cult-soja", "cult-velha"]);

  const removed = await call("manager-a", "PUT", "/client-a1/cultures", { cultureIds: ["cult-trigo"] });
  assert.deepEqual(removed.json.selected.map((item: Row) => item.id), ["cult-trigo"]);

  const inactive = await call("seller-a", "PUT", "/client-a1/cultures", { cultureIds: ["cult-velha"] });
  assert.equal(inactive.status, 400, "desativada não entra de novo depois de removida");
  assert.equal(inactive.json.code, "inactive_culture");
  const unknown = await call("seller-a", "PUT", "/client-a1/cultures", { cultureIds: ["cult-inexistente"] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, "unknown_culture");
  assert.equal((await call("seller-a", "PUT", "/client-a1/cultures", { cultureIds: "cult-soja" })).status, 400);
  assert.deepEqual(clientCultures.filter((row) => row.clientId === "client-a1").map((row) => row.cultureId), ["cult-trigo"]);
  assert.equal((await call("seller-a", "PUT", "/client-a1/cultures", { cultureIds: [] })).status, 200);
  assert.equal(clientCultures.filter((row) => row.clientId === "client-a1").length, 0);
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("WHATSAPP_BULLETINS=PASS seller_scope_404=PASS tenant_404=PASS phone_ref_only=PASS consent_history=PASS cultures=PASS");
