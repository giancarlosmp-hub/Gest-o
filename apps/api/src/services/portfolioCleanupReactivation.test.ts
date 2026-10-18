import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

// Dados fictícios: vendedores, tenant, códigos, nomes e datas inventados.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-portfolio-cleanup-key";

const archive = await import("./portfolioCleanupArchive.js");
const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");

// ---------------------------------------------------------------------------------------------------
// Regras puras: formato do motivo e "compra posterior ao arquivamento" no dia de Brasília.
// ---------------------------------------------------------------------------------------------------
const ARCHIVED_AT = new Date("2026-09-01T12:00:00.000Z"); // 01/09 09:00 em Brasília
const CLEANUP_REASON = archive.buildPortfolioCleanupArchiveReason(ARCHIVED_AT);
assert.equal(CLEANUP_REASON, "PORTFOLIO_CLEANUP:2026-09-01T12:00:00.000Z");
assert.equal(archive.parsePortfolioCleanupArchivedAt(CLEANUP_REASON)?.toISOString(), ARCHIVED_AT.toISOString());
assert.equal(archive.parsePortfolioCleanupArchivedAt("PORTFOLIO_CLEANUP:2026-09-01T12:00:00Z;lote-1")?.toISOString(), ARCHIVED_AT.toISOString(), "texto depois da data é ignorado");
assert.equal(archive.parsePortfolioCleanupArchivedAt("PORTFOLIO_CLEANUP:sem-data"), null);
assert.equal(archive.parsePortfolioCleanupArchivedAt("MERGED_INTO:cli-1"), null);
assert.equal(archive.isPortfolioCleanupArchiveReason("portfolio_cleanup:2026-09-01T12:00:00Z"), false, "prefixo exato");
assert.equal(archive.isPortfolioCleanupArchiveReason(null), false);

const planOf = (raw: unknown, reason = CLEANUP_REASON) => archive.planPortfolioCleanupPurchase(reason, raw);
assert.equal(planOf("2026-09-02T03:00:00.000Z").action, "reactivate", "00:00 do dia seguinte em Brasília");
assert.equal(planOf("2026-09-02T02:59:59.000Z").action, "updatePurchaseDate", "23:59 do mesmo dia em Brasília");
assert.equal(planOf("2026-09-01T20:00:00.000Z").action, "updatePurchaseDate", "mesmo dia, mais tarde: não é posterior");
assert.equal(planOf("2025-01-10T03:00:00.000Z").action, "updatePurchaseDate");
assert.deepEqual(planOf(undefined), { action: "none", reason: "semDataDeCompra" });
assert.deepEqual(planOf("  "), { action: "none", reason: "semDataDeCompra" });
assert.deepEqual(planOf("não é data"), { action: "none", reason: "semDataDeCompra" });
const unreadable = planOf("2026-10-01T03:00:00.000Z", "PORTFOLIO_CLEANUP:sem-data");
assert.equal(unreadable.action, "updatePurchaseDate");
assert.equal(unreadable.action === "updatePurchaseDate" && unreadable.reason, "dataDoArquivamentoIlegivel", "sem data no motivo: na dúvida, não reativa");

// ---------------------------------------------------------------------------------------------------
// Prisma e ERP em memória.
// ---------------------------------------------------------------------------------------------------
type Row = Record<string, any>;
const TENANT = "tenant-ficticio";
const OLD_DATE = new Date("2026-06-16T00:00:00Z");
const sellers: Row[] = [
  { id: "seller-novo", name: "Vendedor Novo Ficticio", role: "vendedor", isActive: true, erpCode: "77", erpLoginUsername: "login-seller-novo",
    erpLoginPasswordEncrypted: encryptErpCredential("senha-ficticia"), tenantMemberships: [{ tenantId: TENANT }] },
  { id: "seller-saiu", name: "Vendedor Desligado Ficticio", role: "vendedor", isActive: false, erpCode: "66", erpLoginUsername: null,
    erpLoginPasswordEncrypted: null, tenantMemberships: [{ tenantId: TENANT }] },
];

