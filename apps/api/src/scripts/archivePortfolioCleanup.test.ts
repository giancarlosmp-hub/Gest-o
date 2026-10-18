import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType, OpportunityStage } from "@prisma/client";
import {
  ARCHIVE_REASON_PREFIX,
  CLOSED_STAGES,
  PARTNERS_CONFIG_KEY,
  PARTNERS_LAST_SEEN_CONFIG_KEY,
  PARTNER_CODE_KEYS,
  PARTNER_SELLER_CODE_KEYS,
  TIMELINE_TYPE_STATUS,
  applyArchive,
  archiveTimelineDescription,
  buildArchiveReason,
  isPendingOrder,
  loadArchiveInput,
  parseBackupFile,
  parseCliArgs,
  planPortfolioArchive,
  restoreFromBackup,
  runCli,
  summarizePlan,
  type ArchiveClient,
  type ArchiveDb,
  type TransactionRunner,
} from "./archivePortfolioCleanup.js";
import { isSystemTimeline } from "./simulateClientPortfolioCleanup.js";
import {
  PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX,
  buildPortfolioCleanupArchiveReason,
  portfolioCleanupArchiveTimelineDescription,
} from "../services/portfolioCleanupArchive.js";
import { orderStatusGroup } from "../services/orderStatusProjection.js";

// ---------------------------------------------------------------------------------------------
// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const scriptSource = source("./archivePortfolioCleanup.ts");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
assert.ok(specifiers.length > 0, "o teste de contrato precisa encontrar os imports");
for (const specifier of specifiers) {
  assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
}
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"], "único SQL cru é o READ ONLY da simulação");
assert.doesNotMatch(scriptSource, /\$executeRawUnsafe|\$queryRaw/, "sem SQL cru além do READ ONLY");

