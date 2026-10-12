import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

// Todos os dados abaixo são fictícios: vendedores, tenants, códigos e títulos.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = "test-only-financial-sync-key";

const merge = await import("./ultraFv3FinancialMerge.js");
const { prisma } = await import("../config/prisma.js");
const { encryptErpCredential } = await import("./erpCredentialCrypto.js");
const { ultraFv3Client } = await import("./ultraFv3Client.js");
const sync = await import("./ultraFv3SyncService.js");

type Row = Record<string, unknown>;
const codeOf = (row: Row) => String(row.PARCEIRO ?? "").trim();
const saldoOf = (row: Row) => Number(row.SALDO_CAPITAL ?? 0);
const noExclusions = { blockAll: false, excludedCodes: new Set<string>(), failedWithoutCoverage: 0 };
const fetchOf = (sellerId: string, rows: Row[], outcome: "success" | "empty" | "error" | "skipped" = rows.length ? "success" : "empty", tenantId: string | null = "tenant-a") =>
  ({ sellerId, tenantId, outcome, rows });

// ---------------------------------------------------------------------------------------------
// Regras puras de junção
// ---------------------------------------------------------------------------------------------

{
  // Chave de título: DOCTO + PARCELA normalizados; JSON canônico só quando faltar um deles.
  assert.equal(merge.partnerTitleDedupeKey({ DOCTO: "0012", PARCELA: " 01 " }), merge.partnerTitleDedupeKey({ DOCTO: 12, PARCELA: "1" }));
  assert.notEqual(merge.partnerTitleDedupeKey({ DOCTO: 12, PARCELA: "1" }), merge.partnerTitleDedupeKey({ DOCTO: 12, PARCELA: "2" }));
  assert.match(merge.partnerTitleDedupeKey({ DOCTO: 12, SALDO_CAPITAL: 1 }), /^json:/, "sem PARCELA usa JSON canônico");
  assert.equal(merge.canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), merge.canonicalJson({ a: [2, { c: 0, d: 1 }], b: 1 }));
}

{
  // Vendedores com códigos disjuntos: cada cliente recebe só os próprios dados.
  const clients = [
    { id: "c1", code: "100", tenantId: "tenant-a", ownerSellerId: "seller-a" },
    { id: "c2", code: "200", tenantId: "tenant-a", ownerSellerId: "seller-b" },
  ];
  const plan = merge.planPartnerTitleWrites({
    fetches: [fetchOf("seller-a", [{ PARCEIRO: "100", DOCTO: 1, PARCELA: 1, SALDO_CAPITAL: 10 }]), fetchOf("seller-b", [{ PARCEIRO: "200", DOCTO: 2, PARCELA: 1, SALDO_CAPITAL: 20 }])],
    clients, ownerTenantById: new Map(), exclusions: noExclusions, codeOf, saldoOf,
  });
  assert.deepEqual(plan.writes.map((write) => [write.clientIds, write.titles.map((title) => title.DOCTO)]), [[["c1"], [1]], [["c2"], [2]]]);
}

{
  // Mesmo título vindo de dois vendedores com SALDO_CAPITAL diferente: sobra um só.
  const sameTitleA = { PARCEIRO: "300", DOCTO: "77", PARCELA: "1", SALDO_CAPITAL: 50 };
  const sameTitleB = { PARCEIRO: "300", DOCTO: "077", PARCELA: "01", SALDO_CAPITAL: 80 };
  const otherTitle = { PARCEIRO: "300", DOCTO: "78", PARCELA: "1", SALDO_CAPITAL: 5 };
  const fetches = [fetchOf("seller-a", [sameTitleA]), fetchOf("seller-b", [sameTitleB, otherTitle])];

  // Dono é seller-a: vence a versão do dono, mesmo com saldo menor.
  const ownedByA = merge.planPartnerTitleWrites({
    fetches, clients: [{ id: "c3", code: "300", tenantId: "tenant-a", ownerSellerId: "seller-a" }],
    ownerTenantById: new Map(), exclusions: noExclusions, codeOf, saldoOf,
  });
  assert.equal(ownedByA.writes[0].titles.length, 2, "união sem duplicata");
  assert.equal(ownedByA.writes[0].titles.find((title) => merge.normalizeTitleKeyPart(title.DOCTO) === "77")?.SALDO_CAPITAL, 50);
  assert.equal(ownedByA.diagnostics.duplicateTitlesMerged, 1);

  // Dono fora das fontes: vence o maior saldo.
  const ownedByOther = merge.planPartnerTitleWrites({
    fetches, clients: [{ id: "c4", code: "300", tenantId: "tenant-a", ownerSellerId: "seller-z" }],
    ownerTenantById: new Map(), exclusions: noExclusions, codeOf, saldoOf,
  });
  const kept = ownedByOther.writes[0].titles.filter((title) => merge.normalizeTitleKeyPart(title.DOCTO) === "77");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].SALDO_CAPITAL, 80);
}

