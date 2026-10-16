import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErpOperationalOrderStatus, ErpOrderSyncStatus, EventType, Prisma } from "@prisma/client";
import {
  HISTORY_SOURCE_POST_ERROR,
  HISTORY_SOURCE_RECONCILIATION,
  OPERATIONAL_STATUS_UNKNOWN,
  RECONCILIATION_AUDIT_OPERATION,
  SEND_STATUS_ERROR,
  TIMELINE_TYPE_STATUS,
  UNCERTAIN_FAILURE_PATTERN,
  applyCleanup,
  classifyResendBlock,
  loadCleanupPlan,
  parseBackupFile,
  parseCliArgs,
  planRejectedOrderStatusCleanup,
  restoreFromBackup,
  runCli,
  summarizePlan,
  type CleanupClient,
  type CleanupDb,
  type TransactionRunner,
} from "./cleanupRejectedOrderFakeStatus.js";

// ---------------------------------------------------------------------------------------------
// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const scriptPath = fileURLToPath(new URL("./cleanupRejectedOrderFakeStatus.ts", import.meta.url));
const scriptSource = readFileSync(scriptPath, "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
assert.ok(specifiers.length > 0, "o teste de contrato precisa encontrar os imports");
for (const specifier of specifiers) {
  assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
}

// Constantes locais conferidas contra o schema e o código da reconciliação.
assert.equal(SEND_STATUS_ERROR, ErpOrderSyncStatus.error);
assert.equal(OPERATIONAL_STATUS_UNKNOWN, ErpOperationalOrderStatus.UNKNOWN);
assert.equal(TIMELINE_TYPE_STATUS, EventType.status);
const serviceSource = readFileSync(fileURLToPath(new URL("../services/erpOrderService.ts", import.meta.url)), "utf8");
assert.ok(serviceSource.includes(`source: "${HISTORY_SOURCE_RECONCILIATION}"`));
assert.ok(serviceSource.includes("`Pedido ERP ${order.numPedido || order.id}: situação atualizada para ${operationalStatusRaw}.`"));
assert.ok(serviceSource.includes(`operation: "${RECONCILIATION_AUDIT_OPERATION}"`));
assert.ok(serviceSource.includes(`source: "${HISTORY_SOURCE_POST_ERROR}", errorMessage: sanitizeErpOrderErrorMessage(failure.message).slice(0, 500)`), "histórico do erro do POST mudou de formato");
assert.ok(serviceSource.includes("message: `UltraFV3 rejeitou POST /orders${status ? ` (status ${status})` : \"\"}: ${ultraMessage}`"), "mensagem do erro do POST mudou de formato");
assert.ok(serviceSource.includes(`.test(text)`) && serviceSource.includes(UNCERTAIN_FAILURE_PATTERN.source), "regex de bloqueio de reenvio divergente");

// ---------------------------------------------------------------------------------------------
// Fixtures fictícias.
const inWindow = new Date("2026-09-10T15:00:00.000Z");
const failure = { endpoint: "/orders", message: "Pedido recusado: regra comercial fictícia", status: 502 };
let sequence = 0;
const attempt = (overrides: Record<string, unknown>) => ({
  id: `att-${++sequence}`,
  tenantId: "tenant-ficticio",
  opportunityId: "opp-a",
  sellerId: "seller-ficticio",
  pedidoIdImportacao: `imp-${sequence}`,
  numPedido: `90${sequence}`,
  erpOrderNumber: null,
  erpOrderId: null,
  operationalStatusRaw: null,
  operationalOrderStatus: "UNKNOWN",
  requestAuthorizationStatus: "UNKNOWN",
  status: "error",
  orderStatus: null,
  payloadSent: { NUM_PEDIDO: "ficticio" },
  erpResponse: failure,
  syncErrors: [{ ...failure, at: "2026-09-01T12:00:00.000Z" }],
  lastStatusPayload: null,
  sentAt: null,
  statusSyncedAt: null,
  createdAt: new Date("2026-09-01T12:00:00.000Z"),
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  supersedesErpOrderSyncId: null,
  ...overrides,
});
const reconciled = {
  operationalStatusRaw: "FINALIZADO",
  operationalOrderStatus: "FINALIZADO",
  orderStatus: "entregue",
  lastStatusPayload: { operation: RECONCILIATION_AUDIT_OPERATION, outcome: "rejected" },
  statusSyncedAt: inWindow,
  syncErrors: null,
  updatedAt: inWindow,
};
const history = (erpOrderSyncId: string, source: string, opportunityId = "opp-a") => ({
  id: `hist-${++sequence}`, erpOrderSyncId, opportunityId, syncStatus: "error", orderStatus: null, operationalStatusRaw: null, source, errorMessage: null, occurredAt: inWindow,
});
const timeline = (opportunityId: string, description: string, createdAt = inWindow, type = "status") => ({
  id: `tl-${++sequence}`, type, description, clientId: "client-ficticio", opportunityId, ownerSellerId: "seller-ficticio", createdAt,
});

// ---------------------------------------------------------------------------------------------
// Banco em memória com a mesma interface mínima usada pelo script; transação desfaz em erro.
type Row = Record<string, unknown>;
type Tables = { erpOrderSync: Row[]; erpOrderStatusHistory: Row[]; timelineEvent: Row[] };
const clone = (tables: Tables): Tables => structuredClone(tables);
const matches = (row: Row, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, condition]) =>
    condition && typeof condition === "object" && "in" in (condition as object)
      ? ((condition as { in: unknown[] }).in).includes(row[key])
      : row[key] === condition);
