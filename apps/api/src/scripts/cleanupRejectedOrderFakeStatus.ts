/**
 * Manutenção: remove a situação ERP falsa ("FINALIZADO" etc.) que a reconciliação de status
 * (`syncErpOrderStatuses`, antes da correção em `planErpOrderStatusLookup` /
 * `buildErpOrderStatusReconciliation`) gravou em tentativas de pedido recusadas no POST /orders,
 * e os eventos de histórico e timeline que ela gerou para essas tentativas.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/cleanupRejectedOrderFakeStatus.js
 *   node dist/scripts/cleanupRejectedOrderFakeStatus.js --apply --expect-attempts=N \
 *     --expect-history-events=N --expect-timeline-events=N --backup-dir=<dir>
 *   node dist/scripts/cleanupRejectedOrderFakeStatus.js --restore=<arquivo-de-backup>
 *
 * Autocontido: importa só @prisma/client e módulos do Node (teste de contrato em
 * cleanupRejectedOrderFakeStatus.test.ts). A saída traz só contagens: nunca nome, código de
 * cliente, valor ou ID.
 */
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

// Constantes locais espelhadas do schema e de erpOrderService.ts (conferidas pelo teste de contrato).
export const SEND_STATUS_ERROR = "error";
export const OPERATIONAL_STATUS_UNKNOWN = "UNKNOWN";
export const HISTORY_SOURCE_RECONCILIATION = "ultrafv3-order-status";
export const TIMELINE_TYPE_STATUS = "status";
export const RECONCILIATION_AUDIT_OPERATION = "orderStatus-reconciliation";
export const TIMELINE_PREFIX = "Pedido ERP ";
export const TIMELINE_INFIX = ": situação atualizada para ";
// 07/09/2026 00:00 a 14/09/2026 23:59:59.999 em Brasília (UTC-3, sem horário de verão).
export const TIMELINE_WINDOW_START = new Date("2026-09-07T03:00:00.000Z");
export const TIMELINE_WINDOW_END_EXCLUSIVE = new Date("2026-09-15T03:00:00.000Z");
// Mesma expressão de isUncertainErpOrderFailure (erpOrderService.ts).
export const UNCERTAIN_FAILURE_PATTERN = /(\"status\":504|timeout|Timeout|fora do ar|inacessível|unavailable|ECONNRESET|network|AbortError|TimeoutError)/i;
// Histórico gravado no catch do POST /orders com failure.message (sanitizeUltraOrderFailure).
export const HISTORY_SOURCE_POST_ERROR = "ultrafv3-orders-error";
export const POST_ERROR_MESSAGE_FORMAT = /^UltraFV3 rejeitou POST \/orders(?: \(status (\d+)\))?: /;
export const POST_ERROR_MESSAGE_MAX_LENGTH = 500;
export const BACKUP_FORMAT ="cleanupRejectedOrderFakeStatus/v1";

// Estado de uma tentativa recusada no POST que nunca passou pela reconciliação: o create grava
// os defaults do schema e o catch do envio só altera status, erpResponse e syncErrors.
export const CLEANED_ATTEMPT_FIELDS = ["operationalStatusRaw", "operationalOrderStatus", "orderStatus", "lastStatusPayload", "statusSyncedAt"] as const;

export type AttemptRow = {
  id: string;
  opportunityId: string;
  numPedido: string | null;
  status: string;
  operationalStatusRaw: string | null;
  operationalOrderStatus: string;
  orderStatus: string | null;
  lastStatusPayload: unknown;
  statusSyncedAt: Date | null;
  syncErrors: unknown;
  erpResponse: unknown;
  updatedAt: Date;
  [column: string]: unknown;
};
export type AttemptKeyRow = { id: string; opportunityId: string; numPedido: string | null };
export type HistoryRow = { id: string; erpOrderSyncId: string; source: string; occurredAt: Date; [column: string]: unknown };
export type TimelineRow = { id: string; type: string; opportunityId: string | null; description: string; createdAt: Date; [column: string]: unknown };

export type CleanupPlan = {
  attempts: AttemptRow[];
  history: HistoryRow[];
  timeline: TimelineRow[];
  ambiguousTimeline: TimelineRow[];
  /** error + situação, mas a falha parece timeout/rede: fora do apply, só contadas. */
  excludedPossibleTimeout: AttemptRow[];
  /** error + situação com erpResponse sobrescrito e sem fonte confiável do erro original: fora do apply. */
  excludedUndetermined: AttemptRow[];
  /** Quantas das definitivas foram classificadas pelo histórico do POST (erpResponse sobrescrito). */
  definitiveFromHistory: number;
};
export type ExpectedCounts = { attempts: number; history: number; timeline: number };

export const hasErpSituation = (attempt: Pick<AttemptRow, "operationalStatusRaw" | "operationalOrderStatus">) =>
  attempt.operationalStatusRaw !== null || attempt.operationalOrderStatus !== OPERATIONAL_STATUS_UNKNOWN;

/**
 * Mesma regra de planErpOrderStatusLookup: a tentativa error só é recusa definitiva quando o
 * erpResponse não parece timeout/rede (isUncertainErpOrderFailure com syncErrors = null).
 * Estimativa: aplica a expressão ao JSON sem a sanitização do serviço (que só mascara valores sensíveis).
 */
export const looksLikeTimeout = (attempt: Pick<AttemptRow, "erpResponse">) =>
  UNCERTAIN_FAILURE_PATTERN.test(JSON.stringify(attempt.erpResponse ?? {}));

export type AttemptClassification = "definitive" | "possible_timeout" | "undetermined";

/**
 * Classifica a falha original do POST /orders. Quando a reconciliação sobrescreveu o erpResponse,
 * a única outra cópia é o histórico `ultrafv3-orders-error`, que guarda só `failure.message`
 * (sanitizada, cortada em 500 caracteres) no formato "UltraFV3 rejeitou POST /orders (status N): ...".
 * O status é reconstruído dessa mensagem para aplicar a mesma expressão. Sem exatamente um registro
 * nesse formato, ou com a mensagem possivelmente cortada, a classificação é indeterminada.
 */
export function classifyRejectedAttempt(attempt: Pick<AttemptRow, "id" | "erpResponse">, history: HistoryRow[]): { classification: AttemptClassification; source: "erpResponse" | "history" | null } {
  if (!isReconciliationAudit(attempt.erpResponse)) {
    return { classification: looksLikeTimeout(attempt) ? "possible_timeout" : "definitive", source: "erpResponse" };
  }
  const postErrors = history.filter((row) => row.erpOrderSyncId === attempt.id && row.source === HISTORY_SOURCE_POST_ERROR);
  const message = postErrors.length === 1 ? postErrors[0].errorMessage : null;
  const format = typeof message === "string" ? POST_ERROR_MESSAGE_FORMAT.exec(message) : null;
  if (typeof message !== "string" || !format || message.length >= POST_ERROR_MESSAGE_MAX_LENGTH) return { classification: "undetermined", source: null };
  const original = { status: format[1] ? Number(format[1]) : null, endpoint: "/orders", message };
  return { classification: UNCERTAIN_FAILURE_PATTERN.test(JSON.stringify(original)) ? "possible_timeout" : "definitive", source: "history" };
}

const timelineKey = (attempt: AttemptKeyRow) => attempt.numPedido || attempt.id;

/** Situação lida pelo texto do evento quando ele segue o padrão exato da reconciliação para `key`. */
export const matchReconciliationTimeline = (description: string, key: string) => {
  const prefix = `${TIMELINE_PREFIX}${key}${TIMELINE_INFIX}`;
  if (!description.startsWith(prefix) || !description.endsWith(".")) return false;
  return description.length > prefix.length + 1;
};

const inTimelineWindow = (createdAt: Date) =>
  createdAt.getTime() >= TIMELINE_WINDOW_START.getTime() && createdAt.getTime() < TIMELINE_WINDOW_END_EXCLUSIVE.getTime();

/**
 * Critério por regra (nunca por ID):
 * a) tentativa com status = error, situação ERP preenchida e recusa definitiva (classifyRejectedAttempt:
 *    possível timeout/rede ou classificação indeterminada ficam de fora e só são contadas);
 * b) histórico com source = ultrafv3-order-status dessas tentativas;
 * c) timeline type = status, mesma oportunidade, texto exato da reconciliação com o número (ou id)
 *    da tentativa e createdAt na janela. Se o texto puder ser de outra tentativa da mesma
 *    oportunidade, o evento é ambíguo e não é removido.
 */
export function planRejectedOrderStatusCleanup(input: {
  errorAttempts: AttemptRow[];
  opportunityAttempts: AttemptKeyRow[];
  history: HistoryRow[];
  timeline: TimelineRow[];
}): CleanupPlan {
  const withSituation = input.errorAttempts.filter((attempt) => attempt.status === SEND_STATUS_ERROR && hasErpSituation(attempt));
  const classified = withSituation.map((attempt) => ({ attempt, ...classifyRejectedAttempt(attempt, input.history) }));
  const pick = (classification: AttemptClassification) => classified.filter((row) => row.classification === classification).map((row) => row.attempt);
  const attempts = pick("definitive");
  const excludedPossibleTimeout = pick("possible_timeout");
  const excludedUndetermined = pick("undetermined");
  const definitiveFromHistory = classified.filter((row) => row.classification === "definitive" && row.source === "history").length;
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const history = input.history.filter((row) => attemptIds.has(row.erpOrderSyncId) && row.source === HISTORY_SOURCE_RECONCILIATION);
  const timeline: TimelineRow[] = [];
  const ambiguousTimeline: TimelineRow[] = [];
  for (const event of input.timeline) {
    if (event.type !== TIMELINE_TYPE_STATUS || !inTimelineWindow(event.createdAt)) continue;
    const owners = attempts.filter((attempt) => attempt.opportunityId === event.opportunityId && matchReconciliationTimeline(event.description, timelineKey(attempt)));
    if (owners.length === 0) continue;
    const sameOpportunity = input.opportunityAttempts.filter((attempt) => attempt.opportunityId === event.opportunityId);
    const candidates = sameOpportunity.filter((attempt) =>
      matchReconciliationTimeline(event.description, timelineKey(attempt)) ||
      (attempt.numPedido !== null && matchReconciliationTimeline(event.description, attempt.numPedido)) ||
      matchReconciliationTimeline(event.description, attempt.id));
    if (owners.length === 1 && candidates.every((candidate) => candidate.id === owners[0].id)) timeline.push(event);
    else ambiguousTimeline.push(event);
  }
  return { attempts, history, timeline, ambiguousTimeline, excludedPossibleTimeout, excludedUndetermined, definitiveFromHistory };
}

export function findExpectedCountMismatches(plan: CleanupPlan, expected: ExpectedCounts) {
  const actual: ExpectedCounts = { attempts: plan.attempts.length, history: plan.history.length, timeline: plan.timeline.length };
  return (Object.keys(expected) as (keyof ExpectedCounts)[])
    .filter((key) => actual[key] !== expected[key])
    .map((key) => `${key}: esperado ${expected[key]}, encontrado ${actual[key]}`);
}

const brasiliaDate = (date: Date | null) => (date ? new Date(date.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10) : "sem data");

const countBy = <T>(rows: T[], key: (row: T) => string) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

const describeShape = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    const first = value[0];
    const entry = first && typeof first === "object" && !Array.isArray(first)
      ? `{${Object.entries(first as Record<string, unknown>).map(([key, child]) => `${key}:${Array.isArray(child) ? "array" : child === null ? "null" : typeof child}`).sort().join(",")}}`
      : typeof first;
    return `array[${value.length}] de ${entry}`;
  }
  return typeof value;
};