{
  // Perfil com conflito: prefere o do dono; primeiro recebido só como fallback.
  const fetches = [
    fetchOf("seller-a", [{ PARCEIRO: "400", VALOR_MEDIO: 1 }]),
    fetchOf("seller-b", [{ PARCEIRO: "400", VALOR_MEDIO: 2 }]),
  ];
  const plan = merge.planFinancialProfileWrites({
    fetches,
    clients: [
      { id: "owned-by-b", code: "400", tenantId: "tenant-a", ownerSellerId: "seller-b" },
      { id: "owned-by-other", code: "400", tenantId: "tenant-a", ownerSellerId: "seller-z" },
    ],
    ownerTenantById: new Map(), exclusions: noExclusions, codeOf,
  });
  const byClient = new Map(plan.writes.flatMap((write) => write.clientIds.map((id) => [id, write.profile.VALOR_MEDIO])));
  assert.equal(byClient.get("owned-by-b"), 2);
  assert.equal(byClient.get("owned-by-other"), 1);
  assert.equal(plan.diagnostics.profileConflicts, 1);
  assert.equal(plan.diagnostics.ownerSourcePreferred, 1);
  assert.equal(plan.diagnostics.firstReceivedFallback, 1);
}

{
  // Vendedor B devolve vazio: dados de A seguem sendo gravados e nada de B limpa cliente algum.
  const plan = merge.planPartnerTitleWrites({
    fetches: [fetchOf("seller-a", [{ PARCEIRO: "500", DOCTO: 1, PARCELA: 1, SALDO_CAPITAL: 9 }]), fetchOf("seller-b", [], "empty")],
    clients: [
      { id: "c5", code: "500", tenantId: "tenant-a", ownerSellerId: "seller-a" },
      { id: "c6", code: "600", tenantId: "tenant-a", ownerSellerId: "seller-b" },
    ],
    ownerTenantById: new Map(), exclusions: noExclusions, codeOf, saldoOf,
  });
  assert.deepEqual(plan.writes.map((write) => write.clientIds), [["c5"]], "cliente fora do retorno não é tocado");
}

{
  // Vendedor com falha: códigos dos clientes dele e os que ele já retornou ficam intocados.
  const clients = [
    { id: "a-client", code: "700", tenantId: "tenant-a", ownerSellerId: "seller-a" },
    { id: "b-client", code: "701", tenantId: "tenant-a", ownerSellerId: "seller-b" },
    { id: "c-client", code: "702", tenantId: "tenant-a", ownerSellerId: "seller-c" },
  ];
  const failed = new Set(["seller-b"]);
  const withCoverage = merge.resolveFinancialWriteExclusions({ failedSellerIds: failed, candidateClients: clients, coverageBySeller: { "seller-b": ["702"] } });
  assert.equal(withCoverage.blockAll, false);
  assert.deepEqual([...withCoverage.excludedCodes].sort(), ["701", "702"]);
  const plan = merge.planFinancialProfileWrites({
    fetches: [fetchOf("seller-a", [{ PARCEIRO: "700" }, { PARCEIRO: "701" }, { PARCEIRO: "702" }]), fetchOf("seller-b", [], "error"), fetchOf("seller-c", [{ PARCEIRO: "702" }])],
    clients, ownerTenantById: new Map(), exclusions: withCoverage, codeOf,
  });
  assert.deepEqual(plan.writes.flatMap((write) => write.clientIds), ["a-client"]);
  assert.equal(plan.diagnostics.clientsExcludedByFailedSeller, 2);

  // Sem cobertura anterior do vendedor que falhou: na dúvida, nada é gravado.
  const unknown = merge.resolveFinancialWriteExclusions({ failedSellerIds: failed, candidateClients: clients, coverageBySeller: {} });
  assert.equal(unknown.blockAll, true);
  const blocked = merge.planFinancialProfileWrites({
    fetches: [fetchOf("seller-a", [{ PARCEIRO: "700" }])], clients, ownerTenantById: new Map(), exclusions: unknown, codeOf,
  });
  assert.equal(blocked.writes.length, 0);
}