const normalizeData = (data: Row) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === Prisma.DbNull ? null : value]));
const createDb = (initial: Tables) => {
  let tables = clone(initial);
  const delegate = (name: keyof Tables) => ({
    async findMany(args: unknown) {
      const { where, select } = (args ?? {}) as { where?: Record<string, unknown>; select?: Record<string, boolean> };
      return tables[name].filter((row) => matches(row, where)).map((row) =>
        select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row));
    },
    async update(args: unknown) {
      const { where, data } = args as { where: { id: string }; data: Row };
      const row = tables[name].find((candidate) => candidate.id === where.id);
      if (!row) throw new Error("registro inexistente");
      Object.assign(row, normalizeData(data), "updatedAt" in data ? {} : { updatedAt: new Date("2026-10-01T00:00:00.000Z") });
      return row;
    },
    async deleteMany(args: unknown) {
      const { where } = args as { where: Record<string, unknown> };
      const before = tables[name].length;
      tables[name] = tables[name].filter((row) => !matches(row, where));
      return { count: before - tables[name].length };
    },
    async createMany(args: unknown) {
      const { data } = args as { data: Row[] };
      for (const row of data) {
        if (tables[name].some((existing) => existing.id === row.id)) throw new Error("id duplicado");
        tables[name].push(normalizeData(row));
      }
      return { count: data.length };
    },
  });
  const db = { erpOrderSync: delegate("erpOrderSync"), erpOrderStatusHistory: delegate("erpOrderStatusHistory"), timelineEvent: delegate("timelineEvent") } as unknown as CleanupDb;
  const run: TransactionRunner = async (fn) => {
    const snapshot = clone(tables);
    try {
      return await fn(db);
    } catch (error) {
      tables = snapshot;
      throw error;
    }
  };
  return { db, run, state: () => clone(tables) };
};