const isReconciliationAudit = (value: unknown): boolean => {
  const entry = Array.isArray(value) ? value[0] : value;
  return Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).operation === RECONCILIATION_AUDIT_OPERATION);
};

/**
 * Compara o bloqueio de reenvio (isUncertainErpOrderFailure lê `syncErrors ?? erpResponse`) com o
 * de uma recusa normal, cujo syncErrors é [falha original] e cujo erpResponse é a própria falha.
 * Estimativa: aplica a expressão ao JSON sem a sanitização do serviço (que só mascara valores sensíveis).
 */
export function classifyResendBlock(attempt: Pick<AttemptRow, "syncErrors" | "erpResponse">) {
  if (isReconciliationAudit(attempt.erpResponse)) return "indeterminado (erpResponse sobrescrito pela reconciliação)";
  const current = UNCERTAIN_FAILURE_PATTERN.test(JSON.stringify(attempt.syncErrors ?? attempt.erpResponse ?? {}));
  const reference = UNCERTAIN_FAILURE_PATTERN.test(JSON.stringify(attempt.erpResponse ?? {}));
  if (current === reference) return current ? "igual (bloqueia)" : "igual (não bloqueia)";
  return current ? "diferente (bloqueia hoje; recusa normal não bloquearia)" : "diferente (não bloqueia hoje; recusa normal bloquearia)";
}