{
  // Tenant: fonte de outro tenant é ignorada; cliente legado sem tenant só com dono comprovado.
  const plan = merge.planFinancialProfileWrites({
    fetches: [fetchOf("seller-a", [{ PARCEIRO: "800" }], "success", "tenant-a"), fetchOf("seller-x", [{ PARCEIRO: "801" }], "success", "tenant-x")],
    clients: [
      { id: "other-tenant", code: "801", tenantId: "tenant-a", ownerSellerId: "seller-a" },
      { id: "legacy-proven", code: "800", tenantId: null, ownerSellerId: "seller-a" },
      { id: "legacy-unproven", code: "800", tenantId: null, ownerSellerId: "seller-unknown" },
    ],
    ownerTenantById: new Map([["seller-a", "tenant-a"]]), exclusions: noExclusions, codeOf,
  });
  assert.deepEqual(plan.writes.flatMap((write) => write.clientIds), ["legacy-proven"]);
  assert.equal(plan.diagnostics.clientsWithoutSameTenantSource, 1);
  assert.equal(plan.diagnostics.clientsWithoutProvenTenant, 1);
}

// ---------------------------------------------------------------------------------------------
// Job do botão "todos vendedores" com Prisma e ERP em memória
// ---------------------------------------------------------------------------------------------

type Lock = { scope: string; runId: string; lockedUntil: Date };
type Run = Record<string, any> & { id: string };
type ClientRow = { id: string; code: string; tenantId: string | null; ownerSellerId: string; isArchived: boolean; financialProfile?: unknown; partnerTitles?: unknown; openTitlesTotal?: number };

const locks = new Map<string, Lock>();
const runs: Run[] = [];
const appConfig = new Map<string, string>();
let clients: ClientRow[] = [];
const sellers = ["seller-a", "seller-b", "seller-c"].map((id, index) => ({
  id,
  name: `Vendedor Ficticio ${String.fromCharCode(65 + index)}`,
  erpCode: `90${index}`,
  erpLoginUsername: `login-${id}`,
  erpLoginPasswordEncrypted: encryptErpCredential(`senha-${id}`),
}));

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const inList = (value: unknown, filter: any) => (filter && typeof filter === "object" && "in" in filter ? filter.in.includes(value) : value === filter);

