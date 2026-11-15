import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

// Dados fictícios: vendedores, tenant, códigos e nomes inventados.
// Regra do dono na sincronização de parceiros por vendedor: o campo Vendedor do cadastro do ERP manda;
// o login que trouxe o parceiro só decide o dono de cliente novo sem vendedor do ERP utilizável.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-partner-owner-key";

const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");
const { buildErpSellerDirectory, resolvePartnerOwner } = await import("./partnerOwnerRule.js");

type Row = Record<string, any>;
const TENANT = "tenant-ficticio";
const OUTRO_TENANT = "tenant-ficticio-2";

// ---------------------------------------------------------------------------------------------------
// 1) Regra pura
// ---------------------------------------------------------------------------------------------------
{
  const directory = buildErpSellerDirectory([
    { id: "u-a", erpCode: "0101", tenantIds: [TENANT] },
    { id: "u-b", erpCode: "202", tenantIds: [TENANT] },
    { id: "u-dup1", erpCode: "500", tenantIds: [TENANT] },
    { id: "u-dup2", erpCode: "500", tenantIds: [TENANT] },
    { id: "u-outro", erpCode: "600", tenantIds: [OUTRO_TENANT] },
    { id: "u-dois", erpCode: "700", tenantIds: [TENANT, OUTRO_TENANT] },
  ]);
  const decide = (erpSellerCode: string, currentOwnerId: string | null, loginSellerId = "u-b") =>
    resolvePartnerOwner({ erpSellerCode, directory, tenantId: TENANT, loginSellerId, currentOwnerId });

  assert.deepEqual(decide("101", "u-b"), { ownerSellerId: "u-a", source: "erp_seller" }, "zeros à esquerda: 0101 = 101");
  assert.deepEqual(decide(" 101 ", null), { ownerSellerId: "u-a", source: "erp_seller" }, "cliente novo também segue o ERP");
  assert.deepEqual(decide("", "u-a"), { ownerSellerId: "u-a", source: "kept_erp_seller_missing" });
  assert.deepEqual(decide("999", "u-a"), { ownerSellerId: "u-a", source: "kept_erp_seller_unmatched" });
  assert.deepEqual(decide("500", "u-a"), { ownerSellerId: "u-a", source: "kept_erp_seller_unmatched" }, "dois usuários com o mesmo código: ambíguo");
  assert.deepEqual(decide("600", "u-a"), { ownerSellerId: "u-a", source: "kept_erp_seller_unmatched" }, "usuário de outro tenant");
  assert.deepEqual(decide("700", "u-a"), { ownerSellerId: "u-a", source: "kept_erp_seller_unmatched" }, "usuário com dois tenants");
  assert.deepEqual(decide("", null), { ownerSellerId: "u-b", source: "new_client_login_seller" });
  assert.deepEqual(decide("999", null), { ownerSellerId: "u-b", source: "new_client_login_seller" });
  assert.equal(resolvePartnerOwner({ erpSellerCode: "101", directory, tenantId: null, loginSellerId: "u-b", currentOwnerId: "u-b" }).source, "kept_erp_seller_unmatched", "sem tenant não resolve");
}

// ---------------------------------------------------------------------------------------------------
// 2) Sincronização por vendedor com banco e ERP falsos
// ---------------------------------------------------------------------------------------------------
const seller = (id: string, name: string, erpCode: string, login: string | null, isActive = true): Row => ({
  id, name, role: "vendedor", isActive, erpCode,
  erpLoginUsername: login, erpLoginPasswordEncrypted: login ? encryptErpCredential(`senha-${id}`) : null,
  tenantMemberships: [{ tenantId: TENANT }],
});
const sellers: Row[] = [
  seller("seller-a", "Vendedor Ficticio A", "101", "login-a"),
  seller("seller-b", "Vendedor Ficticio B", "202", "login-b"),
  seller("seller-sem-login", "Vendedor Ficticio Sem Login", "303", null),
  seller("seller-inativo", "Vendedor Ficticio Inativo", "404", null, false),
];