// Constantes espelhadas conferidas contra o código da sincronização e do arquivamento.
const sync = source("../services/ultraFv3SyncService.ts");
assert.ok(sync.includes(`const PARTNERS_CONFIG_KEY = "${PARTNERS_CONFIG_KEY}";`));
assert.ok(sync.includes(`const PARTNERS_LAST_SEEN_CONFIG_KEY = "${PARTNERS_LAST_SEEN_CONFIG_KEY}";`));
const codeBlock = /export const pickUltraFv3PartnerCode = [\s\S]*?\]\)\);/.exec(sync)?.[0] ?? "";
assert.deepEqual([...codeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_CODE_KEYS, "chaves do código do parceiro divergentes");
const sellerBlock = /const partnerSellerCodeKeys = \[[\s\S]*?\];/.exec(sync)?.[0] ?? "";
assert.deepEqual([...sellerBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_SELLER_CODE_KEYS, "chaves do vendedor do parceiro divergentes");
assert.ok(sync.includes('value.trim().replace(/^0+(?=\\d)/, "") || value.trim();'), "normalização do código do parceiro mudou");
assert.ok(sync.includes('return String(raw).trim().toUpperCase() === "S" ? "customer" : "not_customer";'), "regra do IDN_CLIENTE mudou");
assert.equal(ARCHIVE_REASON_PREFIX, PORTFOLIO_CLEANUP_ARCHIVE_REASON_PREFIX);
const sampleDate = new Date("2026-10-18T12:34:56.789Z");
assert.equal(buildArchiveReason(sampleDate), buildPortfolioCleanupArchiveReason(sampleDate), "motivo igual ao de buildPortfolioCleanupArchiveReason");
for (const rule of ["a", "b"] as const) {
  assert.equal(archiveTimelineDescription(rule), portfolioCleanupArchiveTimelineDescription(rule));
  assert.equal(archiveTimelineDescription(rule), `Cliente arquivado pela limpeza da carteira (regra ${rule})`);
  assert.ok(isSystemTimeline(archiveTimelineDescription(rule)), "a simulação conta o evento do arquivamento como sistema");
}
assert.equal(TIMELINE_TYPE_STATUS, EventType.status);
assert.deepEqual(CLOSED_STAGES, [OpportunityStage.ganho, OpportunityStage.perdido]);
// Pedido pendente = mesmo critério de orderStatusGroup (nem erro, nem cancelado, nem finalizado).
for (const status of ["pending", "sent", "error"]) {
  for (const raw of [null, "", "DIGITADO", "aceito", "EXPEDINDO", "FATURAR", "PARCIAL", "SUSPENSO", "FINALIZADO", "cancelado", "OUTRO"]) {
    for (const fulfillment of [null, "pendente", "faturado", "parcial", "cancelado", "entregue"]) {
      const group = orderStatusGroup(status, raw, fulfillment);
      assert.equal(isPendingOrder({ status, operationalStatusRaw: raw, orderStatus: fulfillment }), !["error", "cancelled", "finished"].includes(group), `${status}/${raw}/${fulfillment}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures fictícias.
type Row = Record<string, any>;
const NOW = new Date("2026-10-18T15:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const SEVEN_DAYS = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
const STALE = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
const users: Row[] = [
  { id: "u-ativo", name: "Vendedor Ativo Ficticio", isActive: true, erpCode: "77" },
  { id: "u-inativo", name: "Vendedor Inativo Ficticio", isActive: false, erpCode: "66" },
  { id: "u-inativo-2", name: "Outro Inativo Ficticio", isActive: false, erpCode: null },
];
const client = (id: string, code: string | null, ownerSellerId: string, over: Row = {}): Row => ({
  id, code, ownerSellerId, isArchived: false, archiveReason: null, tenantId: "tenant-ficticio", name: `Cliente ${id} Ficticio`,
  city: "Cidade Ficticia", state: "PR", lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: null, nota: "ficticio" }, ...over,
});
const clients: Row[] = [
  client("c-a1", "1001", "u-ativo"),
  client("c-a2", "01002", "u-inativo"),
  client("c-s", "1003", "u-inativo"),
  client("c-b-ausente", "1005", "u-inativo-2"),
  client("c-b-sem-usuario", "1006", "u-inativo"),
  client("c-b-vendedor-inativo", "1007", "u-inativo"),
  client("c-ausente-responsavel-ativo", "1008", "u-ativo"),
  client("c-sem-idn-vendedor-ativo", "1009", "u-inativo"),
  client("c-sem-idn-responsavel-ativo", "1010", "u-ativo"),
  client("c-desatualizado", "1011", "u-inativo"),
  client("c-sem-visto", "1012", "u-inativo"),
  client("c-oportunidade-aberta", "1013", "u-ativo"),
  client("c-oportunidades-fechadas", "1014", "u-ativo"),
  client("c-pedido-aceito", "1015", "u-inativo"),
  client("c-pedidos-encerrados", "1016", "u-ativo"),
  client("c-pedido-nao-enviado", "1017", "u-ativo"),
  client("c-sete-dias", "1018", "u-ativo"),
  client("c-sem-codigo", null, "u-inativo"),
  client("c-codigo-vazio", "  ", "u-inativo"),
  client("c-ja-arquivado", "1019", "u-inativo", { isArchived: true, archiveReason: "MERGED_INTO:c-a1" }),
  client("c-motivo-antigo", "1020", "u-ativo", { archiveReason: "legacy_duplicate_cleanup" }),
];
const partner = (code: string, over: Row = {}) => ({ PARCEIRO: code, RAZAO_SOCIAL: `Parceiro ${code} Ficticio`, VENDEDOR_DO_PARCEIRO: "77", ...over });
const cacheRows = [
  partner("1001", { IDN_CLIENTE: "N" }),
  partner("1002", { IDN_CLIENTE: " n " }),
  partner("1003", { IDN_CLIENTE: "S", VENDEDOR_DO_PARCEIRO: "999" }),
  partner("1006", { VENDEDOR_DO_PARCEIRO: "999" }),
  partner("1007", { VENDEDOR_DO_PARCEIRO: "066" }),
  partner("1009"),
  partner("1010", { VENDEDOR_DO_PARCEIRO: "999" }),
  partner("1011", { IDN_CLIENTE: "N" }),
  partner("1012", { IDN_CLIENTE: "N" }),
  partner("1013", { IDN_CLIENTE: "N" }),
  partner("1014", { IDN_CLIENTE: "N" }),
  partner("1016", { IDN_CLIENTE: "N" }),
  partner("1017", { IDN_CLIENTE: "N" }),
  partner("1018", { IDN_CLIENTE: "N" }),
  partner("1019", { IDN_CLIENTE: "N" }),
  partner("1020", { IDN_CLIENTE: "N" }),
];
const lastSeen: Record<string, string> = Object.fromEntries(cacheRows.map((row) => [row.PARCEIRO, FRESH]));
lastSeen["1011"] = STALE;
delete lastSeen["1012"];
lastSeen["1018"] = SEVEN_DAYS;
const opportunities: Row[] = [
  { id: "o-aberta", clientId: "c-oportunidade-aberta", stage: "negociacao" },
  { id: "o-ganha", clientId: "c-oportunidades-fechadas", stage: "ganho" },
  { id: "o-perdida", clientId: "c-oportunidades-fechadas", stage: "perdido" },
  { id: "o-pedido-aceito", clientId: "c-pedido-aceito", stage: "ganho" },
  { id: "o-pedidos-encerrados", clientId: "c-pedidos-encerrados", stage: "ganho" },
  { id: "o-pedido-nao-enviado", clientId: "c-pedido-nao-enviado", stage: "perdido" },
];
const orders: Row[] = [
  { id: "p-1", opportunityId: "o-pedido-aceito", status: "sent", operationalStatusRaw: "ACEITO", orderStatus: null },
  { id: "p-2", opportunityId: "o-pedidos-encerrados", status: "sent", operationalStatusRaw: "FINALIZADO", orderStatus: "entregue" },
  { id: "p-3", opportunityId: "o-pedidos-encerrados", status: "sent", operationalStatusRaw: "CANCELADO", orderStatus: null },
  { id: "p-4", opportunityId: "o-pedidos-encerrados", status: "error", operationalStatusRaw: null, orderStatus: null },
  { id: "p-5", opportunityId: "o-pedido-nao-enviado", status: "pending", operationalStatusRaw: null, orderStatus: null },
];
const timelineEvents: Row[] = [
  { id: "t-1", type: "comentario", description: "Anotação fictícia", clientId: "c-a1", opportunityId: null, ownerSellerId: "u-ativo", createdAt: new Date("2026-01-01T00:00:00.000Z") },
];

// ---------------------------------------------------------------------------------------------
// Banco em memória com a mesma interface mínima usada pelo script; transação desfaz em erro.
type Tables = { client: Row[]; user: Row[]; opportunity: Row[]; erpOrderSync: Row[]; timelineEvent: Row[]; appConfig: Row[] };
const initialTables = (): Tables => structuredClone({
  client: clients,
  user: users,
  opportunity: opportunities,
  erpOrderSync: orders,
  timelineEvent: timelineEvents,
  appConfig: [
    { key: PARTNERS_CONFIG_KEY, value: JSON.stringify(cacheRows) },
    { key: PARTNERS_LAST_SEEN_CONFIG_KEY, value: JSON.stringify(lastSeen) },
  ],
});
const fieldMatches = (value: unknown, condition: unknown) =>
  condition && typeof condition === "object" && !(condition instanceof Date) && "in" in (condition as object)
    ? (condition as { in: unknown[] }).in.includes(value)
    : value === condition;
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([key, condition]) => fieldMatches(row[key], condition));
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row));
const createDb = (initial: Tables) => {
  let tables = structuredClone(initial);
  let readOnly = false;
  const writes: string[] = [];
  const guardWrite = (name: string) => {
    if (readOnly) throw new Error("cannot execute in a read-only transaction");
    writes.push(name);
  };
  const delegate = (name: keyof Tables) => ({
    async findMany(args: Row = {}) { return tables[name].filter((row) => matches(row, args.where)).map((row) => pick(row, args.select)); },
    async findUnique(args: Row) { const row = tables[name].find((candidate) => matches(candidate, args.where)); return row ? pick(row, args.select) : null; },
    async updateMany(args: Row) {
      guardWrite(`${name}.updateMany`);
      const matched = tables[name].filter((row) => matches(row, args.where));
      matched.forEach((row) => Object.assign(row, args.data));
      return { count: matched.length };
    },
    async createMany(args: Row) {
      guardWrite(`${name}.createMany`);
      for (const row of args.data as Row[]) {
        if (tables[name].some((existing) => existing.id === row.id)) throw new Error("id duplicado");
        tables[name].push(structuredClone(row));
      }
      return { count: args.data.length };
    },
    async deleteMany(args: Row) {
      guardWrite(`${name}.deleteMany`);
      const before = tables[name].length;
      tables[name] = tables[name].filter((row) => !matches(row, args.where));
      return { count: before - tables[name].length };
    },
  });
  const db = {
    client: delegate("client"), user: delegate("user"), opportunity: delegate("opportunity"),
    erpOrderSync: delegate("erpOrderSync"), timelineEvent: delegate("timelineEvent"), appConfig: delegate("appConfig"),
  } as unknown as ArchiveDb;
  const run: TransactionRunner = async (fn) => {
    const snapshot = structuredClone(tables);
    try {
      return await fn(db);
    } catch (error) {
      tables = snapshot;
      throw error;
    }
  };
  const statements: string[] = [];
  const cliClient = (): ArchiveClient & { disconnected: boolean } => {
    const fake = {
      disconnected: false,
      async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
        const snapshot = structuredClone(tables);
        const tx = { ...db, $executeRaw: async (strings: TemplateStringsArray) => { statements.push(strings.join("?")); readOnly = true; return 0; } };
        try {
          return await fn(tx);
        } catch (error) {
          tables = snapshot;
          throw error;
        } finally {
          readOnly = false;
        }
      },
      async $disconnect() { fake.disconnected = true; },
    };
    return fake;
  };
  return { db, run, state: () => structuredClone(tables), writes, statements, cliClient };
};

// ---------------------------------------------------------------------------------------------
// Regra.
const initial = initialTables();
{
  const { db } = createDb(initial);
  const input = await loadArchiveInput(db);
  assert.equal(input.clients.length, clients.length - 1, "só carrega não arquivados");
  const plan = planPortfolioArchive(input, NOW);
  const decisionOf = (id: string) => plan.decisions.find((row) => row.client.id === id)!.decision;
  assert.deepEqual(plan.candidates.map(({ client: row, rule }) => [row.id, rule]).sort(), [
    ["c-a1", "a"], ["c-a2", "a"], ["c-b-ausente", "b"], ["c-b-sem-usuario", "b"], ["c-b-vendedor-inativo", "b"],
    ["c-motivo-antigo", "a"], ["c-oportunidades-fechadas", "a"], ["c-pedidos-encerrados", "a"], ["c-sete-dias", "a"],
  ]);
  // Regra a: IDN_CLIENTE = N (sem diferenciar maiúsculas, código com zero à esquerda), qualquer responsável.
  assert.deepEqual(decisionOf("c-a1"), { kind: "candidato", rule: "a", detail: "idnClienteN" });
  assert.deepEqual(decisionOf("c-a2"), { kind: "candidato", rule: "a", detail: "idnClienteN" });
  // Regra b: ausente do cache, ou linha sem IDN_CLIENTE com vendedor do ERP sem usuário ativo, e responsável inativo.
  assert.deepEqual(decisionOf("c-b-ausente"), { kind: "candidato", rule: "b", detail: "ausenteDoCache" });
  assert.deepEqual(decisionOf("c-b-sem-usuario"), { kind: "candidato", rule: "b", detail: "vendedorErpSemUsuarioAtivo" });
  assert.deepEqual(decisionOf("c-b-vendedor-inativo"), { kind: "candidato", rule: "b", detail: "vendedorErpSemUsuarioAtivo" });
  assert.deepEqual(decisionOf("c-ausente-responsavel-ativo"), { kind: "naoCandidato", reason: "ausenteDoCacheComResponsavelAtivo" });
  assert.deepEqual(decisionOf("c-sem-idn-vendedor-ativo"), { kind: "naoCandidato", reason: "linhaSemIdnClienteComVendedorErpAtivo" });
  assert.deepEqual(decisionOf("c-sem-idn-responsavel-ativo"), { kind: "naoCandidato", reason: "linhaSemIdnClienteComResponsavelAtivo" });
  // IDN_CLIENTE = S nunca entra, mesmo com responsável inativo e vendedor do ERP sem usuário.
  assert.deepEqual(decisionOf("c-s"), { kind: "naoCandidato", reason: "idnClienteS" });
  // Cache com mais de 7 dias ou sem data de visto não decide; exatamente 7 dias ainda decide.
  assert.deepEqual(decisionOf("c-desatualizado"), { kind: "cacheDesatualizado", age: "vistaHaMaisDe7Dias" });
  assert.deepEqual(decisionOf("c-sem-visto"), { kind: "cacheDesatualizado", age: "semDataDeVisto" });
  assert.equal(decisionOf("c-sete-dias").kind, "candidato");
  // Oportunidade aberta e pedido pendente protegem; ganha/perdida e pedido finalizado/cancelado/recusado não.
  assert.deepEqual(decisionOf("c-oportunidade-aberta"), { kind: "protegido", rule: "a", detail: "idnClienteN", reasons: ["oportunidadeAberta"] });
  assert.deepEqual(decisionOf("c-pedido-aceito"), { kind: "protegido", rule: "b", detail: "ausenteDoCache", reasons: ["pedidoPendente"] });
  assert.deepEqual(decisionOf("c-pedido-nao-enviado"), { kind: "protegido", rule: "a", detail: "idnClienteN", reasons: ["pedidoPendente"] });
  assert.equal(decisionOf("c-oportunidades-fechadas").kind, "candidato");
  assert.equal(decisionOf("c-pedidos-encerrados").kind, "candidato");
  assert.deepEqual(decisionOf("c-sem-codigo"), { kind: "semCodigoErp" });
  assert.deepEqual(decisionOf("c-codigo-vazio"), { kind: "semCodigoErp" });

  const summary = summarizePlan(plan, input.users, NOW);
  assert.deepEqual(summary.candidatos, { total: 9, regraA: 6, regraB: 3, regraBAusenteDoCache: 1, regraBVendedorErpSemUsuarioAtivo: 2 });
  assert.deepEqual(summary.protegidos, { total: 3, porMotivo: { oportunidadeAberta: 1, pedidoPendente: 2 }, porRegra: { a: 2, b: 1 } });
  assert.deepEqual(summary.cacheDesatualizado, { total: 2, semDataDeVisto: 1, vistaHaMaisDe7Dias: 1 });
  assert.deepEqual(summary.naoCandidatos, {
    idnClienteS: 1, linhaSemIdnClienteComVendedorErpAtivo: 1, linhaSemIdnClienteComResponsavelAtivo: 1, ausenteDoCacheComResponsavelAtivo: 1, semCacheDoPartners: 0,
  });
  assert.equal(summary.semCodigoErp, 2);
  assert.equal(summary.naoArquivados, 20);
  assert.deepEqual(summary.candidatosPorVendedorResponsavel, [
    { vendedor: "Outro Inativo Ficticio", usuarioAtivo: false, regraA: 0, regraB: 1, total: 1 },
    { vendedor: "Vendedor Ativo Ficticio", usuarioAtivo: true, regraA: 5, regraB: 0, total: 5 },
    { vendedor: "Vendedor Inativo Ficticio", usuarioAtivo: false, regraA: 1, regraB: 2, total: 3 },
  ]);
  const printed = JSON.stringify(summary);
  for (const row of clients) {
    assert.ok(!printed.includes(row.id), `resumo vazou id ${row.id}`);
    assert.ok(!printed.includes(row.name), `resumo vazou nome ${row.name}`);
  }
  for (const code of ["1001", "1005", "1013"]) assert.ok(!printed.includes(code), `resumo vazou código ${code}`);
}

// Sem cache do /partners: nada é decidido (ausente do cache não vira regra b).
{
  const tables = initialTables();
  tables.appConfig = [];
  const { db } = createDb(tables);
  const input = await loadArchiveInput(db);
  const plan = planPortfolioArchive(input, NOW);
  assert.equal(plan.candidates.length, 0);
  const summary = summarizePlan(plan, input.users, NOW);
  assert.equal(summary.naoCandidatos.semCacheDoPartners, 18);
  assert.match(summary.avisos.join(" "), /Sem cache do \/partners/);
}

// Sem registro de data de visto: toda linha do cache conta como desatualizada; só a ausência decide.
{
  const tables = initialTables();
  tables.appConfig = tables.appConfig.filter((row) => row.key === PARTNERS_CONFIG_KEY);
  const { db } = createDb(tables);
  const input = await loadArchiveInput(db);
  const plan = planPortfolioArchive(input, NOW);
  assert.deepEqual(plan.candidates.map(({ client: row }) => row.id), ["c-b-ausente"]);
  assert.match(summarizePlan(plan, input.users, NOW).avisos.join(" "), /toda linha do cache conta como desatualizada/);
}

// ---------------------------------------------------------------------------------------------
// CLI: --apply exige a contagem e o diretório; o client só é criado depois da validação.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--restore=/b/x.json"]), { mode: "restore", file: "/b/x.json" });
assert.deepEqual(parseCliArgs(["--apply", "--expect-archive=9", "--backup-dir=/b"]), { mode: "apply", expected: 9, backupDir: "/b" });
const invalidArgs = [
  ["--apply"],
  ["--apply", "--backup-dir=/b"],
  ["--apply", "--expect-archive=9"],
  ["--apply", "--expect-archive=x", "--backup-dir=/b"],
  ["--apply", "--expect-archive=-1", "--backup-dir=/b"],
  ["--apply", "--expect-archive", "--backup-dir=/b"],
  ["--apply=1", "--expect-archive=9", "--backup-dir=/b"],
  ["--apply", "--expect-archive=9", "--expect-archive=9", "--backup-dir=/b"],
  ["--expect-archive=9"],
  ["--backup-dir=/b"],
  ["--restore"],
  ["--restore="],
  ["--apply", "--restore=/b/x.json"],
  ["--foo"],
];
for (const args of invalidArgs) {
  assert.throws(() => parseCliArgs(args), /uso: archivePortfolioCleanup/, JSON.stringify(args));
  let created = 0;
  await assert.rejects(runCli(args, () => { created += 1; throw new Error("não deveria criar o client"); }, () => undefined, NOW), /uso: archivePortfolioCleanup/);
  assert.equal(created, 0, `client criado com argumentos inválidos: ${JSON.stringify(args)}`);
}

// ---------------------------------------------------------------------------------------------
// Simulação, apply, idempotência e restore.
{
  const { db, run, state, writes, statements, cliClient } = createDb(initial);
  const backupDir = mkdtempSync(join(tmpdir(), "portfolio-cleanup-archive-"));

  // Simulação pela CLI: transação READ ONLY, só contagens, nada gravado.
  const printed: string[] = [];
  const fake = cliClient();
  await runCli([], () => fake, (line) => printed.push(line), NOW);
  assert.ok(fake.disconnected);
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.deepEqual(state(), initial, "simulação não grava");
  assert.equal(writes.length, 0);
  const simulation = JSON.parse(printed.join("\n")) as Row;
  assert.equal(simulation.modo, "simulação (nada foi gravado)");
  assert.equal(simulation.candidatos.total, 9);
  for (const row of clients) assert.ok(!printed.join("\n").includes(row.id), `simulação vazou ${row.id}`);

  // Contagem divergente: aborta sem gravar nem criar backup.
  await assert.rejects(applyArchive(run, { expected: 8, backupDir, now: NOW }), /Contagem divergente; nada foi gravado/);
  assert.deepEqual(state(), initial, "contagem divergente não grava nada");
  assert.equal(readdirSync(backupDir).length, 0, "contagem divergente não cria backup");
  assert.equal(writes.length, 0);

  // Falha no backup (diretório inexistente ou arquivo no lugar do diretório): aborta sem gravar.
  await assert.rejects(applyArchive(run, { expected: 9, backupDir: join(backupDir, "inexistente"), now: NOW }), /ENOENT/);
  const notADir = join(backupDir, "arquivo.txt");
  writeFileSync(notADir, "x");
  await assert.rejects(applyArchive(run, { expected: 9, backupDir: notADir, now: NOW }), /não é um diretório/);
  assert.deepEqual(state(), initial, "falha no backup não grava nada");
  assert.equal(writes.length, 0);

  // Apply pela CLI.
  const applied: string[] = [];
  await runCli(["--apply", "--expect-archive=9", `--backup-dir=${backupDir}`], () => cliClient(), (line) => applied.push(line), NOW);
  const result = JSON.parse(applied.join("\n")) as Row;
  assert.equal(result.arquivados, 9);
  const after = state();
  const archiveReason = buildPortfolioCleanupArchiveReason(NOW);
  const archivedIds = after.client.filter((row) => row.archiveReason === archiveReason).map((row) => row.id).sort();
  assert.deepEqual(archivedIds, ["c-a1", "c-a2", "c-b-ausente", "c-b-sem-usuario", "c-b-vendedor-inativo", "c-motivo-antigo", "c-oportunidades-fechadas", "c-pedidos-encerrados", "c-sete-dias"]);
  assert.ok(after.client.filter((row) => archivedIds.includes(row.id)).every((row) => row.isArchived === true));
  for (const row of after.client.filter((candidate) => !archivedIds.includes(candidate.id))) {
    assert.deepEqual(row, initial.client.find((original) => original.id === row.id), `${row.id} não pode mudar`);
  }
  const created = after.timelineEvent.filter((event) => event.id !== "t-1");
  assert.equal(created.length, 9, "um evento de sistema por cliente arquivado");
  for (const event of created) {
    const owner = initial.client.find((row) => row.id === event.clientId)!;
    const rule = ["c-b-ausente", "c-b-sem-usuario", "c-b-vendedor-inativo"].includes(event.clientId) ? "b" : "a";
    assert.equal(event.description, `Cliente arquivado pela limpeza da carteira (regra ${rule})`);
    assert.equal(event.type, "status");
    assert.equal(event.opportunityId, null);
    assert.equal(event.ownerSellerId, owner.ownerSellerId);
    assert.equal(new Date(event.createdAt).toISOString(), NOW.toISOString());
  }

  // Backup: estado anterior completo das linhas alteradas, modo de gravação exclusivo.
  const [backupName] = readdirSync(backupDir).filter((name) => name.endsWith(".json"));
  const backup = parseBackupFile(readFileSync(join(backupDir, backupName), "utf8"));
  assert.equal(result.backup, join(backupDir, backupName));
  assert.equal(backup.archiveReason, archiveReason);
  assert.equal(backup.clients.length, 9);
  for (const row of backup.clients) assert.deepEqual(row, initial.client.find((original) => original.id === row.id), "backup guarda todas as colunas");
  assert.equal(backup.clients.find((row) => row.id === "c-motivo-antigo")!.archiveReason, "legacy_duplicate_cleanup");
  assert.deepEqual(backup.timeline.map((event) => event.id).sort(), created.map((event) => event.id).sort());

  // Idempotente: nova simulação mostra 0; apply com 0 não grava nem cria backup.
  const again = planPortfolioArchive(await loadArchiveInput(db), NOW);
  assert.equal(again.candidates.length, 0);
  const writesBefore = writes.length;
  const noop = await applyArchive(run, { expected: 0, backupDir, now: new Date(NOW.getTime() + 1000) });
  assert.equal(noop.archived, 0);
  assert.equal(noop.backupFile, null);
  assert.equal(writes.length, writesBefore);
  assert.equal(readdirSync(backupDir).filter((name) => name.endsWith(".json")).length, 1);

  // Restore pela CLI: idêntico ao original.
  const restored: string[] = [];
  await runCli([`--restore=${join(backupDir, backupName)}`], () => cliClient(), (line) => restored.push(line), NOW);
  assert.deepEqual(JSON.parse(restored.join("\n")), { modo: "restore concluído", clientesRestaurados: 9, eventosRemovidos: 9 });
  const sortById = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  assert.deepEqual(sortById(state().client), sortById(initial.client), "restore devolve os clientes ao estado original");
  assert.deepEqual(state().timelineEvent, initial.timelineEvent, "restore remove só os eventos do arquivamento");
  assert.deepEqual(state(), initial);

  // Segundo restore: estado atual não é o pós-arquivamento; nada muda.
  await assert.rejects(restoreFromBackup(run, backup), /nada foi restaurado/);
  assert.deepEqual(state(), initial);
}

// Restore recusado se algum cliente mudou depois do apply (ex.: reativado pela sincronização).
{
  const { db, run, state } = createDb(initial);
  const backupDir = mkdtempSync(join(tmpdir(), "portfolio-cleanup-archive-"));
  const result = await applyArchive(run, { expected: 9, backupDir, now: NOW });
  const backup = parseBackupFile(readFileSync(result.backupFile!, "utf8"));
  await db.client.updateMany({ where: { id: "c-a1" }, data: { isArchived: false, archiveReason: null } });
  const before = state();
  await assert.rejects(restoreFromBackup(run, backup), /1 alterados\); nada foi restaurado/);
  assert.deepEqual(state(), before, "restore recusado não grava nada");
}

// Backup em formato inesperado é recusado antes de abrir transação.
assert.throws(() => parseBackupFile(JSON.stringify({ format: "outro" })), /formato inesperado/);
assert.throws(() => parseBackupFile(JSON.stringify({ format: "archivePortfolioCleanup/v1", archiveReason: "MERGED_INTO:x", clients: [], timeline: [] })), /formato inesperado/);
assert.throws(() => parseBackupFile(JSON.stringify({ format: "archivePortfolioCleanup/v1", archiveReason: buildArchiveReason(NOW), clients: [{ id: "x", isArchived: true }], timeline: [] })), /Backup incompleto/);

console.log("archivePortfolioCleanup tests passed");