export function summarizePlan(plan: CleanupPlan) {
  return {
    definitivas: plan.attempts.length,
    definitivasClassificadasPeloHistorico: plan.definitiveFromHistory,
    excluidasPossivelTimeout: plan.excludedPossibleTimeout.length,
    excluidasClassificacaoIndeterminada: plan.excludedUndetermined.length,
    historico: plan.history.length,
    timeline: plan.timeline.length,
    timelineAmbiguos: plan.ambiguousTimeline.length,
    tentativasPorSituacao: countBy(plan.attempts, (attempt) => attempt.operationalOrderStatus),
    tentativasPorDiaDaConferencia: countBy(plan.attempts, (attempt) => brasiliaDate(attempt.statusSyncedAt)),
    tentativasComOrderStatus: plan.attempts.filter((attempt) => attempt.orderStatus !== null).length,
    historicoPorDia: countBy(plan.history, (row) => brasiliaDate(row.occurredAt)),
    timelinePorDia: countBy(plan.timeline, (row) => brasiliaDate(row.createdAt)),
    timelineAmbiguosPorDia: countBy(plan.ambiguousTimeline, (row) => brasiliaDate(row.createdAt)),
    syncErrorsFormato: countBy(plan.attempts, (attempt) => `${isReconciliationAudit(attempt.syncErrors) ? "auditoria da reconciliação: " : ""}${describeShape(attempt.syncErrors)}`),
    bloqueioDeReenvioVsRecusaNormal: countBy(plan.attempts, classifyResendBlock),
  };
}