let clients: Row[] = [];
let timeline: Row[] = [];
let audits: Row[] = [];
const runs: Row[] = [];
const locks = new Map<string, Row>();
const appConfig = new Map<string, string>();
let idSeq = 0;
const baseClient = (over: Row): Row => ({
  tenantId: TENANT, code: null, cnpj: null, cnpjNormalized: null, name: "Cliente Ficticio", nameNormalized: "cliente ficticio",
  city: "Cidade Ficticia", cityNormalized: "cidade ficticia", state: "PR", region: "Sul", segment: null, isArchived: false,
  archiveReason: null, erpUpdatedAt: OLD_DATE, createdAt: new Date("2026-01-01T00:00:00Z"), ownerSellerId: "seller-novo",
  lastPurchaseDate: null, lastPurchaseValue: null, financialProfile: null, ...over,
});

const fieldMatches = (value: unknown, condition: unknown): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    const c = condition as Row;
    if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
    if ("in" in c) return c.in.includes(value);
    if ("startsWith" in c) return typeof value === "string" && (c.mode === "insensitive" ? value.toLowerCase().startsWith(String(c.startsWith).toLowerCase()) : value.startsWith(c.startsWith));
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
  updateMany: async ({ where, data }: Row) => {
    const matched = clients.filter((row) => matches(row, where));
    matched.forEach((row) => applyUpdate(row, data));
    return { count: matched.length };
  },
  create: async ({ data }: Row) => { const row = baseClient({ ...data, id: `created-${++idSeq}`, createdAt: new Date() }); clients.push(row); return row; },
});
setModel("timelineEvent", { create: async ({ data }: Row) => { timeline.push(data); return data; } });
setModel("clientCodeAudit", { create: async ({ data }: Row) => { audits.push(data); return data; } });
setModel("user", {
  findFirst: async ({ where }: Row) => sellers.find((seller) => matches(seller, where)) ?? null,
  findUnique: async ({ where }: Row) => sellers.find((seller) => seller.id === where.id) ?? null,
  findMany: async ({ where }: Row) => sellers.filter((seller) => matches(seller, where)),
});
setModel("tenantMembership", {
  findMany: async ({ where }: Row) =>
    typeof where.userId === "string" ? [{ tenantId: TENANT }] : where.userId.in.map((userId: string) => ({ userId, tenantId: TENANT })),
});
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
  findFirst: async () => null,
});
(prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
// Único SQL cru do /partners: a mescla do lastSeenAt dentro do UPDATE. O mock faz a mesma mescla (||).
const rawStatements: string[] = [];
(prisma as any).$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join("?");
  rawStatements.push(sql);
  assert.match(sql, /^\s*INSERT INTO "AppConfig"/, "SQL cru inesperado no teste");
  const [, key, value] = values as [string, string, string];
  const current = appConfig.get(key);
  const base = current && /^\s*\{/.test(current) ? JSON.parse(current) : {};
  appConfig.set(key, JSON.stringify({ ...base, ...JSON.parse(value) }));
  return 1;
};

const partnerRows: Row[] = [];
const financialRows: Row[] = [];
(ultraFv3Client as any).hasGlobalCredentials = () => false;
(ultraFv3Client as any).requestWithCredentials = async (path: string) => {
  if (path.startsWith("/partners")) return partnerRows;
  if (path.startsWith("/financialProfiles")) return financialRows;
  throw new Error(`endpoint inesperado no teste: ${path}`);
};

const sync = await import("./ultraFv3SyncService.js");
const byId = (id: string) => clients.find((client) => client.id === id)!;
const timelineOf = (id: string) => timeline.filter((event) => event.clientId === id).map((event) => event.description as string);
const PARTNER_REACTIVATION = "Cliente reativado automaticamente pela sincronização UltraFV3 por corresponder ao cadastro principal do ERP.";

// ---------------------------------------------------------------------------------------------------
// 1) Sincronização cadastral (/partners): arquivado pela limpeza não reativa; outros motivos como hoje.
// ---------------------------------------------------------------------------------------------------
const partner = (code: string, name: string, flags: Row = {}) =>
  ({ PARCEIRO: code, RAZAO_SOCIAL: name, CIDADE: "Cidade Nova Ficticia", UF: "SC", VENDEDOR_DO_PARCEIRO: "77", IDN_CLIENTE: "S", ...flags });
const resetPartnerScenario = () => {
  idSeq = 0;
  timeline = [];
  audits = [];
  appConfig.clear();
  clients = [
    baseClient({ id: "limpeza", code: "8001", isArchived: true, archiveReason: CLEANUP_REASON, ownerSellerId: "seller-saiu", name: "Cliente Limpeza Ficticio" }),
    baseClient({ id: "legado", code: "8002", isArchived: true, archiveReason: "legacy_duplicate_cleanup" }),
    baseClient({ id: "manual", code: "8003", isArchived: true, archiveReason: "manual_duplicate_merge" }),
    baseClient({ id: "sem-motivo", code: "8004", isArchived: true, archiveReason: null }),
    baseClient({ id: "fornecedor", code: "8005" }),
    baseClient({ id: "vendedor-sem-usuario", code: "8006" }),
    baseClient({ id: "vendedor-desligado", code: "8008" }),
    // Sem código no CRM: o /partners só acha pelo documento ou por nome + cidade + UF.
    baseClient({ id: "limpeza-documento", code: null, cnpj: "11.222.333/0001-81", cnpjNormalized: "11222333000181",
      isArchived: true, archiveReason: CLEANUP_REASON, name: "Cliente Documento Ficticio", nameNormalized: "cliente documento ficticio" }),
    baseClient({ id: "limpeza-identidade", code: null, isArchived: true, archiveReason: CLEANUP_REASON, name: "Cliente Identidade Ficticio",
      nameNormalized: "cliente identidade ficticio", city: "Cidade Nova Ficticia", cityNormalized: "cidade nova ficticia", state: "SC" }),
  ];
  partnerRows.splice(0, partnerRows.length,
    partner("8001", "Cliente Limpeza Ficticio Renomeado"),
    partner("8002", "Cliente Legado Ficticio"),
    partner("8003", "Cliente Manual Ficticio"),
    partner("8004", "Cliente Sem Motivo Ficticio"),
    partner("8005", "Fornecedor Ficticio", { IDN_CLIENTE: "N" }),
    partner("8006", "Cliente Vendedor Sem Usuario Ficticio", { VENDEDOR_DO_PARCEIRO: "999" }),
    partner("8007", "Fornecedor Novo Ficticio", { IDN_CLIENTE: "N", VENDEDOR_DO_PARCEIRO: "999" }),
    partner("8008", "Cliente Vendedor Desligado Ficticio", { VENDEDOR_DO_PARCEIRO: "066" }),
    partner("8101", "Cliente Documento Ficticio", { CNPJ: "11.222.333/0001-81" }),
    partner("8102", "Cliente Identidade Ficticio"),
  );
};
const expectPartnerOutcome = (label: string) => {
  const kept = byId("limpeza");
  assert.equal(kept.isArchived, true, `${label}: arquivado pela limpeza continua arquivado`);
  assert.equal(kept.archiveReason, CLEANUP_REASON, `${label}: motivo mantido`);
  assert.equal(kept.name, "Cliente Limpeza Ficticio Renomeado", `${label}: dados cadastrais atualizados`);
  assert.equal(kept.city, "Cidade Nova Ficticia", label);
  assert.equal(kept.ownerSellerId, "seller-novo", `${label}: vendedor do ERP atualizado`);
  assert.ok(!timelineOf("limpeza").includes(PARTNER_REACTIVATION), `${label}: sem evento de reativação`);
  // Duplicidade: o arquivado é encontrado (código, documento, nome + cidade + UF) e nenhum cliente novo é criado.
  assert.equal(clients.filter((client) => String(client.id).startsWith("created-")).length, 0, `${label}: nenhum cliente novo`);
  for (const [id, code] of [["limpeza", "8001"], ["limpeza-documento", "8101"], ["limpeza-identidade", "8102"]]) {
    const matched = clients.filter((client) => client.code === code);
    assert.deepEqual(matched.map((client) => client.id), [id], `${label}: ${code} casou com o arquivado ${id}`);
    assert.equal(matched[0].isArchived, true, `${label}: ${id} segue arquivado`);
    assert.equal(matched[0].archiveReason, CLEANUP_REASON, label);
    assert.ok(!timelineOf(id).includes(PARTNER_REACTIVATION), label);
  }
  for (const id of ["legado", "manual", "sem-motivo"]) {
    assert.equal(byId(id).isArchived, false, `${label}: ${id} reativado como hoje`);
    assert.equal(byId(id).archiveReason, null, label);
    assert.ok(timelineOf(id).includes(PARTNER_REACTIVATION), `${label}: ${id} com evento de reativação`);
  }
};
const lastSeen = () => JSON.parse(appConfig.get("erp.ultrafv3.partners.lastSeenAt") ?? "{}") as Record<string, string>;

{
  // Por vendedor (scheduler, botão e Sincronização Completa).
  resetPartnerScenario();
  const before = Date.now();
  const result = await sync.syncPartnersByUser("seller-novo");
  expectPartnerOutcome("por vendedor");
  assert.equal(result.diagnostics?.portfolioCleanupKeptArchived, 3);
  // Diagnóstico (só conta): 8005 com N; 8006 com vendedor 999 e 8008 com vendedor desligado. 8007 não existe no CRM.
  assert.equal(result.diagnostics?.existingClientsNotCustomer, 1);
  assert.equal(result.diagnostics?.existingClientsSellerWithoutActiveUser, 2);
  assert.equal(byId("fornecedor").name, "Cliente Ficticio", "diagnóstico não altera o cliente N");
  assert.equal(runs.at(-1)!.metrics.existingClientsNotCustomer, 1, "contagens no Histórico da rodada");
  // Cache: data de visto por parceiro, inclusive os N (o cache guarda o retorno bruto).
  const seen = lastSeen();
  assert.deepEqual(Object.keys(seen).sort(), ["8001", "8002", "8003", "8004", "8005", "8006", "8007", "8008", "8101", "8102"]);
  assert.ok(Object.values(seen).every((value) => Date.parse(value) >= before - 1000));

  // Próxima rodada sem 8001: a linha do cache fica, mas a data de visto não avança.
  const old = "2026-01-01T00:00:00.000Z";
  appConfig.set("erp.ultrafv3.partners.lastSeenAt", JSON.stringify({ ...seen, "8001": old, "9999": old }));
  partnerRows.splice(0, 1);
  await sync.syncPartnersByUser("seller-novo");
  const next = lastSeen();
  assert.equal(next["8001"], old, "parceiro que não veio mantém a data antiga");
  assert.equal(next["9999"], old, "datas anteriores são preservadas");
  assert.ok(Date.parse(next["8002"]) > Date.parse(old));
  assert.ok((JSON.parse(appConfig.get("erp.ultrafv3.partners")!) as Row[]).some((row) => row.PARCEIRO === "8001"), "linha antiga continua no cache");

  // A data de visto é mesclada pelo próprio banco (um INSERT ... ON CONFLICT por rodada), sem leitura antes.
  rawStatements.length = 0;
  await sync.syncPartnersByUser("seller-novo");
  assert.equal(rawStatements.length, 1, "uma gravação de data de visto por rodada");
  assert.match(rawStatements[0], /ON CONFLICT \("key"\) DO UPDATE SET/);
  assert.match(rawStatements[0], /\|\| EXCLUDED\."value"::jsonb/, "mescla dentro do UPDATE");
  assert.ok(!rawStatements[0].includes("\\"), "sem barra invertida no SQL (o Prisma a remove)");
  // Rodada vazia não grava data de visto.
  const savedRows = partnerRows.splice(0, partnerRows.length);
  rawStatements.length = 0;
  await sync.syncPartnersByUser("seller-novo");
  assert.equal(rawStatements.length, 0);
  partnerRows.push(...savedRows);
}

{
  // Caminho global (credencial de referência, vendedor pelo VENDEDOR_DO_PARCEIRO).
  resetPartnerScenario();
  const result = await sync.syncPartners();
  expectPartnerOutcome("global");
  assert.equal(result.diagnostics?.portfolioCleanupKeptArchived, 3);
  assert.equal(result.diagnostics?.existingClientsNotCustomer, 1);
  assert.equal(result.diagnostics?.existingClientsSellerWithoutActiveUser, 2);
}

{
  // Todos os vendedores: contagens somadas no resumo.
  resetPartnerScenario();
  const summary = await sync.syncPartnersForAllConfiguredSellers();
  assert.equal(summary.portfolioCleanupKeptArchived, 3);
  assert.equal(summary.existingClientsNotCustomer, 1);
  assert.equal(summary.existingClientsSellerWithoutActiveUser, 2);
}

// ---------------------------------------------------------------------------------------------------
// 2) Sincronização financeira: reativa só com compra posterior ao arquivamento.
// ---------------------------------------------------------------------------------------------------
const REACTIVATION = archive.PORTFOLIO_CLEANUP_REACTIVATION_DESCRIPTION;
const resetFinancialScenario = () => {
  timeline = [];
  audits = [];
  appConfig.clear();
  clients = [
    baseClient({ id: "compra-posterior", code: "9001", isArchived: true, archiveReason: CLEANUP_REASON, ownerSellerId: "seller-saiu" }),
    baseClient({ id: "compra-mesmo-dia", code: "9002", isArchived: true, archiveReason: CLEANUP_REASON }),
    baseClient({ id: "compra-anterior", code: "9003", isArchived: true, archiveReason: CLEANUP_REASON }),
    baseClient({ id: "outro-motivo", code: "9004", isArchived: true, archiveReason: "legacy_duplicate_cleanup" }),
    baseClient({ id: "motivo-sem-data", code: "9005", isArchived: true, archiveReason: "PORTFOLIO_CLEANUP:sem-data" }),
    baseClient({ id: "ativo", code: "9006" }),
    baseClient({ id: "sem-data-de-compra", code: "9007", isArchived: true, archiveReason: CLEANUP_REASON }),
    baseClient({ id: "fusao", code: "9008", isArchived: true, archiveReason: "MERGED_INTO:ativo" }),
  ];
  financialRows.splice(0, financialRows.length,
    { PARCEIRO: "9001", DATA_ULTFATURA: "2026-09-02T03:00:00.000Z", VALOR_ULTFATURA: 10, VALOR_MEDIO: 1 },
    { PARCEIRO: "9002", DATA_ULTFATURA: "2026-09-01T20:00:00.000Z", VALOR_ULTFATURA: 10 },
    { PARCEIRO: "9003", DATA_ULTFATURA: "2025-01-10T03:00:00.000Z", VALOR_ULTFATURA: 10 },
    { PARCEIRO: "9004", DATA_ULTFATURA: "2026-10-01T03:00:00.000Z", VALOR_ULTFATURA: 10 },
    { PARCEIRO: "9005", DATA_ULTFATURA: "2026-10-01T03:00:00.000Z", VALOR_ULTFATURA: 10 },
    { PARCEIRO: "9006", DATA_ULTFATURA: "2026-10-01T03:00:00.000Z", VALOR_ULTFATURA: 25, VALOR_MEDIO: 7 },
    { PARCEIRO: "9007", VALOR_MEDIO: 3 },
    { PARCEIRO: "09008", DATA_ULTFATURA: "2026-10-01T03:00:00.000Z" },
  );
};
const expectFinancialOutcome = (label: string, diagnostics: Record<string, unknown> | undefined) => {
  const reactivated = byId("compra-posterior");
  assert.equal(reactivated.isArchived, false, `${label}: compra posterior reativa`);
  assert.equal(reactivated.archiveReason, null, label);
  assert.equal(reactivated.lastPurchaseDate.toISOString(), "2026-09-02T03:00:00.000Z", label);
  assert.equal(reactivated.financialProfile, null, `${label}: demais dados financeiros de arquivado não são gravados`);
  assert.equal(reactivated.lastPurchaseValue, null, label);
  assert.deepEqual(timelineOf("compra-posterior"), [REACTIVATION], `${label}: timeline`);
  const audit = audits.filter((row) => row.clientId === "compra-posterior");
  assert.equal(audit.length, 1, `${label}: auditoria`);
  assert.equal(audit[0].origin, archive.PORTFOLIO_CLEANUP_REACTIVATION_AUDIT_ORIGIN);
  assert.deepEqual(audit[0].metadata, { operation: "portfolio_cleanup_reactivation", archivedAt: ARCHIVED_AT.toISOString(), lastPurchaseDate: "2026-09-02T03:00:00.000Z" });

  for (const [id, purchase] of [["compra-mesmo-dia", "2026-09-01T20:00:00.000Z"], ["compra-anterior", "2025-01-10T03:00:00.000Z"], ["motivo-sem-data", "2026-10-01T03:00:00.000Z"]]) {
    const kept = byId(id);
    assert.equal(kept.isArchived, true, `${label}: ${id} não reativa`);
    assert.equal(kept.archiveReason, clients.find((client) => client.id === id)!.archiveReason, label);
    assert.equal(kept.lastPurchaseDate?.toISOString(), purchase, `${label}: ${id} com a última compra atualizada`);
    assert.equal(kept.financialProfile, null, label);
    assert.deepEqual(timelineOf(id), [], label);
  }
  assert.equal(byId("motivo-sem-data").archiveReason, "PORTFOLIO_CLEANUP:sem-data");
  for (const id of ["outro-motivo", "fusao"]) {
    assert.equal(byId(id).isArchived, true, `${label}: ${id} (outro motivo) segue como hoje`);
    assert.equal(byId(id).lastPurchaseDate, null, `${label}: ${id} não recebe a última compra`);
  }
  assert.equal(byId("sem-data-de-compra").lastPurchaseDate, null);
  assert.equal(byId("sem-data-de-compra").isArchived, true);
  assert.deepEqual(byId("ativo").financialProfile, financialRows.find((row) => row.PARCEIRO === "9006"), `${label}: não arquivado como hoje`);
  assert.equal(byId("ativo").lastPurchaseValue, 25);
  assert.equal(audits.length, 1, `${label}: só a reativação audita`);
  assert.equal(diagnostics?.portfolioCleanupArchivedMatched, 5, label);
  assert.equal(diagnostics?.portfolioCleanupReactivated, 1, label);
  assert.equal(diagnostics?.portfolioCleanupPurchaseDateUpdated, 4, label);
  assert.equal(diagnostics?.portfolioCleanupWithoutPurchaseDate, 1, label);
  assert.equal(diagnostics?.portfolioCleanupArchiveDateUnreadable, 1, label);
};

{
  // Credencial de referência (rodada única).
  resetFinancialScenario();
  const result = await sync.syncFinancialProfiles();
  expectFinancialOutcome("referência", result.diagnostics);
  // Rodada seguinte: o reativado é não arquivado e recebe o perfil como os demais; ninguém reativa de novo.
  const second = await sync.syncFinancialProfiles();
  assert.equal(second.diagnostics?.portfolioCleanupReactivated, 0);
  assert.deepEqual(byId("compra-posterior").financialProfile, financialRows[0]);
  assert.deepEqual(timelineOf("compra-posterior"), [REACTIVATION], "sem evento repetido");
}

{
  // Todos os vendedores (sem credencial global).
  resetFinancialScenario();
  const result = await sync.syncFinancialProfilesAcrossSellers();
  expectFinancialOutcome("todos os vendedores", result.diagnostics);
}

{
  // Cliente que mudou entre a leitura e a gravação (ex.: reativado à mão): o where não casa e nada é gravado.
  resetFinancialScenario();
  const realFindMany = (prisma as any).client.findMany;
  (prisma as any).client.findMany = async (args: Row) => {
    const rows = await realFindMany(args);
    if (args.where?.archiveReason) byId("compra-posterior").archiveReason = null;
    return rows;
  };
  try {
    const result = await sync.syncFinancialProfiles();
    assert.equal(result.diagnostics?.portfolioCleanupReactivated, 0);
    assert.deepEqual(timelineOf("compra-posterior"), []);
    assert.equal(audits.length, 0);
  } finally {
    (prisma as any).client.findMany = realFindMany;
  }
}

await (prisma as any).$disconnect?.();
console.log("PORTFOLIO_CLEANUP_REACTIVATION=PASS partners_keep_archive=PASS other_reasons_unchanged=PASS later_purchase_reactivates=PASS earlier_or_same_day_kept=PASS round_counts=PASS last_seen_cache=PASS");
