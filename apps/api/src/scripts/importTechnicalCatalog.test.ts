import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_CATEGORIES,
  BACKUP_FORMAT,
  CATALOG_FORMAT,
  DEFAULT_CATALOG_FILE,
  WRITTEN_FIELDS,
  applyImport,
  parseBackupFile,
  parseCatalogFile,
  parseCliArgs,
  planImport,
  restoreFromBackup,
  reviewCatalog,
  runCli,
  seedingKgHa,
  summarizePlan,
  type CatalogClient,
  type CatalogDb,
  type CatalogRow,
  type TransactionRunner,
} from "./importTechnicalCatalog.js";

// ---------------------------------------------------------------------------------------------
// Contrato: imports permitidos e único SQL cru.
const scriptSource = readFileSync(fileURLToPath(new URL("./importTechnicalCatalog.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) {
  assert.ok(specifier === "@prisma/client" || specifier === "@salesforce-pro/shared" || specifier.startsWith("node:"), `import não permitido: ${specifier}`);
}
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"], "único SQL cru é o READ ONLY");
assert.doesNotMatch(scriptSource, /\$executeRawUnsafe|\$queryRaw|\.delete(Many)?\(|\.upsert\(/, "o script nunca apaga e só usa create/update por slug");

// ---------------------------------------------------------------------------------------------
// A fórmula da revisão é a da calculadora e bate com a tabela publicada (300 sementes/m²).
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} ≠ ${expected}`);
close(seedingKgHa(3_000_000, 30, 100, 100), 90, "PMS 30 g, PG 100%");
close(seedingKgHa(3_000_000, 40, 90, 100), 133, "PMS 40 g, PG 90%");
close(seedingKgHa(3_000_000, 50, 80, 100), 188, "PMS 50 g, PG 80%");

// ---------------------------------------------------------------------------------------------
// Arquivo real do PR: válido, com as quatro categorias e sem alertas na revisão.
const realPayloads = parseCatalogFile(readFileSync(DEFAULT_CATALOG_FILE, "utf8"));
assert.ok(realPayloads.length >= 22);
assert.ok(realPayloads.every((item) => (ALLOWED_CATEGORIES as readonly string[]).includes(item.category)));
assert.ok(realPayloads.filter((item) => item.category === "Forrageiras").every((item) => item.populationTargetDefault === null), "forrageira sem população");
const realReview = reviewCatalog(realPayloads);
assert.deepEqual(realReview.alertas, [], "arquivo do PR sem alertas na revisão");
assert.ok(realReview.conferidas.every((item) => item.dentro), "toda cultura com conta fica dentro da faixa");

// ---------------------------------------------------------------------------------------------
// Fixtures fictícias.
const FONTES = { "FONTE-A": { orgao: "Órgão Fictício", titulo: "Publicação fictícia", ano: 2020, link: "https://example.invalid/a" } };
const sourced = (value: unknown) => ({ value, sources: ["FONTE-A"], detail: "Tabela fictícia." });
const empty = (value: unknown = null) => ({ value, reason: "Sem fonte fictícia." });
const culture = (slug: string, overrides: Record<string, unknown> = {}, campos: Record<string, unknown> = {}) => ({
  slug,
  label: `Cultura ${slug}`,
  category: "Grãos",
  notes: "Observação fictícia.",
  campos: {
    defaultKgHaMin: sourced(10),
    defaultKgHaMax: sourced(20),
    populationTargetDefault: sourced(200000),
    rowSpacingCmDefault: sourced(50),
    pmsDefault: sourced(60),
    germinationDefault: sourced(80),
    purityDefault: sourced(98),
    goalsJson: sourced({ grao: { min: 10, max: 15 } }),
    ...campos,
  },
  ...overrides,
});
const catalogText = (culturas: unknown[], fontes: unknown = FONTES) => JSON.stringify({ format: CATALOG_FORMAT, fontes, culturas });

// Validação do arquivo.
const ok = parseCatalogFile(catalogText([culture("cultura-a")]));
assert.equal(ok.length, 1);
assert.deepEqual(ok[0].goalsJson, { grao: { min: 10, max: 15 } });
const rejects = (culturas: unknown[], pattern: RegExp, message: string, fontes?: unknown) =>
  assert.throws(() => parseCatalogFile(catalogText(culturas, fontes)), pattern, message);
rejects([culture("cultura-a", {}, { pmsDefault: { value: 60 } })], /sem fonte/, "número sem fonte");
rejects([culture("cultura-a", {}, { pmsDefault: { value: 60, sources: ["OUTRA"], detail: "x" } })], /fonte desconhecida/, "fonte que não existe");
rejects([culture("cultura-a", {}, { pmsDefault: { value: 60, sources: ["FONTE-A"] } })], /sem detalhe/, "fonte sem detalhe");
rejects([culture("cultura-a", {}, { pmsDefault: { value: null } })], /vazio sem motivo/, "vazio sem motivo");
rejects([culture("cultura-a", {}, { goalsJson: { value: {} } })], /vazio sem motivo/, "objetivos vazios sem motivo");
rejects([culture("cultura-a", { category: "Silagem" })], /quatro padronizadas/, "categoria fora da lista");
rejects([culture("cultura-a"), culture("cultura-a")], /repetido/, "slug repetido");
rejects([culture("cultura-a", {}, { defaultKgHaMax: empty() })], /juntos/, "faixa incompleta");
rejects([culture("cultura-a", { category: "Forrageiras" })], /não leva população/, "forrageira com população");
rejects([culture("cultura-a", {}, { germinationDefault: sourced(120) })], /cultura-a:/, "germinação acima de 100 (schema do shared)");
rejects([culture("cultura-a", {}, { goalsJson: sourced({ "Grão": { min: 1, max: 2 } }) })], /chave fora do padrão/, "chave de objetivo com acento");
rejects([culture("cultura-a", {}, { goalsJson: sourced({ grao: { min: 5, max: 2 } }) })], /faixa inválida/, "objetivo com máximo menor que mínimo");
rejects([culture("cultura-a", {}, { extra: sourced(1) })], /campo desconhecido/, "campo fora do modelo");
rejects([culture("cultura-a")], /sem órgão/, "fonte incompleta", { "FONTE-A": { orgao: "X", titulo: "", link: "https://example.invalid" } });
assert.throws(() => parseCatalogFile(JSON.stringify({ format: "outro", fontes: FONTES, culturas: [] })), /formato inesperado/);

// Revisão automática com dados fictícios.
const review = reviewCatalog(parseCatalogFile(catalogText([
  culture("dentro"), // 200.000 ÷ (0,8 × 0,98) × 60 g = 15,31 kg/ha → dentro de 10–20
  culture("fora", {}, { pmsDefault: sourced(200) }), // 51,02 kg/ha → fora de 10–20
  culture("sem-pms", {}, { pmsDefault: empty() }),
  culture("forrageira", { category: "Forrageiras" }, { populationTargetDefault: empty(), pmsDefault: sourced(50) }),
])));
assert.deepEqual(review.conferidas.map((item) => [item.slug, item.kgHa, item.dentro]), [["dentro", 15.31, true], ["fora", 51.02, false]]);
assert.deepEqual(review.conferidas[0].objetivos, { grao: false }, "objetivo grão 10–15 não contém 15,31");
assert.deepEqual(review.semConta.map((item) => item.slug), ["sem-pms", "forrageira"]);
assert.deepEqual(review.alertas.map((item) => item.slug), ["fora", "forrageira"], "fora da faixa e PMS alto para forrageira");

// ---------------------------------------------------------------------------------------------
// Banco falso.
type Store = Map<string, CatalogRow>;
const rowFrom = (slug: string, values: Partial<CatalogRow> = {}): CatalogRow => ({
  id: `id-${slug}`,
  slug,
  label: `Cultura ${slug}`,
  category: "Grãos",
  isActive: true,
  defaultKgHaMin: 10,
  defaultKgHaMax: 20,
  populationTargetDefault: 200000,
  rowSpacingCmDefault: 50,
  pmsDefault: 60,
  germinationDefault: 80,
  purityDefault: 98,
  notes: "Observação fictícia.",
  goalsJson: { grao: { min: 10, max: 15 } },
  ...values,
});
const fakeDb = (store: Store, log: string[] = []): CatalogDb => ({
  cultureCatalog: {
    async findMany(args) {
      const slugs = (args as { where: { slug: { in: string[] } } }).where.slug.in;
      log.push(`findMany:${slugs.length}`);
      return [...store.values()].filter((row) => slugs.includes(row.slug)).map((row) => structuredClone(row));
    },
    async create(args) {
      const data = (args as { data: CatalogRow }).data;
      assert.ok(!store.has(data.slug), "create só para slug novo");
      store.set(data.slug, { ...structuredClone(data), id: `id-${data.slug}` });
      log.push(`create:${data.slug}`);
      return { slug: data.slug };
    },
    async update(args) {
      const { where, data } = args as { where: { slug: string }; data: Partial<CatalogRow> };
      const row = store.get(where.slug);
      assert.ok(row, "update só de slug existente");
      store.set(where.slug, { ...row, ...structuredClone(data) });
      log.push(`update:${where.slug}`);
      return { slug: where.slug };
    },
  },
});
const inTransaction = (store: Store, log?: string[]): TransactionRunner => async (fn) => {
  // Transação de mentira: falha devolve o estado anterior.
  const snapshot = new Map([...store].map(([key, value]) => [key, structuredClone(value)]));
  try {
    return await fn(fakeDb(store, log));
  } catch (error) {
    store.clear();
    for (const [key, value] of snapshot) store.set(key, value);
    throw error;
  }
};

const payloads = parseCatalogFile(catalogText([
  culture("sem-mudanca"),
  culture("muda", { category: "Cobertura" }, { pmsDefault: empty(), goalsJson: sourced({ cobertura: { min: 12, max: 18 } }) }),
  culture("nova"),
]));
const baseStore = (): Store => new Map([
  ["sem-mudanca", rowFrom("sem-mudanca", { goalsJson: { grao: { max: 15, min: 10 } } })], // ordem das chaves não conta
  ["muda", rowFrom("muda", { isActive: false })],
  ["fora-do-arquivo", rowFrom("fora-do-arquivo", { label: "Intocada" })],
]);

const plan = planImport([...baseStore().values()].filter((row) => row.slug !== "fora-do-arquivo"), payloads);
assert.deepEqual(plan.unchanged, ["sem-mudanca"]);
assert.deepEqual(plan.toCreate.map((item) => item.slug), ["nova"]);
assert.deepEqual(plan.toUpdate.map((item) => [item.row.slug, item.changed]), [["muda", ["category", "pmsDefault", "goalsJson"]]]);
assert.deepEqual(summarizePlan(plan), {
  criar: 1,
  atualizar: 1,
  semMudanca: 1,
  expect: 2,
  camposQueFicamVazios: 1,
  inativasNoArquivo: 1,
  novas: ["nova"],
  camposPorCultura: { muda: ["category", "pmsDefault", "goalsJson"] },
  mudancasDeCategoria: ["muda"],
});
assert.ok(!JSON.stringify(summarizePlan(plan)).includes("Observação"), "resumo sem textos");

// Apply: contagem divergente não grava nada.
{
  const store = baseStore();
  const before = JSON.stringify([...store]);
  const dir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
  await assert.rejects(applyImport(inTransaction(store), payloads, { expected: 3, backupDir: dir }), /Contagem divergente/);
  assert.equal(JSON.stringify([...store]), before);
  assert.deepEqual(readdirSync(dir), [], "sem backup quando a contagem diverge");
}

// Apply: backup antes de gravar, só culturas do arquivo, isActive preservado.
const backupDir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
const store = baseStore();
const log: string[] = [];
const result = await applyImport(inTransaction(store, log), payloads, { expected: 2, backupDir, now: new Date("2026-11-18T12:00:00.000Z") });
assert.equal(result.gravadas, 2);
assert.deepEqual(log, ["findMany:3", "update:muda", "create:nova"]);
const muda = store.get("muda")!;
assert.equal(muda.category, "Cobertura");
assert.equal(muda.pmsDefault, null, "campo null no arquivo apaga o valor");
assert.deepEqual(muda.goalsJson, { cobertura: { max: 18, min: 12 } });
assert.equal(muda.isActive, false, "não reativa cultura inativa");
assert.equal(store.get("nova")!.isActive, true, "cultura nova nasce ativa");
assert.deepEqual((store.get("nova") as CatalogRow & { tags: string[] }).tags, []);
assert.equal(store.get("fora-do-arquivo")!.label, "Intocada", "cultura fora do arquivo intocada");
const backupPath = result.backupFile;
assert.match(backupPath, /technical-catalog-2026-11-18T12-00-00-000Z\.json$/);
if (process.platform !== "win32") assert.equal(statSync(backupPath).mode & 0o777, 0o600);
const backup = parseBackupFile(readFileSync(backupPath, "utf8"));
assert.equal(backup.format, BACKUP_FORMAT);
assert.deepEqual(backup.updated.map((item) => item.slug), ["muda"]);
assert.equal(backup.updated[0].before.pmsDefault, 60);
assert.equal(backup.updated[0].before.category, "Grãos");
assert.deepEqual(backup.created.map((item) => item.slug), ["nova"]);
assert.deepEqual(Object.keys(backup.updated[0].before).sort(), [...WRITTEN_FIELDS].sort());

// Segunda rodada: nada a gravar.
assert.equal(summarizePlan(planImport([...store.values()], payloads)).expect, 0);

// Backup falho: nada gravado.
{
  const failing = baseStore();
  const before = JSON.stringify([...failing]);
  await assert.rejects(applyImport(inTransaction(failing), payloads, { expected: 2, backupDir: join(backupDir, "nao-existe") }));
  assert.equal(JSON.stringify([...failing]), before);
}

// Restore: simulação não grava; apply devolve valores e desativa a nova.
{
  const simulated = await restoreFromBackup(inTransaction(store), backup, false);
  assert.deepEqual(simulated, { modo: "simulação da restauração (nada foi gravado)", culturasParaVoltar: 1, culturasParaDesativar: 1 });
  assert.equal(store.get("muda")!.category, "Cobertura");
  const restored = await restoreFromBackup(inTransaction(store), backup, true);
  assert.deepEqual(restored, { modo: "restore concluído", culturasRestauradas: 1, culturasDesativadas: 1 });
  assert.equal(store.get("muda")!.category, "Grãos");
  assert.equal(store.get("muda")!.pmsDefault, 60);
  assert.deepEqual(store.get("muda")!.goalsJson, { grao: { max: 15, min: 10 } });
  assert.equal(store.get("nova")!.isActive, false, "cultura criada é desativada, não apagada");
  assert.ok(store.has("nova"));
}

// Restore recusa quando alguém mexeu depois do import.
{
  const again = baseStore();
  const dir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
  const applied = await applyImport(inTransaction(again), payloads, { expected: 2, backupDir: dir });
  again.set("muda", { ...again.get("muda")!, notes: "Editada na tela depois." });
  const snapshot = JSON.stringify([...again]);
  await assert.rejects(restoreFromBackup(inTransaction(again), parseBackupFile(readFileSync(applied.backupFile, "utf8")), true), /mudaram ou sumiram/);
  assert.equal(JSON.stringify([...again]), snapshot);
}
assert.throws(() => parseBackupFile(JSON.stringify({ format: BACKUP_FORMAT, updated: [{ slug: "x", before: {}, after: {} }], created: [] })), /incompleto/);
assert.throws(() => parseBackupFile(JSON.stringify({ format: "outro", updated: [], created: [] })), /formato inesperado/);

// ---------------------------------------------------------------------------------------------
// CLI.
assert.deepEqual(parseCliArgs([]), { mode: "simulate", file: DEFAULT_CATALOG_FILE });
assert.deepEqual(parseCliArgs(["--file=x.json"]), { mode: "simulate", file: "x.json" });
assert.deepEqual(parseCliArgs(["--review"]), { mode: "review", file: DEFAULT_CATALOG_FILE });
assert.deepEqual(parseCliArgs(["--file=x.json", "--apply", "--expect=4", "--backup-dir=/tmp/b"]), { mode: "apply", file: "x.json", expected: 4, backupDir: "/tmp/b" });
assert.deepEqual(parseCliArgs(["--restore=b.json"]), { mode: "restore", backupFile: "b.json", apply: false });
assert.deepEqual(parseCliArgs(["--restore=b.json", "--apply"]), { mode: "restore", backupFile: "b.json", apply: true });
for (const bad of [["--apply"], ["--apply", "--expect=2"], ["--expect=2"], ["--backup-dir=/tmp"], ["--apply", "--expect=x", "--backup-dir=/tmp"], ["--restore=b.json", "--expect=1"], ["--restore=b.json", "--file=x.json"], ["--review", "--apply"], ["--file"], ["--outro"], ["--apply", "--apply"]]) {
  assert.throws(() => parseCliArgs(bad), /uso:/, bad.join(" "));
}

const fakeClient = (target: Store, calls: string[]): CatalogClient => ({
  async $transaction(fn, options) {
    calls.push(`tx:${options.isolationLevel}`);
    const tx = {
      ...fakeDb(target),
      async $executeRaw(query: TemplateStringsArray) {
        calls.push(`raw:${query.join("")}`);
        return 0;
      },
    };
    return fn(tx);
  },
  async $disconnect() {
    calls.push("disconnect");
  },
});
const tempCatalog = join(mkdtempSync(join(tmpdir(), "technical-catalog-test-")), "catalogo.json");
const { writeFileSync } = await import("node:fs");
writeFileSync(tempCatalog, catalogText([culture("sem-mudanca"), culture("nova")]));

{
  const calls: string[] = [];
  const lines: string[] = [];
  await runCli([`--file=${tempCatalog}`], () => fakeClient(baseStore(), calls), (line) => lines.push(line));
  assert.deepEqual(calls, ["tx:RepeatableRead", "raw:SET TRANSACTION READ ONLY", "disconnect"], "simulação em transação READ ONLY");
  assert.equal(JSON.parse(lines[0]).expect, 1);
}
{
  let created = false;
  const lines: string[] = [];
  await runCli([`--file=${tempCatalog}`, "--review"], () => {
    created = true;
    return fakeClient(baseStore(), []);
  }, (line) => lines.push(line));
  assert.equal(created, false, "--review não abre conexão");
  assert.equal(JSON.parse(lines[0]).conferidas.length, 2);
}
{
  let created = false;
  await assert.rejects(runCli(["--apply"], () => {
    created = true;
    return fakeClient(baseStore(), []);
  }), /uso:/);
  writeFileSync(tempCatalog, "{}");
  await assert.rejects(runCli([`--file=${tempCatalog}`], () => {
    created = true;
    return fakeClient(baseStore(), []);
  }), /formato inesperado/);
  assert.equal(created, false, "argumento ou arquivo inválido nunca abre conexão");
}

console.log("importTechnicalCatalog.test.ts: ok");