let clients: Row[] = [];
let timeline: Row[] = [];
const runs: Row[] = [];
const locks = new Map<string, Row>();
const appConfig = new Map<string, string>();
let idSeq = 0;
const baseClient = (over: Row): Row => ({
  tenantId: TENANT, code: null, cnpj: null, cnpjNormalized: null, name: "Cliente Ficticio", nameNormalized: "cliente ficticio",
  city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "PR", region: "Sul", segment: null, isArchived: false,
  archiveReason: null, erpUpdatedAt: new Date("2026-06-16T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

const fieldMatches = (value: unknown, condition: unknown): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    const c = condition as Row;
    if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
    if ("in" in c) return c.in.includes(value);
    if ("startsWith" in c) return typeof value === "string" && value.toLowerCase().startsWith(String(c.startsWith).toLowerCase());
  }
  return value === condition;
};
const matches = (row: Row, where: Row | undefined): boolean => !where || Object.entries(where).every(([key, condition]) => {
  if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
  if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
  if (key === "NOT") return Array.isArray(condition) ? !(condition as Row[]).some((part) => matches(row, part)) : !matches(row, condition as Row);
  return fieldMatches(row[key], condition);
});
const withRelations = (row: Row) => ({
  ...row,
  ownerSeller: { name: sellers.find((item) => item.id === row.ownerSellerId)?.name ?? null },
  _count: { opportunities: 0, timelineEvents: 0, activities: 0, contacts: 0, agendaEvents: 0, agendaStops: 0 },
});
const applyUpdate = (row: Row, data: Row) => {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === "tenant") row.tenantId = (value as Row).connect.id;
    else if (key === "ownerSeller") row.ownerSellerId = (value as Row).connect.id;
    else row[key] = value;
  }
};
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("client", {
  findMany: async ({ where }: Row) => clients.filter((row) => matches(row, where)).map(withRelations),
  count: async ({ where }: Row) => clients.filter((row) => matches(row, where)).length,
  update: async ({ where, data }: Row) => { const row = clients.find((c) => c.id === where.id)!; applyUpdate(row, data); return row; },
  create: async ({ data }: Row) => { const row = baseClient({ ...data, id: `created-${++idSeq}`, createdAt: new Date() }); clients.push(row); return row; },
});
setModel("timelineEvent", { create: async ({ data }: Row) => { timeline.push(data); return data; } });
setModel("clientCodeAudit", { create: async ({ data }: Row) => data });
// Filtros usados: vendedores com login FV3 (ordem por nome), vendedores ativos com erpCode, usuário por id.
const userMatches = (user: Row, where: Row) =>
  (where.isActive === undefined || user.isActive === where.isActive)
  && (where.role === undefined || user.role === where.role)
  && (where.erpCode === undefined || Boolean(user.erpCode))
  && (where.erpLoginUsername === undefined || Boolean(user.erpLoginUsername))
  && (where.erpLoginPasswordEncrypted === undefined || Boolean(user.erpLoginPasswordEncrypted));