setModel("erpSyncLock", {
  create: async ({ data }: any) => {
    if (locks.has(data.scope)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    locks.set(data.scope, { scope: data.scope, runId: data.runId, lockedUntil: data.lockedUntil });
    return data;
  },
  updateMany: async ({ where, data }: any) => {
    const lock = locks.get(where.scope);
    if (!lock) return { count: 0 };
    const allowed = where.OR.some((condition: any) => (condition.lockedUntil ? lock.lockedUntil < condition.lockedUntil.lt : condition.runId === lock.runId));
    if (!allowed) return { count: 0 };
    Object.assign(lock, { runId: data.runId, lockedUntil: data.lockedUntil });
    return { count: 1 };
  },
  findUnique: async ({ where }: any) => locks.get(where.scope) ?? null,
  deleteMany: async ({ where }: any) => {
    const lock = locks.get(where.scope);
    if (lock && lock.runId === where.runId) {
      locks.delete(where.scope);
      return { count: 1 };
    }
    return { count: 0 };
  },
});
setModel("erpSyncRun", {
  create: async ({ data }: any) => {
    const run = { id: `run-${runs.length + 1}`, ...data };
    runs.push(run);
    return run;
  },
  update: async ({ where, data }: any) => Object.assign(runs.find((run) => run.id === where.id)!, data),
  findFirst: async ({ where }: any) => [...runs].reverse().find((run) => inList(run.scope, where.scope) && run.status === where.status) ?? null,
});
setModel("appConfig", {
  findUnique: async ({ where }: any) => (appConfig.has(where.key) ? { value: appConfig.get(where.key) } : null),
  upsert: async ({ where, update, create }: any) => {
    appConfig.set(where.key, appConfig.has(where.key) ? update.value : create.value);
    return {};
  },
});
setModel("user", {
  findMany: async () => sellers,
  findFirst: async ({ where }: any) => sellers.find((seller) => seller.id === where.id) ?? null,
});
setModel("tenantMembership", {
  findMany: async ({ where }: any) =>
    typeof where.userId === "string"
      ? [{ tenantId: "tenant-a" }]
      : where.userId.in.map((userId: string) => ({ userId, tenantId: "tenant-a" })),
});
setModel("client", {
  findMany: async ({ where }: any) => clients.filter((client) => inList(client.code, where.code) && client.isArchived === where.isArchived),
  count: async ({ where }: any) => clients.filter((client) => inList(client.code, where.code) && !client.isArchived).length,
  updateMany: async ({ where, data }: any) => {
    const matched = clients.filter((client) => inList(client.id, where.id) && !client.isArchived);
    matched.forEach((client) => Object.assign(client, data));
    return { count: matched.length };
  },
});

// ERP fictício: /partners vazio; financeiros por vendedor. Erro de timeout evita as esperas de retry.
let erpGate: Promise<void> = Promise.resolve();
const failing = new Set<string>();
const erpRows: Record<string, Record<string, Row[]>> = {};
(ultraFv3Client as any).hasGlobalCredentials = () => false;
(ultraFv3Client as any).requestWithCredentials = async (path: string, credentials: { username: string }) => {
  await erpGate;
  const sellerId = credentials.username.replace(/^login-/, "");
  if (path.startsWith("/partners")) return [];
  const scope = path.startsWith("/financialProfiles") ? "financialProfiles" : "partnerTitles";
  if (failing.has(`${sellerId}:${scope}`)) throw new Error("timeout simulado do ERP fictício");
  return erpRows[sellerId]?.[scope] ?? [];
};

const waitForRun = async (runId: string) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = runs.find((item) => item.id === runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job não terminou");
};
const reset = () => {
  locks.clear();
  runs.length = 0;
  appConfig.clear();
  failing.clear();
  erpGate = Promise.resolve();
};

{
  // Segundo POST com execução em andamento responde already_running sem iniciar nada.
  reset();
  clients = [];
  let release!: () => void;
  erpGate = new Promise<void>((resolve) => { release = resolve; });
  const first = await sync.startSellerPortfolioSyncJob();
  assert.equal(first.accepted, true);
  const runsBefore = runs.length;
  const second = await sync.startSellerPortfolioSyncJob();
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.status, "already_running");
  assert.equal(second.runId, first.runId, "aponta para a execução em andamento");
  assert.equal(runs.length, runsBefore, "segundo POST não cria ErpSyncRun");

  // O scheduler usa o mesmo lock: enquanto o botão roda, ele também não consegue iniciar.
  assert.equal((await sync.acquireSellerPortfolioLock("scheduler-run")).acquired, false);

  release();
  const finished = await waitForRun(first.runId);
  assert.notEqual(finished.status, "running");
  assert.equal(locks.has(sync.SELLER_PORTFOLIO_LOCK_SCOPE), false, "lock liberado ao final");
}

{
  // Lock expirado (API reiniciada no meio) permite nova execução.
  reset();
  locks.set(sync.SELLER_PORTFOLIO_LOCK_SCOPE, { scope: sync.SELLER_PORTFOLIO_LOCK_SCOPE, runId: "interrupted-run", lockedUntil: new Date(Date.now() - 1_000) });
  const job = await sync.startSellerPortfolioSyncJob();
  assert.equal(job.accepted, true);
  await waitForRun(job.runId);

  // Lock ainda válido bloqueia.
  locks.set(sync.SELLER_PORTFOLIO_LOCK_SCOPE, { scope: sync.SELLER_PORTFOLIO_LOCK_SCOPE, runId: "live-run", lockedUntil: new Date(Date.now() + 60_000) });
  assert.equal((await sync.startSellerPortfolioSyncJob()).alreadyRunning, true);
}

