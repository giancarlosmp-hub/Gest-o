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
  parseCatalogDeactivations,
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
// Link null só em fonte do tipo "comercial" (recomendação do fornecedor, sem documento publicado).
assert.equal(
  parseCatalogFile(catalogText([culture("cultura-a")], { "FONTE-A": { orgao: "Fornecedor fictício", titulo: "Recomendação comercial fictícia", ano: null, link: null, tipo: "comercial" } })).length,
  1,
  "fonte comercial sem link aceita"
);
rejects([culture("cultura-a")], /sem órgão, título ou link/, "link null sem tipo comercial", { "FONTE-A": { orgao: "X", titulo: "Y", ano: null, link: null } });
rejects([culture("cultura-a")], /tipo inválido/, "tipo desconhecido", { "FONTE-A": { orgao: "X", titulo: "Y", ano: null, link: null, tipo: "outro" } });
rejects([culture("cultura-a")], /sem órgão/, "fonte comercial ainda exige órgão", { "FONTE-A": { orgao: "", titulo: "Y", ano: null, link: null, tipo: "comercial" } });
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

// Valor anterior mantido (sem fonte confirmada): validação e revisão.
const KEPT_NOTES = { notes: "Faixa: valor anterior, sem fonte confirmada." };
const kept = (value: unknown) => ({ value, manter: true, reason: "valor anterior, sem fonte confirmada" });
{
  const [entry] = parseCatalogFile(catalogText([
    culture("mantida", KEPT_NOTES, {
      defaultKgHaMin: kept(10),
      defaultKgHaMax: kept(20),
      goalsJson: { ...sourced({ silagem: { min: 14, max: 18 } }), manterObjetivos: { grao: { min: 12, max: 18 } }, manterMotivo: "valor anterior" },
    }),
  ]));
  assert.deepEqual(entry.kept, ["defaultKgHaMin", "defaultKgHaMax"]);
  assert.deepEqual(entry.keptGoals, ["grao"]);
  assert.deepEqual(entry.goalsJson, { silagem: { min: 14, max: 18 }, grao: { min: 12, max: 18 } }, "revisão usa o valor anterior");
  const keptReview = reviewCatalog([entry]);
  assert.deepEqual(keptReview.mantidosSemFonte, { mantida: ["defaultKgHaMin", "defaultKgHaMax", "goalsJson.grao"] });
  assert.deepEqual(keptReview.alertas, []);
  // Objetivo mantido que não contém a conta (15,31 kg/ha) gera alerta.
  const outside = parseCatalogFile(catalogText([
    culture("objetivo-fora", KEPT_NOTES, { goalsJson: { ...sourced({}), reason: "x", manterObjetivos: { grao: { min: 20, max: 30 } }, manterMotivo: "valor anterior" } }),
  ]));
  assert.deepEqual(reviewCatalog(outside).alertas.map((item) => item.slug), ["objetivo-fora"]);
}
rejects([culture("cultura-a", {}, { pmsDefault: kept(60) })], /sem a observação/, "mantido sem a observação nas notas");
rejects([culture("cultura-a", KEPT_NOTES, { pmsDefault: { ...kept(60), sources: ["FONTE-A"] } })], /não leva fonte/, "mantido com fonte");
rejects([culture("cultura-a", KEPT_NOTES, { pmsDefault: kept(null) })], /sem o valor anterior/, "mantido sem valor anterior");
rejects([culture("cultura-a", KEPT_NOTES, { pmsDefault: { value: 60, manter: true } })], /sem motivo/, "mantido sem motivo");
rejects([culture("cultura-a", KEPT_NOTES, { defaultKgHaMin: kept(10) })], /mantidos juntos/, "só um lado da faixa mantido");
rejects([culture("cultura-a", KEPT_NOTES, { goalsJson: { ...sourced({ grao: { min: 1, max: 2 } }), manterObjetivos: { grao: { min: 1, max: 2 } }, manterMotivo: "x" } })], /ao mesmo tempo/, "objetivo com fonte e mantido");
rejects([culture("cultura-a", KEPT_NOTES, { goalsJson: { ...sourced({}), reason: "x", manterObjetivos: { grao: { min: 1, max: 2 } } } })], /sem motivo/, "objetivo mantido sem motivo");

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
  mantidosSemFonte: {},
  mantidosDiferentesDoArquivo: [],
  desativar: 0,
  culturasParaDesativar: [],
  jaInativas: [],
  desativarAusentesNoBanco: [],
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
assert.deepEqual(backup.deactivated, [], "sem lista desativar, nada desativado");

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
  assert.deepEqual(simulated, { modo: "simulação da restauração (nada foi gravado)", culturasParaVoltar: 1, culturasParaDesativar: 1, culturasParaReativar: 0 });
  assert.equal(store.get("muda")!.category, "Cobertura");
  const restored = await restoreFromBackup(inTransaction(store), backup, true);
  assert.deepEqual(restored, { modo: "restore concluído", culturasRestauradas: 1, culturasDesativadas: 1, culturasReativadas: 0 });
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
assert.deepEqual(parseBackupFile(JSON.stringify({ format: BACKUP_FORMAT, createdAt: "x", updated: [], created: [] })).deactivated, [], "backup antigo, sem a lista: nada a reativar");
assert.throws(() => parseBackupFile(JSON.stringify({ format: BACKUP_FORMAT, updated: [], created: [], deactivated: [{}] })), /incompleto/);
assert.throws(() => parseBackupFile(JSON.stringify({ format: BACKUP_FORMAT, updated: [], created: [], deactivated: "x" })), /formato inesperado/);

