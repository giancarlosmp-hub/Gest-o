import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

// Dados fictícios: dois códigos no ERP para o mesmo parceiro. O ERP ficou com o código antigo; o novo, que tinha o
// documento no CRM, saiu do ERP. Antes de mesclar, a sincronização do código antigo é ambígua e não grava nada.
// Depois de "Mesclar duplicado", o código antigo recebe o documento e os dados atuais do ERP.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-merge-sync-key";

const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");
const { mergeClientDuplicate, MERGED_DUPLICATE_NAME_PREFIX } = await import("./clientDuplicateMerge.js");

type Row = Record<string, any>;
const TENANT = "tenant-ficticio";
const DOCUMENT = "10120230340";
const sellers: Row[] = [
  { id: "seller-ficticio", name: "Vendedor Ficticio", role: "vendedor", isActive: true, erpCode: "77", erpLoginUsername: "login-ficticio",
    erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia"), tenantMemberships: [{ tenantId: TENANT }] },
];
const OLD_DATE = new Date("2026-01-10T00:00:00Z");
const baseClient = (over: Row): Row => ({
  tenantId: TENANT, code: null, cnpj: null, cnpjNormalized: null, name: "Cliente Ficticio", nameNormalized: "cliente ficticio",
  city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "PR", region: "Sul", segment: null, isArchived: false,
  archiveReason: null, erpUpdatedAt: OLD_DATE, createdAt: new Date("2025-01-01T00:00:00Z"), ownerSellerId: "seller-ficticio", ...over,
});
const clients: Row[] = [
  baseClient({ id: "cadastro-antigo", code: "8101", name: "Nome Antigo Ficticio", nameNormalized: "nome antigo ficticio" }),
  baseClient({ id: "cadastro-novo", code: "8102", name: "Nome Atual Ficticio", nameNormalized: "nome atual ficticio",
    cnpj: DOCUMENT, cnpjNormalized: DOCUMENT, createdAt: new Date("2026-09-01T00:00:00Z") }),
];
const runs: Row[] = [];
const locks = new Map<string, Row>();
const appConfig = new Map<string, string>();

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
// Índice único parcial em cnpjNormalized, como no banco.
const assertUniqueDocument = () => {
  const docs = clients.map((c) => c.cnpjNormalized).filter(Boolean);
  if (new Set(docs).size !== docs.length) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
};
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const created: Row[] = [];
setModel("client", {
  findMany: async ({ where }: Row) => clients.filter((row) => matches(row, where)).map(withRelations),
  count: async ({ where }: Row) => clients.filter((row) => matches(row, where)).length,
  update: async ({ where, data }: Row) => { const row = clients.find((c) => c.id === where.id)!; applyUpdate(row, data); assertUniqueDocument(); return row; },
  updateMany: async ({ where, data }: Row) => {
    const matched = clients.filter((row) => matches(row, where));
    matched.forEach((row) => applyUpdate(row, data));
    return { count: matched.length };
  },
  create: async ({ data }: Row) => { const row = baseClient({ ...data, id: `criado-${created.length + 1}` }); created.push(row); clients.push(row); assertUniqueDocument(); return row; },
});
for (const model of ["opportunity", "activity", "timelineEvent", "contact", "agendaEvent", "agendaStop", "communicationConversation"]) {
  setModel(model, { updateMany: async () => ({ count: 0 }), count: async () => 0, create: async ({ data }: Row) => data });
}
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

// ERP fictício: só o código antigo existe, já com o documento e o nome atual.
const erpRows = [{ PARCEIRO: "8101", RAZAO_SOCIAL: "Nome Atual Ficticio", CPF_CNPJ: DOCUMENT, CIDADE: "Cidade Ficticia", UF: "PR",
  VENDEDOR_DO_PARCEIRO: "77", IDN_CLIENTE: "S" }];
(ultraFv3Client as any).hasGlobalCredentials = () => false;
(ultraFv3Client as any).requestWithCredentials = async (path: string) => {
  assert.ok(path.startsWith("/partners"), path);
  return erpRows;
};

const sync = await import("./ultraFv3SyncService.js");
const oldRecord = () => clients.find((c) => c.id === "cadastro-antigo")!;
const newRecord = () => clients.find((c) => c.id === "cadastro-novo")!;

// 1) Antes de mesclar: o documento está no cadastro novo com outro código. Ambíguo; nada é gravado.
let result = await sync.syncPartnersByUser("seller-ficticio");
assert.equal(result.diagnostics?.ambiguousDuplicates, 1, "código antigo fica ambíguo");
assert.equal(oldRecord().cnpjNormalized, null, "cadastro antigo não recebe o documento");
assert.equal(oldRecord().name, "Nome Antigo Ficticio", "cadastro antigo segue com dados velhos");
assert.equal(newRecord().cnpjNormalized, DOCUMENT);
assert.equal(created.length, 0);

// 2) "Mesclar duplicado": fica o cadastro cujo código continua no ERP.
await mergeClientDuplicate(prisma as unknown as Prisma.TransactionClient, {
  primary: oldRecord() as any,
  duplicate: newRecord() as any,
  actor: { id: "diretor-ficticio", email: "diretor@test.invalid", name: "Diretor Ficticio" },
  requestId: "req-ficticio",
  mergedAt: new Date("2026-11-05T12:00:00Z"),
});
assert.equal(newRecord().isArchived, true);
assert.equal(newRecord().cnpjNormalized, null);
assert.ok(newRecord().name.startsWith(MERGED_DUPLICATE_NAME_PREFIX));

// 3) Depois de mesclar: a sincronização do código antigo deixa de ser ambígua e grava documento e dados atuais.
result = await sync.syncPartnersByUser("seller-ficticio");
assert.equal(result.diagnostics?.ambiguousDuplicates ?? 0, 0, "não é mais ambíguo");
assert.equal(oldRecord().cnpjNormalized, DOCUMENT, "documento foi para o cadastro que fica");
assert.equal(oldRecord().name, "Nome Atual Ficticio", "dados atuais do ERP");
assert.equal(oldRecord().code, "8101");
assert.equal(oldRecord().isArchived, false);
assert.equal(newRecord().isArchived, true, "duplicado continua arquivado (não é reativado nem fundido de novo)");
assert.equal(newRecord().archiveReason, "MERGED_INTO:cadastro-antigo");
assert.equal(created.length, 0, "nenhum cadastro novo criado");

// O prefixo precisa ser o mesmo da fusão da sincronização (que o exclui dos candidatos).
const syncSource = readFileSync(resolve(process.cwd(), "src/services/ultraFv3SyncService.ts"), "utf8");
assert.ok(syncSource.includes(`const LEGACY_ARCHIVED_DUPLICATE_PREFIX = "${MERGED_DUPLICATE_NAME_PREFIX}";`), "mesmo prefixo da sincronização");

console.log("CLIENT_DUPLICATE_MERGE_SYNC=PASS before_merge=ambiguous after_merge=document_on_old_code no_new_client=PASS prefix=PASS");