{
  // Falha de um vendedor não interrompe os demais, e os códigos dele ficam intocados.
  reset();
  clients = [
    { id: "client-a", code: "1001", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false },
    { id: "client-b", code: "1002", tenantId: "tenant-a", ownerSellerId: "seller-b", isArchived: false, financialProfile: { VALOR_MEDIO: 111 } },
    { id: "client-c", code: "1003", tenantId: "tenant-a", ownerSellerId: "seller-c", isArchived: false },
  ];
  Object.assign(erpRows, {
    "seller-a": { financialProfiles: [{ PARCEIRO: "1001", VALOR_MEDIO: 1 }], partnerTitles: [{ PARCEIRO: "1001", DOCTO: 1, PARCELA: 1, SALDO_CAPITAL: 10 }] },
    "seller-b": { financialProfiles: [{ PARCEIRO: "1002", VALOR_MEDIO: 2 }], partnerTitles: [] },
    "seller-c": { financialProfiles: [{ PARCEIRO: "1003", VALOR_MEDIO: 3 }, { PARCEIRO: "1002", VALOR_MEDIO: 999 }], partnerTitles: [{ PARCEIRO: "1003", DOCTO: 3, PARCELA: 1, SALDO_CAPITAL: 30 }] },
  });
  appConfig.set("erp.ultrafv3.financialProfiles.sellerCoverage", JSON.stringify({ "seller-b": ["1002"] }));
  failing.add("seller-b:financialProfiles");

  const job = await sync.startSellerPortfolioSyncJob();
  const run = await waitForRun(job.runId);
  assert.equal(run.status, "success");
  assert.equal(run.metrics.finalStatus, "partial");
  assert.match(run.errorMessage, /^Parcial: financialProfiles/);

  const profileRuns = runs.filter((item) => item.scope === "financialProfiles" && item.authMode === "seller");
  assert.deepEqual(profileRuns.map((item) => [item.sellerId, item.status]), [["seller-a", "success"], ["seller-b", "error"], ["seller-c", "success"]], "um ErpSyncRun por vendedor, em sequência");
  assert.ok(profileRuns.every((item) => typeof item.durationMs === "number"));
  const sellerReports = run.metrics.sellers.filter((item: any) => item.scope === "financialProfiles");
  assert.ok(sellerReports.every((item: any) => typeof item.durationMs === "number"), "duração por vendedor nas métricas");
  assert.ok(["partners", "financialProfiles", "partnerTitles"].every((scope) => typeof run.metrics.scopes[scope].durationMs === "number"), "duração por escopo nas métricas");

  assert.deepEqual(clients.find((client) => client.id === "client-a")?.financialProfile, { PARCEIRO: "1001", VALOR_MEDIO: 1 });
  assert.deepEqual(clients.find((client) => client.id === "client-c")?.financialProfile, { PARCEIRO: "1003", VALOR_MEDIO: 3 });
  assert.deepEqual(clients.find((client) => client.id === "client-b")?.financialProfile, { VALOR_MEDIO: 111 }, "cliente do vendedor com falha fica intocado");

  const aggregate = runs.find((item) => item.scope === "financialProfiles" && item.authMode === "all_sellers");
  assert.equal(aggregate?.status, "success");
  assert.equal(aggregate?.metrics.partial, 1);
  assert.equal(aggregate?.metrics.errorCount, 1);
  assert.match(aggregate?.errorMessage ?? "", /^Parcial:/);

  // partnerTitles sem falha na mesma rodada: grava A e C; B vazio não limpa nada.
  assert.equal(clients.find((client) => client.id === "client-a")?.openTitlesTotal, 10);
  assert.equal(clients.find((client) => client.id === "client-c")?.openTitlesTotal, 30);
  assert.equal(clients.find((client) => client.id === "client-b")?.partnerTitles, undefined);
}

// ---------------------------------------------------------------------------------------------
// Contratos estáticos de integração
// ---------------------------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const scheduler = read("../jobs/erpSyncScheduler.ts");
const service = read("./ultraFv3SyncService.ts");
const routes = read("../routes/crudRoutes.ts");
const panel = read("../../../web/src/components/settings/ErpIntegrationPanel.tsx");

assert.match(scheduler, /run: syncPartnersAcrossSellers/);
assert.match(scheduler, /run: syncFinancialProfilesAcrossSellers, nonCritical: true/);
assert.match(scheduler, /run: syncPartnerTitlesAcrossSellers, nonCritical: true/);
assert.match(scheduler, /acquireSellerPortfolioLock\(correlationId\)[\s\S]*skippedReason: lastAutomaticSkippedReason[\s\S]*automaticSyncRunning = true/, "scheduler pega o lock compartilhado antes de rodar");
assert.match(scheduler, /releaseSellerPortfolioLock\(correlationId\)/);
assert.match(service, /run: syncFinancialProfilesAcrossSellers, nonCritical: true/);
assert.match(service, /run: syncPartnerTitlesAcrossSellers, nonCritical: true/);
assert.match(service, /export async function syncProducts[\s\S]{0,120}resolveReferenceCredentials\(\)/, "catálogos seguem com o vendedor de referência");
assert.match(routes, /router\.post\("\/erp\/ultrafv3\/sync\/partners\/all-sellers", authorize\("diretor", "gerente"\), async[\s\S]{0,200}startSellerPortfolioSyncJob/, "mesmos perfis de antes");
assert.match(panel, /SELLER_PORTFOLIO_POLL_MAX_MS/);
assert.match(panel, /Sincronização em andamento, acompanhe pelo Histórico\./);

await (prisma as any).$disconnect?.();
console.log("UltraFV3 financial all-sellers sync tests passed");