// ---------------------------------------------------------------------------------------------
// Desativação: lista "desativar" do arquivo (slug + motivo); só isActive=false, nunca apaga.
{
  const withDeactivations = (culturas: unknown[], desativar: unknown) => JSON.stringify({ format: CATALOG_FORMAT, fontes: FONTES, culturas, desativar });
  assert.deepEqual(parseCatalogDeactivations(catalogText([culture("cultura-a")])), [], "sem lista, nada a desativar");
  assert.deepEqual(parseCatalogDeactivations(readFileSync(DEFAULT_CATALOG_FILE, "utf8")), [], "arquivo do PR sem desativações");
  assert.deepEqual(
    parseCatalogDeactivations(withDeactivations([culture("cultura-a")], [{ slug: "antiga-x", motivo: " Motivo fictício. " }])),
    [{ slug: "antiga-x", motivo: "Motivo fictício." }]
  );
  const rejectsDeactivation = (desativar: unknown, pattern: RegExp, message: string) =>
    assert.throws(() => parseCatalogDeactivations(withDeactivations([culture("cultura-a")], desativar)), pattern, message);
  rejectsDeactivation({ slug: "antiga-x" }, /inválida/, "lista que não é lista");
  rejectsDeactivation([{ slug: "antiga-x" }], /sem motivo/, "desativação sem motivo");
  rejectsDeactivation([{ slug: "Antiga X", motivo: "x" }], /slug válido/, "slug fora do padrão");
  rejectsDeactivation([{ slug: "antiga-x", motivo: "x" }, { slug: "antiga-x", motivo: "y" }], /repetido/, "slug repetido na lista");
  rejectsDeactivation([{ slug: "cultura-a", motivo: "x" }], /ao mesmo tempo/, "cultura em culturas e em desativar");
  rejectsDeactivation([{ slug: "antiga-x", motivo: "x", isActive: false }], /campo desconhecido/, "campo além de slug e motivo");

  const deactivations = [
    { slug: "antiga-ativa", motivo: "Motivo fictício." },
    { slug: "antiga-inativa", motivo: "Motivo fictício." },
  ];
  const deactivationStore = (): Store => new Map([
    ["sem-mudanca", rowFrom("sem-mudanca")],
    ["antiga-ativa", rowFrom("antiga-ativa", { label: "Antiga ativa" })],
    ["antiga-inativa", rowFrom("antiga-inativa", { isActive: false })],
    ["fora-do-arquivo", rowFrom("fora-do-arquivo")],
  ]);
  const deactivationPayloads = parseCatalogFile(catalogText([culture("sem-mudanca")]));

  // Simulação: mostra quais desativa, quais já estão inativas e conta no --expect.
  const deactivationPlan = planImport([...deactivationStore().values()], deactivationPayloads, deactivations);
  const deactivationSummary = summarizePlan(deactivationPlan);
  assert.equal(deactivationSummary.desativar, 1);
  assert.equal(deactivationSummary.expect, 1, "expect = criar + atualizar + desativar");
  assert.deepEqual(deactivationSummary.culturasParaDesativar, ["antiga-ativa"]);
  assert.deepEqual(deactivationSummary.jaInativas, ["antiga-inativa"]);
  assert.deepEqual(deactivationSummary.desativarAusentesNoBanco, []);
  assert.ok(!JSON.stringify(deactivationSummary).includes("Motivo fictício"), "resumo sem textos");
  const missingPlan = planImport([...deactivationStore().values()], deactivationPayloads, [{ slug: "nao-existe", motivo: "x" }]);
  assert.deepEqual(summarizePlan(missingPlan).desativarAusentesNoBanco, ["nao-existe"], "simulação mostra slug ausente");

  // Apply: --expect errado não grava; slug ausente não grava; certo grava só isActive=false, com backup.
  {
    const target = deactivationStore();
    const before = JSON.stringify([...target]);
    const dir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
    await assert.rejects(applyImport(inTransaction(target), deactivationPayloads, { expected: 0, backupDir: dir, deactivate: deactivations }), /Contagem divergente/);
    await assert.rejects(
      applyImport(inTransaction(target), deactivationPayloads, { expected: 1, backupDir: dir, deactivate: [...deactivations, { slug: "nao-existe", motivo: "x" }] }),
      /não existem no banco/
    );
    assert.equal(JSON.stringify([...target]), before);
    assert.deepEqual(readdirSync(dir), [], "sem backup quando recusa");
  }
  const target = deactivationStore();
  const writes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
  const applied = await applyImport(inTransaction(target, writes), deactivationPayloads, {
    expected: 1,
    backupDir: dir,
    deactivate: deactivations,
    now: new Date("2026-11-20T12:00:00.000Z"),
  });
  assert.equal(applied.gravadas, 1);
  assert.deepEqual(writes, ["findMany:3", "update:antiga-ativa"], "só a cultura ativa da lista é gravada");
  const deactivated = target.get("antiga-ativa")!;
  assert.equal(deactivated.isActive, false, "desativada");
  assert.deepEqual({ ...deactivated, isActive: true }, rowFrom("antiga-ativa", { label: "Antiga ativa" }), "nenhum outro campo muda");
  assert.equal(target.get("antiga-inativa")!.isActive, false);
  assert.equal(target.get("fora-do-arquivo")!.isActive, true, "cultura fora do arquivo intocada");
  assert.equal(target.size, 4, "nunca apaga");
  const deactivationBackup = parseBackupFile(readFileSync(applied.backupFile, "utf8"));
  assert.deepEqual(deactivationBackup.deactivated, [{ slug: "antiga-ativa" }]);
  assert.equal(summarizePlan(planImport([...target.values()], deactivationPayloads, deactivations)).expect, 0, "segunda rodada sem mudanças");

  // Restore: reativa a desativada; recusa se alguém reativou antes.
  const simulatedRestore = await restoreFromBackup(inTransaction(target), deactivationBackup, false);
  assert.equal(simulatedRestore.culturasParaReativar, 1);
  assert.equal(target.get("antiga-ativa")!.isActive, false, "simulação não grava");
  {
    const touched = new Map([...target].map(([key, value]) => [key, structuredClone(value)]));
    touched.set("antiga-ativa", { ...touched.get("antiga-ativa")!, isActive: true });
    await assert.rejects(restoreFromBackup(inTransaction(touched), deactivationBackup, true), /mudaram ou sumiram/);
  }
  const restoredDeactivation = await restoreFromBackup(inTransaction(target), deactivationBackup, true);
  assert.equal(restoredDeactivation.culturasReativadas, 1);
  assert.equal(target.get("antiga-ativa")!.isActive, true, "restore reativa");
  assert.equal(target.get("antiga-inativa")!.isActive, false, "já inativa antes continua inativa");
}
assert.throws(() => parseBackupFile(JSON.stringify({ format: "outro", updated: [], created: [] })), /formato inesperado/);

