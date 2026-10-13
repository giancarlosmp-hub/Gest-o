import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

// Dados fictícios: vendedores, tenant, códigos e nomes inventados.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-customer-flag-key";

const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");

type Row = Record<string, any>;
const TENANT = "tenant-ficticio";
const sellers: Row[] = [
  { id: "seller-novo", name: "Vendedor Novo Ficticio", role: "vendedor", isActive: true, erpCode: "77", erpLoginUsername: "login-novo",
    erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia"), tenantMemberships: [{ tenantId: TENANT }] },
  { id: "seller-antigo", name: "Vendedor Antigo Ficticio", role: "vendedor", isActive: true, erpCode: "55", erpLoginUsername: null,
    erpLoginPasswordEncrypted: null, tenantMemberships: [{ tenantId: TENANT }] },
];
const OLD_DATE = new Date("2026-06-16T00:00:00Z");

let clients: Row[] = [];
const runs: Row[] = [];
const locks = new Map<string, Row>();
const appConfig = new Map<string, string>();
let idSeq = 0;
const baseClient = (over: Row): Row => ({
  tenantId: TENANT, code: null, cnpj: null, cnpjNormalized: null, name: "Cliente Ficticio", nameNormalized: "cliente ficticio",
  city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "PR", region: "Sul", segment: null, isArchived: false,
  archiveReason: null, erpUpdatedAt: OLD_DATE, createdAt: new Date("2026-01-01T00:00:00Z"), ownerSellerId: "seller-antigo", ...over,
});
const resetClients = () => {
  idSeq = 0;
  clients = [
    // Fornecedor que já está no CRM (IDN_CLIENTE = N no ERP): não pode ser alterado.
    baseClient({ id: "existing-supplier", code: "7003", name: "Hotel Fornecedor Ficticio", nameNormalized: "hotel fornecedor ficticio" }),
    // Legado sem tenant que é cliente (S): a proteção do #946 continua valendo no scheduler.
    baseClient({ id: "legacy-customer", tenantId: null, code: "7007", name: "Fazenda Legada Ficticia", nameNormalized: "fazenda legada ficticia" }),
    // Legado sem tenant que não é cliente (N): o filtro barra antes; não conta como legado.
    baseClient({ id: "legacy-supplier", tenantId: null, code: "7008", name: "Funcionario Ficticio", nameNormalized: "funcionario ficticio" }),
    // Arquivado que volta como cliente: reativação continua como hoje.
    baseClient({ id: "archived-customer", code: "7009", isArchived: true, archiveReason: "teste", name: "Cliente Arquivado Ficticio", nameNormalized: "cliente arquivado ficticio" }),
  ];
};

// --- Matcher mínimo dos formatos de where usados no sync de parceiros ---------------------------------
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
  ownerSeller: { name: sellers.find((seller) => seller.id === row.ownerSellerId)?.name ?? null },
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
setModel("timelineEvent", { create: async ({ data }: Row) => data });
setModel("clientCodeAudit", { create: async ({ data }: Row) => data });
setModel("user", {
  findFirst: async ({ where }: Row) =>
    sellers.find((seller) => (where.id ? seller.id === where.id : seller.erpLoginUsername) && seller.isActive === where.isActive) ?? null,
  findUnique: async ({ where }: Row) => sellers.find((seller) => seller.id === where.id) ?? null,
  findMany: async ({ where }: Row) => sellers.filter((seller) => seller.isActive === where.isActive && seller.erpCode),
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

// ERP fictício: VENDEDOR_DO_PARCEIRO "77" serve ao caminho global; o caminho por vendedor ignora.
const partner = (code: string, name: string, flags: Row) => ({ PARCEIRO: code, RAZAO_SOCIAL: name, CIDADE: "Cidade Ficticia", UF: "PR", VENDEDOR_DO_PARCEIRO: "77", ...flags });
const erpRows = [
  partner("7001", "Cliente Tambem Fornecedor Ficticio", { IDN_CLIENTE: "S", IDN_FORNECEDOR: "S", IDN_TRANSPORTADORA: "N", IDN_FUNCIONARIO: "N", IDN_VENDEDOR: "N" }),
  partner("7002", "Fornecedor Ficticio", { IDN_CLIENTE: "N", IDN_FORNECEDOR: "S" }),
  partner("7003", "Hotel Fornecedor Ficticio Renomeado", { IDN_CLIENTE: "N", IDN_FORNECEDOR: "S" }),
  partner("7004", "Cliente Minusculo Ficticio", { IDN_CLIENTE: "s" }),
  partner("7005", "Cliente Com Espaco Ficticio", { IDN_CLIENTE: " S " }),
  partner("7006", "Parceiro Sem Flag Ficticio", {}),
  partner("7007", "Fazenda Legada Ficticia", { IDN_CLIENTE: "S" }),
  partner("7008", "Funcionario Ficticio", { IDN_CLIENTE: "N", IDN_FUNCIONARIO: "S" }),
  partner("7009", "Cliente Arquivado Ficticio", { IDN_CLIENTE: "S" }),
];
(ultraFv3Client as any).hasGlobalCredentials = () => false;
(ultraFv3Client as any).requestWithCredentials = async (path: string) => {
  assert.ok(path.startsWith("/partners"), path);
  return erpRows;
};

const byCode = (code: string) => clients.filter((client) => client.code === code && !client.isArchived);
const supplierUntouched = () => {
  const supplier = clients.find((client) => client.id === "existing-supplier")!;
  assert.equal(supplier.ownerSellerId, "seller-antigo", "dono do fornecedor existente não muda");
  assert.equal(supplier.name, "Hotel Fornecedor Ficticio", "dados do fornecedor existente não mudam");
  assert.equal(supplier.erpUpdatedAt, OLD_DATE, "'Atualizado em' do fornecedor existente não muda");
};

const sync = await import("./ultraFv3SyncService.js");

// ---------------------------------------------------------------------------------------------------
// 1) Por vendedor, sem autenticação (scheduler / Sincronização Completa)
// ---------------------------------------------------------------------------------------------------
resetClients();
let result = await sync.syncPartnersByUser("seller-novo");
assert.equal(byCode("7001").length, 1, "cliente que também é fornecedor é importado");
assert.equal(byCode("7002").length, 0, "fornecedor (N) não é criado");
supplierUntouched();
assert.equal(byCode("7004").length, 1, "'s' minúsculo conta como S");
assert.equal(byCode("7005").length, 1, "' S ' com espaço conta como S");
assert.equal(byCode("7006").length, 0, "campo ausente: ignorado");
assert.equal(byCode("7007").length, 1, "legado cliente sem tenant: a proteção do #946 impede a duplicata");
assert.equal(byCode("7007")[0].id, "legacy-customer");
assert.equal(byCode("7007")[0].tenantId, null);
assert.equal(clients.find((client) => client.id === "legacy-supplier")!.ownerSellerId, "seller-antigo", "legado não-cliente não é tocado");
assert.equal(byCode("7008").length, 1);
assert.equal(byCode("7009").length, 1, "arquivado que volta com S é reativado, como hoje");
assert.equal(byCode("7009")[0].id, "archived-customer");
assert.equal(result.diagnostics?.skippedNotCustomer, 3, "7002, 7003 e 7008");
assert.equal(result.diagnostics?.skippedCustomerFlagMissing, 1, "7006");
assert.equal(result.diagnostics?.legacyTenantAdoptionRequired, 1, "só o legado que é cliente conta para o #946");
let run = runs.at(-1)!;
assert.equal(run.status, "success");
assert.equal(run.sellerId, "seller-novo", "contagens por vendedor no Histórico");
assert.equal(run.metrics.skippedNotCustomer, 3);
assert.equal(run.metrics.skippedCustomerFlagMissing, 1);
assert.match(run.errorMessage ?? "", /legacy_tenant_adoption_required/);
assert.match(run.errorMessage ?? "", /1 parceiro\(s\) sem o campo IDN_CLIENTE foram ignorados/, "campo ausente aparece como aviso");

// Sem campo ausente nem legado, não há aviso; N é só contagem.
const savedRows = erpRows.splice(0, erpRows.length, ...erpRows.filter((row) => !["7006", "7007"].includes(row.PARCEIRO)));
resetClients();
result = await sync.syncPartnersByUser("seller-novo");
assert.equal(result.diagnostics?.skippedCustomerFlagMissing ?? 0, 0);
assert.equal(runs.at(-1)!.errorMessage ?? null, null, "N sozinho não gera aviso");
erpRows.splice(0, erpRows.length, ...savedRows);

// ---------------------------------------------------------------------------------------------------
// 2) Por vendedor, autenticado (botão): mesmo filtro; legado cliente é adotado, não-cliente não.
// ---------------------------------------------------------------------------------------------------
resetClients();
result = await sync.syncPartnersByUser("seller-novo", { authenticatedTenantId: TENANT, authenticatedActorUserId: "diretor-ficticio" });
assert.equal(byCode("7002").length, 0);
supplierUntouched();
const adopted = clients.find((client) => client.id === "legacy-customer")!;
assert.equal(adopted.tenantId, TENANT, "legado cliente adotado pelo botão");
assert.equal(adopted.ownerSellerId, "seller-novo");
const legacySupplier = clients.find((client) => client.id === "legacy-supplier")!;
assert.equal(legacySupplier.tenantId, null, "legado não-cliente não é adotado");
assert.equal(legacySupplier.ownerSellerId, "seller-antigo");
assert.equal(result.diagnostics?.skippedNotCustomer, 3);

// ---------------------------------------------------------------------------------------------------
// 3) Caminho global (credencial de referência, vendedor pelo VENDEDOR_DO_PARCEIRO)
// ---------------------------------------------------------------------------------------------------
resetClients();
result = await sync.syncPartners();
assert.equal(byCode("7001").length, 1);
assert.equal(byCode("7002").length, 0, "fornecedor não é criado no caminho global");
supplierUntouched();
assert.equal(byCode("7006").length, 0);
assert.equal(result.diagnostics?.skippedNotCustomer, 3);
assert.equal(result.diagnostics?.skippedCustomerFlagMissing, 1);
assert.equal(byCode("7007")[0].tenantId, null, "proteção do #946 também no caminho global");

// ---------------------------------------------------------------------------------------------------
// 4) Mutação: sem o filtro, o scheduler cria o fornecedor N.
// ---------------------------------------------------------------------------------------------------
const source = readFileSync(new URL("./ultraFv3SyncService.ts", import.meta.url), "utf8");
const mutated = source.replace(/\n[ \t]*\/\/ partner-customer-filter:begin[\s\S]*?\/\/ partner-customer-filter:end\n/, "\n");
assert.notEqual(mutated, source);
const mutatedUrl = new URL(`./ultraFv3SyncService.mutation-filter-${process.pid}.ts`, import.meta.url);
writeFileSync(mutatedUrl, mutated);
try {
  const unfiltered = await import(mutatedUrl.href);
  resetClients();
  await unfiltered.syncPartnersByUser("seller-novo");
  assert.equal(byCode("7002").length, 1, "sem o filtro, o fornecedor N vira cliente no CRM");
  assert.equal(clients.find((client) => client.id === "existing-supplier")!.ownerSellerId, "seller-novo", "e o fornecedor existente troca de dono");
} finally {
  rmSync(mutatedUrl, { force: true });
}

// Contrato estático: o filtro vem antes do persistPartnerPayload nos dois caminhos.
const perSeller = source.slice(source.indexOf("async function persistPartnerRowsForSeller"), source.indexOf("export async function syncPartners("));
assert.ok(perSeller.indexOf("classifyPartnerCustomerFlag") < perSeller.indexOf("persistPartnerPayload("));
const globalPath = source.slice(source.indexOf("export async function syncPartners("), source.indexOf("export async function syncPartnersByUser("));
assert.ok(globalPath.indexOf("classifyPartnerCustomerFlag") > 0 && globalPath.indexOf("classifyPartnerCustomerFlag") < globalPath.indexOf("persistPartnerPayload("));

await (prisma as any).$disconnect?.();
console.log("ULTRAFV3_PARTNERS_CUSTOMER_FLAG=PASS customer_and_supplier=imported supplier_n=skipped existing_n=untouched case_and_spaces=PASS missing=counted_and_warned legacy_guard_946=PASS reactivation=PASS global_path=PASS mutation_imports_supplier=DETECTED");