// ---------------------------------------------------------------------------------------------
// Lógica pura.
{
  const affected = attempt(reconciled);
  const sentWithStatus = attempt({ ...reconciled, status: "sent", erpResponse: { ok: true }, syncErrors: null });
  const errorWithoutStatus = attempt({});
  const plan = planRejectedOrderStatusCleanup({
    errorAttempts: [affected, sentWithStatus, errorWithoutStatus] as never,
    opportunityAttempts: [affected, sentWithStatus, errorWithoutStatus] as never,
    history: [
      history(affected.id, HISTORY_SOURCE_RECONCILIATION),
      history(affected.id, "ultrafv3-orders-error"),
      history(affected.id, "crm-submit"),
      history(sentWithStatus.id, HISTORY_SOURCE_RECONCILIATION),
      history(errorWithoutStatus.id, HISTORY_SOURCE_RECONCILIATION),
    ] as never,
    timeline: [
      timeline("opp-a", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`),
      timeline("opp-a", `Pedido ERP ${sentWithStatus.numPedido}: situação atualizada para FINALIZADO.`),
      timeline("opp-a", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`, new Date("2026-09-15T03:00:00.000Z")),
      timeline("opp-a", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`, new Date("2026-09-07T02:59:59.999Z")),
      timeline("opp-a", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`, inWindow, "comentario"),
      timeline("opp-b", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`),
      timeline("opp-a", `Novo envio ERP cancelado pelo preflight somente leitura: Pedido ERP ${affected.numPedido}.`),
      timeline("opp-a", `Pedido ERP ${affected.numPedido}0: situação atualizada para FINALIZADO.`),
    ] as never,
  });
  assert.deepEqual(plan.attempts.map((row) => row.id), [affected.id], "pega error + situação; ignora sent com situação e error sem situação");
  assert.equal(plan.history.length, 1, "ignora histórico de outras origens e de outras tentativas");
  assert.equal(plan.history[0].source, HISTORY_SOURCE_RECONCILIATION);
  assert.equal(plan.timeline.length, 1, "ignora timeline fora da janela, de outro tipo, de outra oportunidade ou de outro texto");
  assert.equal(plan.ambiguousTimeline.length, 0);
}

// Situação só no enum normalizado também conta como preenchida; id usado no texto quando não há numPedido.
{
  const affected = attempt({ ...reconciled, operationalStatusRaw: null, numPedido: null });
  const plan = planRejectedOrderStatusCleanup({
    errorAttempts: [affected] as never,
    opportunityAttempts: [affected] as never,
    history: [],
    timeline: [timeline("opp-a", `Pedido ERP ${affected.id}: situação atualizada para FINALIZADO.`)] as never,
  });
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.timeline.length, 1);
}

// Número repetido na mesma oportunidade: o evento é ambíguo e não entra na remoção.
{
  const affected = attempt({ ...reconciled, numPedido: "777" });
  const retry = attempt({ status: "sent", numPedido: "777", erpResponse: { ok: true }, syncErrors: null });
  const plan = planRejectedOrderStatusCleanup({
    errorAttempts: [affected] as never,
    opportunityAttempts: [affected, retry] as never,
    history: [history(affected.id, HISTORY_SOURCE_RECONCILIATION)] as never,
    timeline: [timeline("opp-a", "Pedido ERP 777: situação atualizada para FINALIZADO.")] as never,
  });
  assert.equal(plan.timeline.length, 0);
  assert.equal(plan.ambiguousTimeline.length, 1);
  assert.equal(summarizePlan(plan).timelineAmbiguos, 1);
}

// erpResponse sobrescrito pela reconciliação: classifica pelo erro original do POST no histórico.
{
  const overwritten = { ...reconciled, erpResponse: { operation: RECONCILIATION_AUDIT_OPERATION, outcome: "rejected", response: {} } };
  const postError = (erpOrderSyncId: string, errorMessage: string, opportunityId: string) =>
    ({ ...history(erpOrderSyncId, HISTORY_SOURCE_POST_ERROR, opportunityId), errorMessage });
  const definitive = attempt({ ...overwritten, opportunityId: "opp-h1" });
  const timeoutOriginal = attempt({ ...overwritten, opportunityId: "opp-h2" });
  const status504 = attempt({ ...overwritten, opportunityId: "opp-h3" });
  const noSource = attempt({ ...overwritten, opportunityId: "opp-h4" });
  const truncated = attempt({ ...overwritten, opportunityId: "opp-h5" });
  const unknownFormat = attempt({ ...overwritten, opportunityId: "opp-h6" });
  const all = [definitive, timeoutOriginal, status504, noSource, truncated, unknownFormat];
  const plan = planRejectedOrderStatusCleanup({
    errorAttempts: all as never,
    opportunityAttempts: all as never,
    history: [
      postError(definitive.id, "UltraFV3 rejeitou POST /orders (status 422): cliente fictício bloqueado", "opp-h1"),
      postError(timeoutOriginal.id, "UltraFV3 rejeitou POST /orders: Tempo esgotado (timeout) ao chamar o ERP fictício", "opp-h2"),
      postError(status504.id, "UltraFV3 rejeitou POST /orders (status 504): gateway fictício", "opp-h3"),
      postError(truncated.id, `UltraFV3 rejeitou POST /orders (status 422): ${"x".repeat(500)}`.slice(0, 500), "opp-h5"),
      postError(unknownFormat.id, "mensagem fictícia em outro formato", "opp-h6"),
      ...all.map((row) => history(row.id, HISTORY_SOURCE_RECONCILIATION, row.opportunityId)),
    ] as never,
    timeline: all.map((row) => timeline(row.opportunityId, `Pedido ERP ${row.numPedido}: situação atualizada para FINALIZADO.`)) as never,
  });
  assert.deepEqual(plan.attempts.map((row) => row.id), [definitive.id], "sobrescrito com erro original definitivo no histórico entra");
  assert.equal(plan.definitiveFromHistory, 1);
  assert.deepEqual(plan.excludedPossibleTimeout.map((row) => row.id), [timeoutOriginal.id, status504.id], "sobrescrito com erro original de timeout fica fora");
  assert.deepEqual(plan.excludedUndetermined.map((row) => row.id), [noSource.id, truncated.id, unknownFormat.id], "sobrescrito sem fonte confiável fica fora");
  assert.deepEqual(plan.history.map((row) => row.erpOrderSyncId), [definitive.id], "eventos das excluídas não entram");
  assert.deepEqual(plan.timeline.map((row) => row.opportunityId), ["opp-h1"]);
  const summary = summarizePlan(plan);
  assert.deepEqual(
    [summary.definitivas, summary.excluidasPossivelTimeout, summary.excluidasClassificacaoIndeterminada, summary.definitivasClassificadasPeloHistorico],
    [1, 2, 3, 1],
  );
}

// Resumo: só contagens e formatos, nunca IDs, números de pedido ou conteúdo.
{
  const affected = attempt({ ...reconciled, numPedido: "4242" });
  const plan = planRejectedOrderStatusCleanup({ errorAttempts: [affected] as never, opportunityAttempts: [affected] as never, history: [], timeline: [] });
  const printed = JSON.stringify(summarizePlan(plan));
  for (const secret of [affected.id, "4242", "opp-a", "tenant-ficticio", "regra comercial"]) assert.ok(!printed.includes(secret), `resumo vazou ${secret}`);
  assert.deepEqual(summarizePlan(plan).tentativasPorSituacao, { FINALIZADO: 1 });
  assert.deepEqual(summarizePlan(plan).tentativasPorDiaDaConferencia, { "2026-09-10": 1 });
}

// Bloqueio de reenvio comparado com uma recusa normal.
assert.equal(classifyResendBlock({ syncErrors: null, erpResponse: failure }), "igual (não bloqueia)");
assert.equal(classifyResendBlock({ syncErrors: [{ ...failure, at: "x" }], erpResponse: failure }), "igual (não bloqueia)");
assert.match(classifyResendBlock({ syncErrors: [{ message: "timeout na conferência", operation: "orderStatus" }], erpResponse: failure }), /^diferente \(bloqueia hoje/);
assert.match(classifyResendBlock({ syncErrors: null, erpResponse: { operation: RECONCILIATION_AUDIT_OPERATION } }), /^indeterminado/);

// CLI: --apply exige as três contagens e o diretório de backup.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--restore=/b/x.json"]), { mode: "restore", file: "/b/x.json" });
const validApply = ["--apply", "--expect-attempts=5", "--expect-history-events=5", "--expect-timeline-events=4", "--backup-dir=/b"];
assert.deepEqual(parseCliArgs(validApply), {
  mode: "apply", expected: { attempts: 5, history: 5, timeline: 4 }, backupDir: "/b",
});
const invalidArgs = [
  ["--apply"],
  validApply.filter((arg) => !arg.startsWith("--expect-attempts")),
  validApply.filter((arg) => !arg.startsWith("--expect-history-events")),
  validApply.filter((arg) => !arg.startsWith("--expect-timeline-events")),
  validApply.filter((arg) => !arg.startsWith("--backup-dir")),
  [...validApply.filter((arg) => !arg.startsWith("--backup-dir")), "--backup-dir"],
  ["--apply", "--expect-attempts=x", "--expect-history-events=5", "--expect-timeline-events=4", "--backup-dir=/b"],
  ["--apply=1", "--expect-attempts=5", "--expect-history-events=5", "--expect-timeline-events=4", "--backup-dir=/b"],
  [...validApply, "--expect-attempts=6"],
  ["--expect-attempts=5"],
  ["--backup-dir=/b"],
  ["--restore"],
  ["--restore="],
  ["--apply", "--restore=/b/x.json"],
  ["--foo"],
];
for (const args of invalidArgs) assert.throws(() => parseCliArgs(args), /uso: cleanupRejectedOrderFakeStatus/, JSON.stringify(args));

// O client (conexão com o banco) só é criado depois da validação dos argumentos.
for (const args of invalidArgs) {
  let created = 0;
  await assert.rejects(runCli(args, () => { created += 1; throw new Error("não deveria criar o client"); }, () => undefined), /uso: cleanupRejectedOrderFakeStatus/);
  assert.equal(created, 0, `client criado com argumentos inválidos: ${JSON.stringify(args)}`);
}

// ---------------------------------------------------------------------------------------------
// Banco: contagem divergente aborta, apply limpa, simulação seguinte encontra 0, restore reconstrói.
{
  const affected = attempt(reconciled);
  const untouched = attempt({ opportunityId: "opp-c" });
  const timeoutLike = attempt({ ...reconciled, opportunityId: "opp-d", erpResponse: { endpoint: "/orders", message: "Timeout ao chamar o ERP fictício", status: 504 } });
  const undetermined = attempt({ ...reconciled, opportunityId: "opp-e", erpResponse: { operation: RECONCILIATION_AUDIT_OPERATION, outcome: "rejected" } });
  const initial: Tables = {
    erpOrderSync: [affected, untouched, timeoutLike, undetermined],
    erpOrderStatusHistory: [
      history(affected.id, "ultrafv3-orders-error"),
      history(affected.id, HISTORY_SOURCE_RECONCILIATION),
      history(timeoutLike.id, HISTORY_SOURCE_RECONCILIATION, "opp-d"),
    ],
    timelineEvent: [
      timeline("opp-a", `Pedido ERP ${affected.numPedido}: situação atualizada para FINALIZADO.`),
      timeline("opp-a", "Comentário fictício", inWindow, "comentario"),
      timeline("opp-d", `Pedido ERP ${timeoutLike.numPedido}: situação atualizada para FINALIZADO.`),
    ],
  };
  const { db, run, state } = createDb(initial);
  const backupDir = mkdtempSync(join(tmpdir(), "cleanup-rejected-order-"));

  const before = await loadCleanupPlan(db);
  assert.deepEqual([before.attempts.length, before.history.length, before.timeline.length], [1, 1, 1], "possível timeout fica fora do conjunto");
  assert.equal(summarizePlan(before).excluidasPossivelTimeout, 1);

  // Simulação pela CLI com client injetado: imprime só contagens e não grava nada.
  const printed: string[] = [];
  let disconnected = false;
  const fakeClient = { ...db, $transaction: () => { throw new Error("simulação não abre transação"); }, $disconnect: async () => { disconnected = true; } } as unknown as CleanupClient;
  await runCli([], () => fakeClient, (line) => printed.push(line));
  assert.ok(disconnected);
  assert.deepEqual(state(), clone(initial), "simulação não grava");
  const simulation = JSON.parse(printed.join("\n")) as Record<string, unknown>;
  assert.equal(simulation.definitivas, 1);
  assert.equal(simulation.excluidasClassificacaoIndeterminada, 1);
  assert.equal(simulation.excluidasPossivelTimeout, 1);
  for (const secret of [affected.id, timeoutLike.id, String(affected.numPedido), "opp-a", "tenant-ficticio"]) assert.ok(!printed.join("\n").includes(secret), `simulação vazou ${secret}`);

  await assert.rejects(applyCleanup(run, { expected: { attempts: 2, history: 1, timeline: 1 }, backupDir }), /Contagem divergente; nada foi gravado/);
  assert.deepEqual(state(), clone(initial), "contagem divergente não grava nada");
  assert.equal(readdirSync(backupDir).length, 0, "contagem divergente não grava backup");

  await assert.rejects(applyCleanup(run, { expected: { attempts: 1, history: 1, timeline: 1 }, backupDir: join(backupDir, "inexistente") }));
  assert.deepEqual(state(), clone(initial), "falha no backup não grava nada");

  const result = await applyCleanup(run, { expected: { attempts: 1, history: 1, timeline: 1 }, backupDir, now: new Date("2026-10-16T12:00:00.000Z") });
  const after = state();
  const cleaned = after.erpOrderSync.find((row) => row.id === affected.id)!;
  assert.equal(cleaned.operationalStatusRaw, null);
  assert.equal(cleaned.operationalOrderStatus, "UNKNOWN");
  assert.equal(cleaned.orderStatus, null);
  assert.equal(cleaned.lastStatusPayload, null);
  assert.equal(cleaned.statusSyncedAt, null);
  for (const field of ["status", "erpResponse", "syncErrors", "payloadSent", "numPedido", "pedidoIdImportacao"]) {
    assert.deepEqual(cleaned[field], (affected as Row)[field], `${field} não pode mudar`);
  }
  assert.deepEqual(after.erpOrderSync.find((row) => row.id === untouched.id), untouched);
  assert.deepEqual(after.erpOrderSync.find((row) => row.id === timeoutLike.id), clone(initial).erpOrderSync[2], "possível timeout não é alterado");
  assert.deepEqual(after.erpOrderSync.find((row) => row.id === undetermined.id), clone(initial).erpOrderSync[3], "classificação indeterminada não é alterada");
  assert.deepEqual(after.erpOrderStatusHistory.map((row) => [row.erpOrderSyncId, row.source]), [[affected.id, "ultrafv3-orders-error"], [timeoutLike.id, HISTORY_SOURCE_RECONCILIATION]]);
  assert.deepEqual(after.timelineEvent.map((row) => row.opportunityId), ["opp-a", "opp-d"]);
  assert.equal(after.timelineEvent[0].type, "comentario");

  const again = await loadCleanupPlan(db);
  assert.deepEqual([again.attempts.length, again.history.length, again.timeline.length], [0, 0, 0], "idempotente");
  assert.equal(again.excludedPossibleTimeout.length, 1);
  assert.equal(again.excludedUndetermined.length, 1);

  const backup = parseBackupFile(readFileSync(result.backupFile, "utf8"));
  assert.equal(backup.attempts.length, 1);
  assert.equal(backup.attempts[0].syncErrors, null, "backup guarda o estado completo, inclusive syncErrors");
  assert.deepEqual(backup.attempts[0].payloadSent, affected.payloadSent);
  await assert.rejects(applyCleanup(run, { expected: { attempts: 0, history: 0, timeline: 0 }, backupDir, now: new Date("2026-10-16T12:00:00.000Z") }), /EEXIST/, "backup nunca sobrescreve");

  await restoreFromBackup(run, backup);
  const restored = state();
  const sortById = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  assert.deepEqual(sortById(restored.erpOrderSync), sortById(clone(initial).erpOrderSync), "restore reconstrói a tentativa");
  assert.deepEqual(sortById(restored.erpOrderStatusHistory), sortById(clone(initial).erpOrderStatusHistory), "restore reconstrói o histórico");
  assert.deepEqual(sortById(restored.timelineEvent), sortById(clone(initial).timelineEvent), "restore reconstrói a timeline");

  await assert.rejects(restoreFromBackup(run, backup), /nada foi restaurado/, "restore em estado não limpo é recusado");
  assert.deepEqual(sortById(state().erpOrderSync), sortById(clone(initial).erpOrderSync));
}

console.log("cleanupRejectedOrderFakeStatus tests passed");