// Campo mantido: o import não grava; fica o valor do banco (mesmo diferente do arquivo).
{
  const keptPayloads = parseCatalogFile(catalogText([
    culture("mantem", KEPT_NOTES, {
      defaultKgHaMin: kept(10),
      defaultKgHaMax: kept(20),
      pmsDefault: empty(),
      goalsJson: { ...sourced({ silagem: { min: 14, max: 18 } }), manterObjetivos: { grao: { min: 10, max: 15 }, pastejo: { min: 5, max: 9 } }, manterMotivo: "valor anterior" },
    }),
    culture("nova-mantida", KEPT_NOTES, { defaultKgHaMin: kept(10), defaultKgHaMax: kept(20) }),
  ]));
  const keptStore: Store = new Map([["mantem", rowFrom("mantem", { defaultKgHaMin: 11, defaultKgHaMax: 22, goalsJson: { grao: { min: 9, max: 14 }, silagem: { min: 1, max: 2 } } })]]);
  const keptPlan = planImport([...keptStore.values()], keptPayloads);
  assert.deepEqual(keptPlan.toUpdate.map((item) => [item.row.slug, item.changed]), [["mantem", ["pmsDefault", "notes", "goalsJson"]]], "faixa mantida não aparece como mudança");
  const keptSummary = summarizePlan(keptPlan);
  assert.deepEqual(keptSummary.mantidosSemFonte, { mantem: { defaultKgHaMin: 11, defaultKgHaMax: 22, "goalsJson.grao": { min: 9, max: 14 }, "goalsJson.pastejo": null } });
  assert.deepEqual(keptSummary.mantidosDiferentesDoArquivo, ["mantem.defaultKgHaMin", "mantem.defaultKgHaMax", "mantem.goalsJson.grao", "mantem.goalsJson.pastejo"]);
  const dir = mkdtempSync(join(tmpdir(), "technical-catalog-test-"));
  await applyImport(inTransaction(keptStore), keptPayloads, { expected: 2, backupDir: dir });
  const after = keptStore.get("mantem")!;
  assert.equal(after.defaultKgHaMin, 11, "valor do banco mantido");
  assert.equal(after.defaultKgHaMax, 22);
  assert.equal(after.pmsDefault, null);
  assert.deepEqual(after.goalsJson, { silagem: { min: 14, max: 18 }, grao: { min: 9, max: 14 } }, "objetivo mantido fica com a faixa do banco; sem faixa no banco, não é criado");
  const created = keptStore.get("nova-mantida")!;
  assert.equal(created.defaultKgHaMin, null, "cultura nova não recebe valor sem fonte");
  assert.equal(created.defaultKgHaMax, null);
  assert.equal(summarizePlan(planImport([...keptStore.values()], keptPayloads)).expect, 0, "segunda rodada sem mudanças");
}

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