// ---------------------------------------------------------------------------------------------
// Banco: interface mínima do Prisma usada pelo script (o teste usa uma implementação em memória).

type Delegate = {
  findMany(args: unknown): Promise<unknown[]>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  createMany(args: unknown): Promise<{ count: number }>;
};
export type CleanupDb = {
  erpOrderSync: { findMany(args: unknown): Promise<unknown[]>; update(args: unknown): Promise<unknown> };
  erpOrderStatusHistory: Delegate;
  timelineEvent: Delegate;
};
export type TransactionRunner = <T>(fn: (tx: CleanupDb) => Promise<T>) => Promise<T>;

export async function loadCleanupPlan(db: CleanupDb) {
  const errorAttempts = (await db.erpOrderSync.findMany({ where: { status: SEND_STATUS_ERROR } })) as AttemptRow[];
  const affected = errorAttempts.filter(hasErpSituation);
  const attemptIds = affected.map((attempt) => attempt.id);
  const opportunityIds = [...new Set(affected.map((attempt) => attempt.opportunityId))];
  const [opportunityAttempts, history, timeline] = await Promise.all([
    db.erpOrderSync.findMany({ where: { opportunityId: { in: opportunityIds } }, select: { id: true, opportunityId: true, numPedido: true } }),
    db.erpOrderStatusHistory.findMany({ where: { erpOrderSyncId: { in: attemptIds } } }),
    db.timelineEvent.findMany({ where: { opportunityId: { in: opportunityIds }, type: TIMELINE_TYPE_STATUS } }),
  ]);
  return planRejectedOrderStatusCleanup({
    errorAttempts,
    opportunityAttempts: opportunityAttempts as AttemptKeyRow[],
    history: history as HistoryRow[],
    timeline: timeline as TimelineRow[],
  });
}

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  attempts: Record<string, unknown>[];
  history: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
};

