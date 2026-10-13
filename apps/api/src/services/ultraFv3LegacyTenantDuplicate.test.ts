import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

// Dados fictícios: vendedores, tenant, códigos, nomes e documento inventados.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-legacy-tenant-key";

const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");

type Row = Record<string, any>;
const TENANT = "tenant-ficticio";
const sellers: Row[] = [
  { id: "seller-novo", name: "Vendedor Novo Ficticio", role: "vendedor", isActive: true, erpCode: "77", erpLoginUsername: "login-novo", erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia") },
  { id: "seller-desligado", name: "Vendedor Desligado Ficticio", role: "vendedor", isActive: false, erpCode: "66", erpLoginUsername: null, erpLoginPasswordEncrypted: null },
];
const VALID_DOCUMENT = "11222333000181"; // CNPJ fictício com dígitos válidos

let clients: Row[] = [];
let timeline: Row[] = [];
const runs: Row[] = [];
const locks = new Map<string, Row>();
const appConfig = new Map<string, string>();
let idSeq = 0;

const baseClient = (over: Row): Row => ({
  tenantId: null, code: null, cnpj: null, cnpjNormalized: null, name: "Cliente Ficticio", nameNormalized: "cliente ficticio",
  city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "PR", region: "Sul", segment: null, isArchived: false,
  archiveReason: null, erpUpdatedAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), ownerSellerId: "seller-desligado", ...over,
});
const resetClients = () => {
  idSeq = 0;
  timeline = [];
  clients = [
    // Legado sem tenant, do vendedor desligado, encontrado pelo código.
    baseClient({ id: "legacy-by-code", code: "5001", name: "Fazenda Legada Ficticia", nameNormalized: "fazenda legada ficticia" }),
    // Legado sem tenant encontrado só pelo documento (o ERP manda outro código).
    baseClient({ id: "legacy-by-doc", code: null, cnpj: "11.222.333/0001-81", cnpjNormalized: VALID_DOCUMENT, name: "Sitio Legado Ficticio", nameNormalized: "sitio legado ficticio" }),
  ];
};