// CLI com lista "desativar": simulação READ ONLY mostra quais; --review lista sem abrir conexão.
{
  writeFileSync(
    tempCatalog,
    JSON.stringify({ format: CATALOG_FORMAT, fontes: FONTES, culturas: [culture("sem-mudanca")], desativar: [{ slug: "fora-do-arquivo", motivo: "Motivo fictício." }] })
  );
  const calls: string[] = [];
  const lines: string[] = [];
  const simulated = baseStore();
  await runCli([`--file=${tempCatalog}`], () => fakeClient(simulated, calls), (line) => lines.push(line));
  assert.deepEqual(calls, ["tx:RepeatableRead", "raw:SET TRANSACTION READ ONLY", "disconnect"]);
  const output = JSON.parse(lines[0]);
  assert.deepEqual(output.culturasParaDesativar, ["fora-do-arquivo"]);
  assert.equal(output.expect, 1);
  assert.equal(simulated.get("fora-do-arquivo")!.isActive, true, "simulação não grava");
  const reviewLines: string[] = [];
  await runCli([`--file=${tempCatalog}`, "--review"], () => {
    throw new Error("--review não abre conexão");
  }, (line) => reviewLines.push(line));
  assert.deepEqual(JSON.parse(reviewLines[0]).desativar, ["fora-do-arquivo"]);
}

console.log("importTechnicalCatalog.test.ts: ok");