setModel("user", {
  findFirst: async ({ where }: Row) => sellers.find((user) => user.id === where.id && userMatches(user, { ...where, id: undefined })) ?? null,
  findUnique: async ({ where }: Row) => sellers.find((user) => user.id === where.id) ?? null,
  findMany: async ({ where }: Row) => sellers.filter((user) => userMatches(user, where)).sort((a, b) => a.name.localeCompare(b.name)),
});
setModel("tenantMembership", { findMany: async () => [{ tenantId: TENANT }] });
setModel("appConfig", {
  findUnique: async ({ where }: Row) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: Row) => { appConfig.set(where.key, appConfig.has(where.key) ? update.value : create.value); return {}; },
});
setModel("erpSyncLock", {
  create: async ({ data }: Row) => {
    if (locks.has(data.scope)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    locks.set(data.scope, { ...data }); return data;
  },
  updateMany: async () => ({ count: 0 }),
  findUnique: async ({ where }: Row) => locks.get(where.scope) ?? null,
  deleteMany: async ({ where }: Row) => { locks.delete(where.scope); return { count: 1 }; },
});
setModel("erpSyncRun", {
  create: async ({ data }: Row) => { const run = { id: `run-${runs.length + 1}`, ...data }; runs.push(run); return run; },
  update: async ({ where, data }: Row) => Object.assign(runs.find((run) => run.id === where.id)!, data),
});
(prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

// ERP fictício: o /partners devolve a carteira de cada login; o campo Vendedor vem no cadastro.
const partner = (code: string, erpSeller: string | null): Row => ({
  PARCEIRO: code, RAZAO_SOCIAL: `Cliente Ficticio ${code}`, CIDADE: "Cidade Ficticia", UF: "PR", IDN_CLIENTE: "S",
  ...(erpSeller === null ? {} : { VENDEDOR_DO_PARCEIRO: erpSeller }),
});
let partnersByLogin: Record<string, Row[]> = {};
(ultraFv3Client as any).hasGlobalCredentials = () => false;
(ultraFv3Client as any).requestWithCredentials = async (path: string, credentials: { username: string }) => {
  assert.ok(path.startsWith("/partners"), path);
  return partnersByLogin[credentials.username] ?? [];
};

const sync = await import("./ultraFv3SyncService.js");
const ownerOf = (code: string) => clients.find((client) => client.code === code)!.ownerSellerId;
const changeEvents = (clientId: string) => timeline.filter((event) => event.clientId === clientId && /^Cliente atualizado via UltraFV3\. Vendedor alterado de /.test(event.description));

{
  idSeq = 0;
  timeline = [];
  clients = [
    // Dono atual B (estado depois da alternância antiga); o ERP diz A e os dois logins veem o cliente.
    baseClient({ id: "c-ambos", code: "9001", ownerSellerId: "seller-b" }),
    // Campo Vendedor vazio: mantém o dono, mesmo vindo pelo login de B.
    baseClient({ id: "c-vazio", code: "9002", ownerSellerId: "seller-a" }),
    // Caso (a): o ERP aponta usuário ativo sem login FV3.
    baseClient({ id: "c-sem-login", code: "9003", ownerSellerId: "seller-a" }),
    // ERP aponta usuário inativo: sem usuário ativo correspondente, mantém o dono.
    baseClient({ id: "c-inativo", code: "9004", ownerSellerId: "seller-b" }),
  ];
  partnersByLogin = {
    "login-a": [partner("9001", "101"), partner("9003", "303"), partner("9007", "999")],
    "login-b": [partner("9001", "0101"), partner("9002", null), partner("9004", "404"), partner("9005", null), partner("9006", "101")],
  };

  const first = await sync.syncPartnersForAllConfiguredSellers();
  assert.equal(first.errorCount, 0, JSON.stringify(first.results.map((item) => item.error ?? null)));
  assert.equal(ownerOf("9001"), "seller-a", "campo Vendedor do ERP = A: o cliente fica com A");
  assert.equal(changeEvents("c-ambos").length, 1, "uma troca B→A, e a passada de B não devolve para B");
  assert.match(changeEvents("c-ambos")[0].description, /de Vendedor Ficticio B para Vendedor Ficticio A\./);
  assert.equal(changeEvents("c-ambos")[0].ownerSellerId, "seller-a");
  assert.equal(ownerOf("9002"), "seller-a", "campo vazio: mantém o dono");
  assert.equal(changeEvents("c-vazio").length, 0, "sem troca, sem evento");
  assert.equal(ownerOf("9003"), "seller-sem-login", "usuário ativo sem login FV3 vira o dono");
  assert.equal(changeEvents("c-sem-login").length, 1);
  assert.equal(ownerOf("9004"), "seller-b", "vendedor do ERP inativo: mantém o dono");
  assert.equal(ownerOf("9005"), "seller-b", "cliente novo sem vendedor do ERP: vendedor do login");
  assert.equal(ownerOf("9006"), "seller-a", "cliente novo com vendedor do ERP: segue o ERP, mesmo vindo pelo login de B");
  assert.equal(ownerOf("9007"), "seller-a", "cliente novo com vendedor do ERP sem usuário: vendedor do login");
  assert.equal(clients.filter((client) => client.code === "9001").length, 1, "nenhuma duplicata");
  assert.equal(first.sellerChangedCount, 2, "9001 e 9003");
  assert.equal(first.ownerKeptErpSellerMissing, 1, "9002");
  assert.equal(first.ownerKeptErpSellerUnmatched, 1, "9004");
  assert.equal(first.ownerChangeBlockedInRound, 0);
  const passB = first.results.find((item) => item.userId === "seller-b")!;
  assert.equal(passB.diagnostics?.ownerKeptErpSellerMissing, 1, "contador por vendedor no Histórico");

  // Rodadas seguintes: nada muda, nenhum evento novo (antes alternava a cada rodada).
  const eventsBefore = timeline.length;
  for (let round = 0; round < 3; round += 1) {
    const next = await sync.syncPartnersForAllConfiguredSellers();
    assert.equal(next.sellerChangedCount, 0, `rodada ${round + 2}: nenhuma troca`);
  }
  assert.equal(ownerOf("9001"), "seller-a");
  assert.equal(timeline.length, eventsBefore, "nenhum evento 'Vendedor alterado' novo");
}

// ---------------------------------------------------------------------------------------------------
// 3) Rede de segurança: ERP inconsistente (cada login devolve um vendedor diferente para o mesmo código).
// No máximo uma troca por cliente por rodada.
// ---------------------------------------------------------------------------------------------------
{
  timeline = [];
  clients = [baseClient({ id: "c-inconsistente", code: "9008", ownerSellerId: "seller-sem-login" })];
  partnersByLogin = { "login-a": [partner("9008", "101")], "login-b": [partner("9008", "202")] };
  const round = await sync.syncPartnersForAllConfiguredSellers();
  assert.equal(changeEvents("c-inconsistente").length, 1, "uma única troca na rodada");
  assert.equal(ownerOf("9008"), "seller-a", "a primeira passada troca; a segunda é bloqueada");
  assert.equal(round.ownerChangeBlockedInRound, 1);
  assert.equal(round.sellerChangedCount, 1);
}

// ---------------------------------------------------------------------------------------------------
// 4) Caminho global (credencial de referência) usa a mesma regra e a mesma rede de segurança.
// ---------------------------------------------------------------------------------------------------
{
  timeline = [];
  clients = [baseClient({ id: "c-global", code: "9009", ownerSellerId: "seller-b" })];
  (ultraFv3Client as any).hasGlobalCredentials = () => true;
  (ultraFv3Client as any).request = async (path: string) => {
    assert.ok(path.startsWith("/partners"), path);
    return [partner("9009", "101")];
  };
  partnersByLogin = { "login-a": [partner("9009", "101")] };
  const result = await sync.syncPartners();
  assert.equal(ownerOf("9009"), "seller-a");
  assert.equal(changeEvents("c-global").length, 1);
  assert.equal((result.diagnostics as Row | undefined)?.sellerChangedCount, 1);
  await sync.syncPartners();
  assert.equal(changeEvents("c-global").length, 1, "segunda rodada global não troca");
  (ultraFv3Client as any).hasGlobalCredentials = () => false;
}

console.log("ULTRAFV3_PARTNER_OWNER_RULE=PASS rule=PASS both_logins_no_flip=PASS empty_keeps=PASS active_without_login=PASS new_client=PASS round_guard=PASS global_path=PASS");