const writeBackupFile = (backupDir: string, backup: BackupFile) => {
  if (!statSync(backupDir).isDirectory()) throw new Error("--backup-dir não é um diretório.");
  const file = resolve(backupDir, `rejected-order-fake-status-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(backup, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  if (written.attempts.length !== backup.attempts.length || written.history.length !== backup.history.length || written.timeline.length !== backup.timeline.length) {
    throw new Error("Backup gravado não confere com o estado lido.");
  }
  return file;
};

export async function applyCleanup(runInTransaction: TransactionRunner, options: { expected: ExpectedCounts; backupDir: string; now?: Date }) {
  return runInTransaction(async (tx) => {
    const plan = await loadCleanupPlan(tx);
    const mismatches = findExpectedCountMismatches(plan, options.expected);
    if (mismatches.length) throw new Error(`Contagem divergente; nada foi gravado. ${mismatches.join("; ")}`);
    const backupFile = writeBackupFile(options.backupDir, {
      format: BACKUP_FORMAT,
      createdAt: (options.now ?? new Date()).toISOString(),
      attempts: plan.attempts,
      history: plan.history,
      timeline: plan.timeline,
    });
    for (const attempt of plan.attempts) {
      await tx.erpOrderSync.update({
        where: { id: attempt.id },
        data: { operationalStatusRaw: null, operationalOrderStatus: OPERATIONAL_STATUS_UNKNOWN, orderStatus: null, lastStatusPayload: Prisma.DbNull, statusSyncedAt: null },
      });
    }
    const removedHistory = await tx.erpOrderStatusHistory.deleteMany({ where: { id: { in: plan.history.map((row) => row.id) } } });
    const removedTimeline = await tx.timelineEvent.deleteMany({ where: { id: { in: plan.timeline.map((row) => row.id) } } });
    if (removedHistory.count !== plan.history.length || removedTimeline.count !== plan.timeline.length) {
      throw new Error("Remoção divergente do plano; transação desfeita.");
    }
    return { summary: summarizePlan(plan), backupFile };
  });
}

const toDate = (value: unknown) => (value === null || value === undefined ? null : new Date(String(value)));
const toJsonInput = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue));

export function parseBackupFile(content: string): BackupFile {
  const backup = JSON.parse(content) as BackupFile;
  if (backup.format !== BACKUP_FORMAT || !Array.isArray(backup.attempts) || !Array.isArray(backup.history) || !Array.isArray(backup.timeline)) {
    throw new Error("Arquivo de backup em formato inesperado.");
  }
  for (const attempt of backup.attempts) {
    for (const field of ["id", "updatedAt", ...CLEANED_ATTEMPT_FIELDS]) {
      if (!(field in attempt)) throw new Error("Backup incompleto: tentativa sem todos os campos limpos.");
    }
  }
  return backup;
}

export async function restoreFromBackup(runInTransaction: TransactionRunner, backup: BackupFile) {
  return runInTransaction(async (tx) => {
    const ids = backup.attempts.map((attempt) => String(attempt.id));
    const current = (await tx.erpOrderSync.findMany({ where: { id: { in: ids } } })) as AttemptRow[];
    const notCleaned = current.filter((attempt) => attempt.status !== SEND_STATUS_ERROR || hasErpSituation(attempt) || attempt.orderStatus !== null || attempt.lastStatusPayload !== null || attempt.statusSyncedAt !== null);
    if (current.length !== ids.length || notCleaned.length) {
      throw new Error(`Estado atual não corresponde ao pós-limpeza (${ids.length - current.length} ausentes, ${notCleaned.length} alteradas); nada foi restaurado.`);
    }
    const existingHistory = await tx.erpOrderStatusHistory.findMany({ where: { id: { in: backup.history.map((row) => String(row.id)) } } });
    const existingTimeline = await tx.timelineEvent.findMany({ where: { id: { in: backup.timeline.map((row) => String(row.id)) } } });
    if (existingHistory.length || existingTimeline.length) throw new Error("Eventos do backup já existem; nada foi restaurado.");
    for (const attempt of backup.attempts) {
      await tx.erpOrderSync.update({
        where: { id: String(attempt.id) },
        data: {
          operationalStatusRaw: attempt.operationalStatusRaw,
          operationalOrderStatus: attempt.operationalOrderStatus,
          orderStatus: attempt.orderStatus,
          lastStatusPayload: toJsonInput(attempt.lastStatusPayload),
          statusSyncedAt: toDate(attempt.statusSyncedAt),
          updatedAt: toDate(attempt.updatedAt),
        },
      });
    }
    const createdHistory = backup.history.length
      ? await tx.erpOrderStatusHistory.createMany({ data: backup.history.map((row) => ({ ...row, occurredAt: toDate(row.occurredAt) })) })
      : { count: 0 };
    const createdTimeline = backup.timeline.length
      ? await tx.timelineEvent.createMany({ data: backup.timeline.map((row) => ({ ...row, createdAt: toDate(row.createdAt) })) })
      : { count: 0 };
    if (createdHistory.count !== backup.history.length || createdTimeline.count !== backup.timeline.length) {
      throw new Error("Restauração divergente do backup; transação desfeita.");
    }
    return { tentativas: backup.attempts.length, historico: createdHistory.count, timeline: createdTimeline.count };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions =
  | { mode: "simulate" }
  | { mode: "apply"; expected: ExpectedCounts; backupDir: string }
  | { mode: "restore"; file: string };

const USAGE = "uso: cleanupRejectedOrderFakeStatus [--apply --expect-attempts=N --expect-history-events=N --expect-timeline-events=N --backup-dir=<dir>] | [--restore=<arquivo>]";

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--(apply|expect-attempts|expect-history-events|expect-timeline-events|backup-dir|restore)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    values.set(match[1], match[2] ?? true);
  }
  const count = (key: string) => {
    const value = values.get(key);
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${USAGE}\n--apply exige --${key}=N.`);
    return Number(value);
  };
  const text = (key: string) => {
    const value = values.get(key);
    if (typeof value !== "string") throw new Error(`${USAGE}\n--${key}=<caminho> é obrigatório.`);
    return value;
  };
  if (values.has("restore")) {
    if (values.size !== 1) throw new Error(USAGE);
    return { mode: "restore", file: text("restore") };
  }
  if (values.has("apply")) {
    if (values.get("apply") !== true) throw new Error(USAGE);
    return {
      mode: "apply",
      expected: { attempts: count("expect-attempts"), history: count("expect-history-events"), timeline: count("expect-timeline-events") },
      backupDir: text("backup-dir"),
    };
  }
  if (values.size) throw new Error(`${USAGE}\nAs opções --expect-* e --backup-dir só valem com --apply.`);
  return { mode: "simulate" };
}

export type CleanupClient = CleanupDb & {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }): Promise<T>;
  $disconnect(): Promise<void>;
};

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => CleanupClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  const runInTransaction: TransactionRunner = (fn) =>
    client.$transaction((tx) => fn(tx as CleanupDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });
  try {
    if (options.mode === "simulate") {
      const plan = await loadCleanupPlan(client);
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizePlan(plan) }, null, 2));
    } else if (options.mode === "apply") {
      const result = await applyCleanup(runInTransaction, { expected: options.expected, backupDir: options.backupDir });
      log(JSON.stringify({ modo: "apply concluído", backup: result.backupFile, ...result.summary }, null, 2));
    } else {
      const backup = parseBackupFile(readFileSync(options.file, "utf8"));
      const result = await restoreFromBackup(runInTransaction, backup);
      log(JSON.stringify({ modo: "restore concluído", ...result }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as CleanupClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
