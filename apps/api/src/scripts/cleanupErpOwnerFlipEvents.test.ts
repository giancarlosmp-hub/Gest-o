import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@prisma/client";
import { ERP_SYNC_TIMELINE_PATTERNS } from "@salesforce-pro/shared";
import {
  OWNER_CHANGE_PATTERN,
  OWNER_CHANGE_PREFIX,
  OWNER_CHANGE_SUFFIX,
  TIMELINE_TYPE_STATUS,
  applyCleanup,
  ownerChangeDescription,
  parseBackupFile,
  parseCliArgs,
  planFlipCleanup,
  restoreFromBackup,
  runCli,
  summarizePlan,
  type FlipClient,
  type FlipClientRow,
  type FlipDb,
  type FlipEventRow,
  type FlipUserRow,
  type TransactionRunner,
} from "./cleanupErpOwnerFlipEvents.js";

// ---------------------------------------------------------------------------------------------
// Contrato: imports permitidos, padrão do shared e texto gravado pela sincronização.
const scriptSource = readFileSync(fileURLToPath(new URL("./cleanupErpOwnerFlipEvents.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) {
  assert.ok(specifier === "@prisma/client" || specifier === "@salesforce-pro/shared" || specifier.startsWith("node:"), `import não permitido: ${specifier}`);
}
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"], "único SQL cru é o READ ONLY");
assert.doesNotMatch(scriptSource, /\$executeRawUnsafe|\$queryRaw/);
assert.equal(OWNER_CHANGE_PATTERN, ERP_SYNC_TIMELINE_PATTERNS[0]);
assert.equal(OWNER_CHANGE_PATTERN.source, "^Cliente atualizado via UltraFV3\\. Vendedor alterado de ");
assert.equal(TIMELINE_TYPE_STATUS, EventType.status);
const syncSource = readFileSync(fileURLToPath(new URL("../services/ultraFv3SyncService.ts", import.meta.url)), "utf8");
const syncTemplate = "description: `Cliente atualizado via UltraFV3. Vendedor alterado de ${primary.ownerSeller?.name || primary.ownerSellerId} para ${newSeller?.name || ownerSellerId}. Oportunidades, atividades, autores e datas históricas foram preservados.`";
assert.ok(syncSource.includes(syncTemplate), "texto da troca de vendedor mudou na sincronização");
assert.equal(syncSource.split("Vendedor alterado de").length - 1, 1, "a sincronização grava a troca de vendedor em um só lugar");
assert.equal(ownerChangeDescription("X", "Y"), `${OWNER_CHANGE_PREFIX}X para Y${OWNER_CHANGE_SUFFIX}`);
assert.match(syncSource, /createUltraFv3ClientAuditEvent = \([\s\S]*?type: EventType\.status,\s*clientId: params\.clientId,\s*ownerSellerId: params\.ownerSellerId,/, "evento grava o novo dono em ownerSellerId");

// ---------------------------------------------------------------------------------------------
// Fixtures fictícias.
const users: FlipUserRow[] = [
  { id: "u-a", name: "Vendedor Ficticio A" },
  { id: "u-b", name: "Vendedor Ficticio B" },
  { id: "u-c", name: "Vendedor Ficticio C" },
  { id: "u-sem-nome", name: null },
];
const label = (id: string) => users.find((user) => user.id === id)?.name || id;
let sequence = 0;
const base = new Date("2026-08-18T12:00:00.000Z").getTime();
const change = (clientId: string, from: string, to: string, overrides: Partial<FlipEventRow> = {}): FlipEventRow => {
  sequence += 1;
  return {
    id: `ev-${String(sequence).padStart(5, "0")}`,
    type: "status",
    description: ownerChangeDescription(label(from), label(to)),
    clientId,
    opportunityId: null,
    ownerSellerId: to,
    createdAt: new Date(base + sequence * 60_000),
    ...overrides,
  };
};
/** Vai e volta: sequência de donos [o0, o1, ...] gera eventos o0→o1, o1→o2... */
const chain = (clientId: string, owners: string[]) => owners.slice(1).map((owner, index) => change(clientId, owners[index], owner));
const ids = (events: FlipEventRow[]) => events.map((event) => event.id).sort();

// 1) A↔B várias vezes terminando em B: ficam a primeira e a última.
{
  const events = chain("c-1", ["u-a", "u-b", "u-a", "u-b", "u-a", "u-b"]);
  const plan = planFlipCleanup({ events, clients: [{ id: "c-1", ownerSellerId: "u-b" }], users });
  assert.deepEqual(ids(plan.toDelete), ids(events.slice(1, -1)));
  assert.equal(plan.clientsCleaned, 1);
}
// 2) Terminando de volta em A: ficam A→B (primeira) e B→A (última).
{
  const events = chain("c-2", ["u-a", "u-b", "u-a", "u-b", "u-a"]);
  const plan = planFlipCleanup({ events, clients: [{ id: "c-2", ownerSellerId: "u-a" }], users });
  assert.deepEqual(ids(plan.toDelete), ids(events.slice(1, -1)));
}
// 3) Troca real no meio: A→B, B→A, A→B, B→C. Só B→A sai.
{
  const events = chain("c-3", ["u-a", "u-b", "u-a", "u-b", "u-c"]);
  const plan = planFlipCleanup({ events, clients: [{ id: "c-3", ownerSellerId: "u-c" }], users });
  assert.deepEqual(ids(plan.toDelete), [events[1].id]);
}
// 4) Até 2 eventos ou sem vai e volta: nada sai.
{
  const plan = planFlipCleanup({
    events: [...chain("c-4", ["u-a", "u-b", "u-a"]), ...chain("c-5", ["u-a", "u-b", "u-c", "u-a"])],
    clients: [{ id: "c-4", ownerSellerId: "u-a" }, { id: "c-5", ownerSellerId: "u-a" }],
    users,
  });
  assert.equal(plan.toDelete.length, 0);
  assert.equal(plan.clientsWithoutFlip, 2);
}
// 5) Usuário sem nome: o texto usa o id, como na sincronização.
{
  const events = chain("c-6", ["u-a", "u-sem-nome", "u-a", "u-sem-nome"]);
  assert.match(events[0].description, / para u-sem-nome\. /);
  const plan = planFlipCleanup({ events, clients: [{ id: "c-6", ownerSellerId: "u-sem-nome" }], users });
  assert.equal(plan.toDelete.length, 1);
}
// 6) Clientes que ficam de fora.
{
  // Troca manual no meio: B→A pela tela, depois A→C pela sincronização; o texto não confere.
  const manualGap = [change("c-10", "u-a", "u-b"), change("c-10", "u-b", "u-a"), change("c-10", "u-c", "u-b"), change("c-10", "u-b", "u-c")];
  manualGap[2] = { ...manualGap[2], description: ownerChangeDescription(label("u-c"), label("u-b")) };
  const ownerChanged = chain("c-11", ["u-a", "u-b", "u-a", "u-b"]);
  const tie = chain("c-12", ["u-a", "u-b", "u-a", "u-b"]);
  tie[2] = { ...tie[2], createdAt: tie[1].createdAt };
  const missingClient = chain("c-13", ["u-a", "u-b", "u-a", "u-b"]);
  const renamed = chain("c-14", ["u-a", "u-b", "u-a", "u-b"]);
  renamed[0] = { ...renamed[0], description: ownerChangeDescription("Nome Antigo Ficticio", "Outro Nome Ficticio") };
  const sameOwner = chain("c-15", ["u-a", "u-b", "u-a", "u-b"]);
  sameOwner[2] = { ...sameOwner[2], ownerSellerId: "u-b", description: ownerChangeDescription(label("u-b"), label("u-b")) };
  const plan = planFlipCleanup({
    events: [...manualGap, ...ownerChanged, ...tie, ...missingClient, ...renamed, ...sameOwner],
    clients: [
      { id: "c-10", ownerSellerId: "u-c" },
      { id: "c-11", ownerSellerId: "u-c" },
      { id: "c-12", ownerSellerId: "u-b" },
      { id: "c-14", ownerSellerId: "u-b" },
      { id: "c-15", ownerSellerId: "u-b" },
    ],
    users,
  });
  assert.equal(plan.toDelete.length, 0);
  assert.deepEqual(plan.excluded, { sequenciaNaoConfere: 3, donoAtualDiferente: 1, horarioEmpatado: 1, clienteNaoEncontrado: 1 });
  assert.equal(plan.eventsInExcludedClients, 4 + 5 * 3);
}
// 7) Eventos fora do padrão da sincronização nunca entram.
{
  const events = chain("c-20", ["u-a", "u-b", "u-a", "u-b"]);
  const foreign: FlipEventRow[] = [
    { ...change("c-20", "u-b", "u-a"), description: `Observação: ${ownerChangeDescription(label("u-b"), label("u-a"))}` },
    { ...change("c-20", "u-a", "u-b"), description: "Responsável transferido manualmente de Vendedor Ficticio A para Vendedor Ficticio B; operador=u-c." },
    { ...change("c-20", "u-b", "u-a"), description: "Cliente reativado automaticamente pela sincronização UltraFV3 por corresponder ao cadastro principal do ERP." },
    { ...change("c-20", "u-a", "u-b"), type: "comentario" },
    { ...change("c-20", "u-b", "u-a"), opportunityId: "opp-ficticia" },
    { ...change("c-20", "u-a", "u-b"), clientId: null },
    { ...change("c-20", "u-b", "u-a"), description: `${OWNER_CHANGE_PREFIX}A para B. texto truncado` },
  ];
  const plan = planFlipCleanup({ events: [...events, ...foreign], clients: [{ id: "c-20", ownerSellerId: "u-b" }], users });
  assert.equal(plan.totalEvents, events.length);
  assert.deepEqual(ids(plan.toDelete), ids(events.slice(1, -1)));
}
// 8) Resumo: só contagens, sem ids nem nomes.
{
  const events = [...chain("c-30", Array.from({ length: 15 }, (_, i) => (i % 2 ? "u-b" : "u-a"))), ...chain("c-31", ["u-a", "u-b", "u-a", "u-b"])];
  const plan = planFlipCleanup({ events, clients: [{ id: "c-30", ownerSellerId: "u-a" }, { id: "c-31", ownerSellerId: "u-b" }], users });
  const summary = summarizePlan(plan);
  assert.equal(summary.eventosParaApagar, 12 + 1);
  assert.equal(summary.eventosMantidos, 4);
  assert.deepEqual(summary.clientesPorEventosApagados, { "1-10": 1, "11-100": 1, "101+": 0 });
  assert.equal(Object.values(summary.eventosParaApagarPorMesBrasilia).reduce((a, b) => a + b, 0), 13);
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /Ficticio|u-a|u-b|c-30|c-31|ev-/);
}

// ---------------------------------------------------------------------------------------------
// Banco em memória com os filtros que o script usa.
type Store = { events: FlipEventRow[]; clients: FlipClientRow[]; users: FlipUserRow[] };
type Where = Record<string, unknown>;
const matches = (event: FlipEventRow, where: Where) =>
  Object.entries(where).every(([key, condition]) => {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (condition === null || typeof condition !== "object") return value === condition;
    const filter = condition as { in?: unknown[]; not?: unknown; startsWith?: string; endsWith?: string };
    if (filter.in && !filter.in.includes(value)) return false;
    if ("not" in filter && value === filter.not) return false;
    if (filter.startsWith !== undefined && !String(value).startsWith(filter.startsWith)) return false;
    if (filter.endsWith !== undefined && !String(value).endsWith(filter.endsWith)) return false;
    return true;
  });
const deleteWheres: Where[] = [];
const fakeDb = (store: Store): FlipDb => ({
  timelineEvent: {
    findMany: async (args) => store.events.filter((event) => matches(event, (args as { where: Where }).where)).map((event) => ({ ...event })),
    deleteMany: async (args) => {
      const where = (args as { where: Where }).where;
      deleteWheres.push(where);
      const before = store.events.length;
      store.events = store.events.filter((event) => !matches(event, where));
      return { count: before - store.events.length };
    },
    createMany: async (args) => {
      const data = (args as { data: FlipEventRow[] }).data;
      store.events.push(...data.map((row) => ({ ...row })));
      return { count: data.length };
    },
  },
  client: { findMany: async (args) => store.clients.filter((client) => ((args as { where: { id: { in: string[] } } }).where.id.in).includes(client.id)) },
  user: { findMany: async () => store.users },
});
/** Transação com rollback: trabalha numa cópia e só publica se não houver erro. */
const transactional = (store: Store): TransactionRunner => async (fn) => {
  const copy: Store = { events: store.events.map((event) => ({ ...event })), clients: store.clients, users: store.users };
  const result = await fn(fakeDb(copy));
  store.events = copy.events;
  return result;
};
const buildStore = (): Store => {
  const flip = chain("c-40", ["u-a", "u-b", "u-a", "u-b", "u-a", "u-b"]);
  const other: FlipEventRow = { ...change("c-40", "u-a", "u-b"), description: "Comentário fictício", type: "comentario" };
  return { events: [...flip, other], clients: [{ id: "c-40", ownerSellerId: "u-b" }], users };
};

// 9) Apply: --expect errado aborta sem apagar nem gravar backup.
{
  const store = buildStore();
  const dir = mkdtempSync(join(tmpdir(), "flip-cleanup-"));
  await assert.rejects(applyCleanup(transactional(store), { expected: 2, backupDir: dir }), /Contagem divergente/);
  assert.equal(store.events.length, 6);
  assert.deepEqual(readdirSync(dir), []);
}
// 10) Backup que falha (diretório inexistente): nada é apagado.
{
  const store = buildStore();
  await assert.rejects(applyCleanup(transactional(store), { expected: 3, backupDir: join(tmpdir(), "flip-cleanup-nao-existe-ficticio") }));
  assert.equal(store.events.length, 6);
}
// 11) Apply certo: backup antes, só os 3 do meio saem, filtro repetido no deleteMany; restore devolve.
{
  const store = buildStore();
  const dir = mkdtempSync(join(tmpdir(), "flip-cleanup-"));
  deleteWheres.length = 0;
  const result = await applyCleanup(transactional(store), { expected: 3, backupDir: dir, now: new Date("2026-11-16T12:00:00.000Z") });
  assert.equal(result.removed, 3);
  assert.equal(store.events.length, 3);
  assert.ok(store.events.some((event) => event.type === "comentario"), "evento de outro tipo intacto");
  assert.equal(store.events.filter((event) => event.type === "status").length, 2);
  for (const where of deleteWheres) {
    assert.deepEqual(Object.keys(where).sort(), ["clientId", "description", "id", "opportunityId", "type"]);
  }
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
  const backup = parseBackupFile(readFileSync(join(dir, files[0]), "utf8"));
  assert.equal(backup.events.length, 3);
  // Restore: simulação por padrão não grava; com apply recria; de novo recusa (já existem).
  const simulated = await restoreFromBackup(transactional(store), backup, false);
  assert.deepEqual(simulated, { modo: "simulação da restauração (nada foi gravado)", eventosParaRestaurar: 3 });
  assert.equal(store.events.length, 3);
  await restoreFromBackup(transactional(store), backup, true);
  assert.equal(store.events.length, 6);
  assert.ok(store.events.every((event) => event.createdAt instanceof Date));
  await assert.rejects(restoreFromBackup(transactional(store), backup, true), /já existem/);
  // Backup adulterado com evento fora do padrão é recusado.
  const tampered = { ...backup, events: [{ ...backup.events[0], description: "Comentário fictício" }] };
  assert.throws(() => parseBackupFile(JSON.stringify(tampered)), /fora do padrão/);
}
// Primeiro e último evento ficaram no apply acima: confere a regra com o próprio store.
{
  const store = buildStore();
  const statusIds = store.events.filter((event) => event.type === "status").map((event) => event.id);
  await applyCleanup(transactional(store), { expected: 3, backupDir: mkdtempSync(join(tmpdir(), "flip-cleanup-")) });
  assert.deepEqual(store.events.filter((event) => event.type === "status").map((event) => event.id), [statusIds[0], statusIds[statusIds.length - 1]]);
}

// ---------------------------------------------------------------------------------------------
// CLI
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=12", "--backup-dir=/tmp/x"]), { mode: "apply", expected: 12, backupDir: "/tmp/x" });
assert.deepEqual(parseCliArgs(["--restore=/tmp/x.json"]), { mode: "restore", file: "/tmp/x.json", apply: false });
assert.deepEqual(parseCliArgs(["--restore=/tmp/x.json", "--apply"]), { mode: "restore", file: "/tmp/x.json", apply: true });
assert.throws(() => parseCliArgs(["--apply", "--expect=12"]), /backup-dir/);
assert.throws(() => parseCliArgs(["--apply", "--backup-dir=/tmp/x"]), /expect/);
assert.throws(() => parseCliArgs(["--expect=1"]), /só valem com --apply/);
assert.throws(() => parseCliArgs(["--restore=/tmp/x.json", "--expect=1"]));
assert.throws(() => parseCliArgs(["--apply=sim", "--expect=1", "--backup-dir=/tmp/x"]));
assert.throws(() => parseCliArgs(["--outra"]));

// Simulação pela CLI: transação READ ONLY, só contagens, nada gravado.
{
  const store = buildStore();
  const statements: string[] = [];
  let created = 0;
  const lines: string[] = [];
  const client: FlipClient = {
    $transaction: async (fn) => fn({ ...fakeDb(store), $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => undefined,
  };
  await runCli([], () => { created += 1; return client; }, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(store.events.length, 6);
  const output = JSON.parse(lines[0]);
  assert.equal(output.eventosParaApagar, 3);
  assert.doesNotMatch(lines[0], /Ficticio|u-a|u-b|c-40|ev-/);
  await assert.rejects(runCli(["--apply"], () => { created += 1; return client; }));
  assert.equal(created, 1, "argumento inválido não abre conexão");
}

console.log("cleanupErpOwnerFlipEvents.test.ts: ok");