// --- Matcher mínimo para os formatos de where usados no sync de parceiros --------------------------
const fieldMatches = (value: unknown, condition: unknown): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    const c = condition as Row;
    if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
    if ("in" in c) return c.in.includes(value);
    if ("startsWith" in c) return typeof value === "string" && value.toLowerCase().startsWith(String(c.startsWith).toLowerCase());
    if ("equals" in c) return value === c.equals;
  }
  return value === condition;
};
const matches = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "NOT") return Array.isArray(condition) ? !(condition as Row[]).some((part) => matches(row, part)) : !matches(row, condition as Row);
    return fieldMatches(row[key], condition);
  });
};
const withRelations = (row: Row) => ({
  ...row,
  ownerSeller: { name: sellers.find((seller) => seller.id === row.ownerSellerId)?.name ?? null },
  _count: { opportunities: row.id.startsWith("legacy") ? 1 : 0, timelineEvents: 0, activities: 0, contacts: 0, agendaEvents: 0, agendaStops: 0 },
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
setModel("user", {
  findFirst: async ({ where }: Row) => sellers.find((seller) => seller.id === where.id && seller.isActive === where.isActive) ?? null,
  findUnique: async ({ where }: Row) => sellers.find((seller) => seller.id === where.id) ?? null,
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

// ERP fictício: o vendedor novo agora devolve os dois parceiros legados e um parceiro inédito.
(ultraFv3Client as any).requestWithCredentials = async (path: string) => {
  assert.ok(path.startsWith("/partners"), path);
  return [
    { PARCEIRO: "5001", RAZAO_SOCIAL: "Fazenda Legada Ficticia", CIDADE: "Cidade Ficticia", UF: "PR", IDN_CLIENTE: "S" },
    { PARCEIRO: "5003", RAZAO_SOCIAL: "Sitio Legado Ficticio", CNPJ: "11.222.333/0001-81", CIDADE: "Cidade Ficticia", UF: "PR", IDN_CLIENTE: "S" },
    { PARCEIRO: "5002", RAZAO_SOCIAL: "Cliente Novo Ficticio", CIDADE: "Outra Cidade Ficticia", UF: "SC", IDN_CLIENTE: "S" },
  ];
};

const byCode = (code: string) => clients.filter((client) => client.code === code && !client.isArchived);

// ---------------------------------------------------------------------------------------------------
// 1) Rodada não autenticada (scheduler / Sincronização Completa): não cria duplicata dos legados.
// ---------------------------------------------------------------------------------------------------
const sync = await import("./ultraFv3SyncService.js");
resetClients();
let result = await sync.syncPartnersByUser("seller-novo");
assert.equal(byCode("5001").length, 1, "o legado com o mesmo código continua único");
assert.equal(byCode("5001")[0].id, "legacy-by-code");
assert.equal(byCode("5001")[0].ownerSellerId, "seller-desligado", "sem autenticação o legado não é adotado nem trocado de dono");
assert.equal(byCode("5001")[0].tenantId, null);
assert.equal(clients.filter((client) => client.cnpjNormalized === VALID_DOCUMENT).length, 1, "nenhum cliente novo com o documento do legado");
assert.equal(byCode("5003").length, 0, "o parceiro achado pelo documento do legado também não é criado");
assert.equal(byCode("5002").length, 1, "parceiro sem legado continua sendo criado normalmente");
assert.equal(byCode("5002")[0].tenantId, TENANT);
assert.equal(result.diagnostics?.legacyTenantAdoptionRequired, 2);
const schedulerRun = runs.at(-1)!;
assert.equal(schedulerRun.status, "success");
assert.match(schedulerRun.errorMessage ?? "", /^2 parceiro\(s\) com cliente legado sem tenant não foram criados \(legacy_tenant_adoption_required\)/, "aviso visível no Histórico");
assert.equal(schedulerRun.metrics.legacyTenantAdoptionRequired, 2);

// Rodar de novo não muda nada (nem cria, nem duplica).
await sync.syncPartnersByUser("seller-novo");
assert.equal(byCode("5001").length, 1);
assert.equal(clients.length, 3);

// ---------------------------------------------------------------------------------------------------
// 2) Botão autenticado: adota o tenant e troca o dono do MESMO cliente, sem duplicar.
// ---------------------------------------------------------------------------------------------------
resetClients();
result = await sync.syncPartnersByUser("seller-novo", { authenticatedTenantId: TENANT, authenticatedActorUserId: "diretor-ficticio" });
assert.equal(byCode("5001").length, 1);
assert.equal(byCode("5001")[0].id, "legacy-by-code", "é o mesmo cliente, com o histórico preservado");
assert.equal(byCode("5001")[0].ownerSellerId, "seller-novo");
assert.equal(byCode("5001")[0].tenantId, TENANT);
const legacyByDoc = clients.find((client) => client.id === "legacy-by-doc")!;
assert.equal(legacyByDoc.code, "5003", "o legado achado pelo documento recebe o código do ERP");
assert.equal(legacyByDoc.ownerSellerId, "seller-novo");
assert.equal(legacyByDoc.tenantId, TENANT);
assert.equal(clients.length, 3, "só o parceiro inédito foi criado");
assert.equal(result.diagnostics?.legacyTenantAdoptionRequired ?? 0, 0);
assert.ok(timeline.some((event) => /Vendedor alterado de Vendedor Desligado Ficticio para Vendedor Novo Ficticio/.test(event.description)), "troca de dono registrada na Timeline");
assert.equal(runs.at(-1)!.errorMessage ?? null, null, "sem aviso no caminho autenticado");

// ---------------------------------------------------------------------------------------------------
// 3) Mutação: sem a correção, o mesmo cenário do scheduler cria a duplicata.
// ---------------------------------------------------------------------------------------------------
const source = readFileSync(new URL("./ultraFv3SyncService.ts", import.meta.url), "utf8");
assert.match(source, /legacy-tenant-guard:begin[\s\S]*legacy-tenant-guard:end/);
const mutated = source.replace(/\n[ \t]*\/\/ legacy-tenant-guard:begin[\s\S]*?\/\/ legacy-tenant-guard:end\n/, "\n");
assert.notEqual(mutated, source);
assert.doesNotMatch(mutated, /hasLegacyClientWithoutTenant\(data, normalizedDocument\)\)/);
const mutatedUrl = new URL(`./ultraFv3SyncService.mutation-${process.pid}.ts`, import.meta.url);
writeFileSync(mutatedUrl, mutated);
try {
  const unguarded = await import(mutatedUrl.href);
  resetClients();
  await unguarded.syncPartnersByUser("seller-novo");
  assert.equal(byCode("5001").length, 2, "sem a correção, o scheduler cria um segundo cliente com o mesmo código");
  assert.equal(byCode("5001").filter((client) => client.tenantId === null).length, 1, "o legado continua sem tenant, com o dono antigo");
  assert.equal(clients.filter((client) => client.cnpjNormalized === VALID_DOCUMENT).length, 2, "e duplica também o parceiro achado pelo documento");
} finally {
  rmSync(mutatedUrl, { force: true });
}

// O aviso chega ao scheduler e à Sincronização Completa (não só ao run por vendedor).
const scheduler = readFileSync(new URL("../jobs/erpSyncScheduler.ts", import.meta.url), "utf8");
assert.match(scheduler, /stepResult\?\.diagnostics\?\.partial \?\? 0\) > 0 \|\| stepResult\?\.warning/);
assert.match(source, /result\.diagnostics\?\.partial \?\? 0\) > 0 \|\| result\.warning/);
assert.match(source, /summary\.legacyTenantAdoptionRequired \|\| summary\.skippedCustomerFlagMissing \? \[partnerSyncWarning\(summary\)/);
assert.match(source, /const partnerSyncWarning = [\s\S]*?diagnostics\.legacyTenantAdoptionRequired \? \[legacyTenantAdoptionWarning\(diagnostics\.legacyTenantAdoptionRequired\)\]/);

await (prisma as any).$disconnect?.();
console.log("ULTRAFV3_PARTNERS_LEGACY_TENANT=PASS scheduler_no_duplicate=PASS authenticated_adoption=PASS new_partner_created=PASS history_warning=PASS mutation_creates_duplicate=DETECTED");
