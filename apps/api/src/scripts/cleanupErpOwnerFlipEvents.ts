/**
 * Manutenção: apaga da linha do tempo os eventos "Cliente atualizado via UltraFV3. Vendedor alterado de A
 * para B" que a sincronização gravou no vai e volta do dono do cliente (corrigido no PR #1043).
 *
 * Regra, por cliente (eventos de troca de vendedor da sincronização: padrão de troca de vendedor do
 * shared erpSyncTimeline, type status, com cliente e sem oportunidade), em ordem de createdAt e id:
 *   - ficam sempre o primeiro evento (a primeira troca) e o último (a que leva ao dono atual);
 *   - um evento do meio sai só quando a troca dele é desfeita depois: o dono anterior a ele (o dono
 *     gravado no evento anterior) volta a ser o dono num evento seguinte. A comparação usa ids.
 * O cliente fica inteiro de fora (nada apagado, só contado) quando:
 *   - a sequência não confere: cada texto precisa ser exatamente o modelo da sincronização com
 *     "de <dono do evento anterior> para <dono deste evento>" (pega troca manual no meio, fusão de
 *     duplicado misturando sequências e vendedor renomeado);
 *   - o dono do último evento é diferente do dono atual do cliente;
 *   - dois eventos do cliente têm o mesmo createdAt (ordem ambígua);
 *   - o cliente não foi encontrado.
 * Nenhum evento fora do padrão de troca de vendedor da sincronização é lido para apagar.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/cleanupErpOwnerFlipEvents.js                     (simulação, transação READ ONLY)
 *   node dist/scripts/cleanupErpOwnerFlipEvents.js --apply --expect=N --backup-dir=<dir>
 *   node dist/scripts/cleanupErpOwnerFlipEvents.js --restore=<arquivo>            (simulação da restauração)
 *   node dist/scripts/cleanupErpOwnerFlipEvents.js --restore=<arquivo> --apply
 *
 * O backup (JSON, permissão 600) é gravado antes de apagar, na mesma execução; se falhar, nada é apagado.
 * Imports: @prisma/client, @salesforce-pro/shared e módulos do Node (teste de contrato em
 * cleanupErpOwnerFlipEvents.test.ts). A saída traz só contagens: nunca nome, id ou código.
 */
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { ERP_SYNC_TIMELINE_PATTERNS, isErpSyncTimelineEvent } from "@salesforce-pro/shared";

// Padrão do shared para a troca de vendedor (conferido pelo teste) e modelo do texto de ultraFv3SyncService.ts.
export const OWNER_CHANGE_PATTERN = ERP_SYNC_TIMELINE_PATTERNS[0];
export const OWNER_CHANGE_PREFIX = "Cliente atualizado via UltraFV3. Vendedor alterado de ";
export const OWNER_CHANGE_SUFFIX = ". Oportunidades, atividades, autores e datas históricas foram preservados.";
export const TIMELINE_TYPE_STATUS = "status";
export const BACKUP_FORMAT = "cleanupErpOwnerFlipEvents/v1";
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, sem horário de verão desde 2019.
const CHUNK = 1000;

export const ownerChangeDescription = (fromLabel: string, toLabel: string) => `${OWNER_CHANGE_PREFIX}${fromLabel} para ${toLabel}${OWNER_CHANGE_SUFFIX}`;

export type FlipEventRow = {
  id: string;
  type: string;
  description: string;
  clientId: string | null;
  opportunityId: string | null;
  ownerSellerId: string;
  createdAt: Date;
};
export type FlipClientRow = { id: string; ownerSellerId: string };
export type FlipUserRow = { id: string; name: string | null };
export type FlipInput = { events: FlipEventRow[]; clients: FlipClientRow[]; users: FlipUserRow[] };

export type ExclusionReason = "sequenciaNaoConfere" | "donoAtualDiferente" | "horarioEmpatado" | "clienteNaoEncontrado";
export type FlipPlan = {
  totalEvents: number;
  toDelete: FlipEventRow[];
  clientsWithEvents: number;
  clientsCleaned: number;
  clientsWithoutFlip: number;
  excluded: Record<ExclusionReason, number>;
  eventsInExcludedClients: number;
  deletedPerClient: number[];
};

/** Evento de troca de vendedor gravado pela sincronização (só estes são considerados). */
export const isSyncOwnerChangeEvent = (event: FlipEventRow) =>
  event.type === TIMELINE_TYPE_STATUS &&
  event.clientId !== null &&
  event.opportunityId === null &&
  OWNER_CHANGE_PATTERN.test(event.description) &&
  isErpSyncTimelineEvent(event.description) &&
  event.description.startsWith(OWNER_CHANGE_PREFIX) &&
  event.description.endsWith(OWNER_CHANGE_SUFFIX);

const byTimeThenId = (a: FlipEventRow, b: FlipEventRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Decide, para um cliente, o motivo de ficar de fora ou os eventos a apagar. */
export function planClientFlips(
  events: FlipEventRow[],
  client: FlipClientRow | undefined,
  labelOf: (userId: string) => string,
): { excluded: ExclusionReason } | { toDelete: FlipEventRow[] } {
  if (!client) return { excluded: "clienteNaoEncontrado" };
  const sorted = [...events].sort(byTimeThenId);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].createdAt.getTime() === sorted[i - 1].createdAt.getTime()) return { excluded: "horarioEmpatado" };
  }
  if (sorted[sorted.length - 1].ownerSellerId !== client.ownerSellerId) return { excluded: "donoAtualDiferente" };
  if (!sorted[0].description.endsWith(` para ${labelOf(sorted[0].ownerSellerId)}${OWNER_CHANGE_SUFFIX}`)) return { excluded: "sequenciaNaoConfere" };
  for (let i = 1; i < sorted.length; i++) {
    const previousOwner = sorted[i - 1].ownerSellerId;
    const owner = sorted[i].ownerSellerId;
    if (owner === previousOwner || sorted[i].description !== ownerChangeDescription(labelOf(previousOwner), labelOf(owner))) {
      return { excluded: "sequenciaNaoConfere" };
    }
  }
  const toDelete: FlipEventRow[] = [];
  for (let i = 1; i < sorted.length - 1; i++) {
    const previousOwner = sorted[i - 1].ownerSellerId;
    if (sorted.slice(i + 1).some((later) => later.ownerSellerId === previousOwner)) toDelete.push(sorted[i]);
  }
  return { toDelete };
}

export function planFlipCleanup(input: FlipInput): FlipPlan {
  const names = new Map(input.users.map((user) => [user.id, user.name]));
  // Mesmo rótulo da sincronização: nome do usuário, senão o id.
  const labelOf = (userId: string) => names.get(userId) || userId;
  const clients = new Map(input.clients.map((client) => [client.id, client]));
  const byClient = new Map<string, FlipEventRow[]>();
  for (const event of input.events) {
    if (!isSyncOwnerChangeEvent(event)) continue;
    const list = byClient.get(event.clientId!) ?? [];
    list.push(event);
    byClient.set(event.clientId!, list);
  }
  const plan: FlipPlan = {
    totalEvents: 0,
    toDelete: [],
    clientsWithEvents: byClient.size,
    clientsCleaned: 0,
    clientsWithoutFlip: 0,
    excluded: { sequenciaNaoConfere: 0, donoAtualDiferente: 0, horarioEmpatado: 0, clienteNaoEncontrado: 0 },
    eventsInExcludedClients: 0,
    deletedPerClient: [],
  };
  for (const [clientId, events] of byClient) {
    plan.totalEvents += events.length;
    const result = planClientFlips(events, clients.get(clientId), labelOf);
    if ("excluded" in result) {
      plan.excluded[result.excluded] += 1;
      plan.eventsInExcludedClients += events.length;
    } else if (result.toDelete.length) {
      plan.clientsCleaned += 1;
      plan.toDelete.push(...result.toDelete);
      plan.deletedPerClient.push(result.toDelete.length);
    } else {
      plan.clientsWithoutFlip += 1;
    }
  }
  return plan;
}

const brasiliaMonth = (date: Date) => new Date(date.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 7);

/** Só contagens: nunca nome, id ou código. */
export function summarizePlan(plan: FlipPlan) {
  const porMes: Record<string, number> = {};
  for (const event of [...plan.toDelete].sort(byTimeThenId)) porMes[brasiliaMonth(event.createdAt)] = (porMes[brasiliaMonth(event.createdAt)] ?? 0) + 1;
  return {
    eventosTrocaDeVendedor: plan.totalEvents,
    eventosParaApagar: plan.toDelete.length,
    eventosMantidos: plan.totalEvents - plan.toDelete.length,
    clientesComTroca: plan.clientsWithEvents,
    clientesComLimpeza: plan.clientsCleaned,
    clientesSemVaiEVolta: plan.clientsWithoutFlip,
    clientesDeFora: plan.excluded,
    eventosEmClientesDeFora: plan.eventsInExcludedClients,
    clientesPorEventosApagados: {
      "1-10": plan.deletedPerClient.filter((count) => count <= 10).length,
      "11-100": plan.deletedPerClient.filter((count) => count > 10 && count <= 100).length,
      "101+": plan.deletedPerClient.filter((count) => count > 100).length,
    },
    eventosParaApagarPorMesBrasilia: porMes,
  };
}

// ---------------------------------------------------------------------------------------------
// Banco

export type FlipDb = {
  timelineEvent: {
    findMany(args: unknown): Promise<FlipEventRow[]>;
    deleteMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
  };
  client: { findMany(args: unknown): Promise<FlipClientRow[]> };
  user: { findMany(args: unknown): Promise<FlipUserRow[]> };
};
export type TransactionRunner = <T>(fn: (tx: FlipDb) => Promise<T>) => Promise<T>;

const EVENT_SELECT = { id: true, type: true, description: true, clientId: true, opportunityId: true, ownerSellerId: true, createdAt: true };
/** Filtro do banco: o mesmo do plano, repetido no deleteMany. */
const ownerChangeWhere = () => ({
  type: TIMELINE_TYPE_STATUS,
  clientId: { not: null },
  opportunityId: null,
  description: { startsWith: OWNER_CHANGE_PREFIX, endsWith: OWNER_CHANGE_SUFFIX },
});

const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) => items.slice(index * CHUNK, (index + 1) * CHUNK));

export async function loadFlipInput(db: FlipDb): Promise<FlipInput> {
  const events = await db.timelineEvent.findMany({ where: ownerChangeWhere(), select: EVENT_SELECT });
  const clientIds = [...new Set(events.map((event) => event.clientId).filter((id): id is string => Boolean(id)))];
  const clients: FlipClientRow[] = [];
  for (const chunk of chunks(clientIds)) clients.push(...(await db.client.findMany({ where: { id: { in: chunk } }, select: { id: true, ownerSellerId: true } })));
  const users = await db.user.findMany({ select: { id: true, name: true } });
  return { events, clients, users };
}

export type BackupFile = { format: typeof BACKUP_FORMAT; createdAt: string; events: Record<string, unknown>[] };

const writeBackupFile = (backupDir: string, backup: BackupFile) => {
  if (!statSync(backupDir).isDirectory()) throw new Error("--backup-dir não é um diretório.");
  const file = resolve(backupDir, `erp-owner-flip-events-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(backup, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  if (written.events.length !== backup.events.length) throw new Error("Backup gravado não confere com o estado lido; nada foi apagado.");
  return file;
};

export async function applyCleanup(runInTransaction: TransactionRunner, options: { expected: number; backupDir: string; now?: Date }) {
  return runInTransaction(async (tx) => {
    const plan = planFlipCleanup(await loadFlipInput(tx));
    if (plan.toDelete.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi apagado. esperado=${options.expected} encontrado=${plan.toDelete.length}`);
    }
    // Backup antes de apagar: se a gravação falhar, a exceção desfaz a transação sem apagar nada.
    const backupFile = writeBackupFile(options.backupDir, {
      format: BACKUP_FORMAT,
      createdAt: (options.now ?? new Date()).toISOString(),
      events: plan.toDelete.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
    });
    let removed = 0;
    for (const chunk of chunks(plan.toDelete.map((event) => event.id))) {
      removed += (await tx.timelineEvent.deleteMany({ where: { id: { in: chunk }, ...ownerChangeWhere() } })).count;
    }
    if (removed !== plan.toDelete.length) throw new Error("Remoção divergente do plano; transação desfeita.");
    return { summary: summarizePlan(plan), backupFile, removed };
  });
}

export function parseBackupFile(content: string): BackupFile {
  const backup = JSON.parse(content) as BackupFile;
  if (backup.format !== BACKUP_FORMAT || !Array.isArray(backup.events)) throw new Error("Arquivo de backup em formato inesperado.");
  for (const event of backup.events) {
    for (const field of ["id", "type", "description", "clientId", "opportunityId", "ownerSellerId", "createdAt"]) {
      if (!(field in event)) throw new Error("Backup incompleto: evento sem todos os campos.");
    }
    const row = { ...event, createdAt: new Date(String(event.createdAt)) } as FlipEventRow;
    if (!isSyncOwnerChangeEvent(row)) throw new Error("Backup com evento fora do padrão de troca de vendedor da sincronização.");
  }
  return backup;
}

/** Sem `apply`, só confere e conta (nada é gravado). */
export async function restoreFromBackup(runInTransaction: TransactionRunner, backup: BackupFile, apply: boolean) {
  return runInTransaction(async (tx) => {
    const ids = backup.events.map((event) => String(event.id));
    const existing: FlipEventRow[] = [];
    for (const chunk of chunks(ids)) existing.push(...(await tx.timelineEvent.findMany({ where: { id: { in: chunk } }, select: { id: true } })));
    if (existing.length) throw new Error(`${existing.length} evento(s) do backup já existem; nada foi restaurado.`);
    if (!apply) return { modo: "simulação da restauração (nada foi gravado)", eventosParaRestaurar: ids.length };
    let created = 0;
    for (const chunk of chunks(backup.events)) {
      created += (await tx.timelineEvent.createMany({ data: chunk.map((event) => ({ ...event, createdAt: new Date(String(event.createdAt)) })) })).count;
    }
    if (created !== ids.length) throw new Error("Restauração divergente do backup; transação desfeita.");
    return { modo: "restore concluído", eventosRestaurados: created };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions =
  | { mode: "simulate" }
  | { mode: "apply"; expected: number; backupDir: string }
  | { mode: "restore"; file: string; apply: boolean };

const USAGE = "uso: cleanupErpOwnerFlipEvents [--apply --expect=N --backup-dir=<dir>] | [--restore=<arquivo> [--apply]]";

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--(apply|expect|backup-dir|restore)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    values.set(match[1], match[2] ?? true);
  }
  if (values.has("apply") && values.get("apply") !== true) throw new Error(USAGE);
  const restore = values.get("restore");
  if (values.has("restore")) {
    if (typeof restore !== "string" || values.has("expect") || values.has("backup-dir")) throw new Error(USAGE);
    return { mode: "restore", file: restore, apply: values.has("apply") };
  }
  if (values.has("apply")) {
    const expected = values.get("expect");
    if (typeof expected !== "string" || !/^\d+$/.test(expected)) throw new Error(`${USAGE}\n--apply exige --expect=N.`);
    const backupDir = values.get("backup-dir");
    if (typeof backupDir !== "string") throw new Error(`${USAGE}\n--apply exige --backup-dir=<dir>.`);
    return { mode: "apply", expected: Number(expected), backupDir };
  }
  if (values.size) throw new Error(`${USAGE}\nAs opções --expect e --backup-dir só valem com --apply.`);
  return { mode: "simulate" };
}

export type FlipClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = FlipDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => FlipClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  const runInTransaction: TransactionRunner = (fn) =>
    client.$transaction((tx) => fn(tx as FlipDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 10_000 });
  // Simulações: snapshot consistente e o banco recusa qualquer escrita nesta transação.
  const runReadOnly: TransactionRunner = (fn) =>
    client.$transaction(async (tx) => {
      const readOnly = tx as ReadOnlyTx;
      await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
      return fn(readOnly);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
  try {
    if (options.mode === "simulate") {
      const plan = await runReadOnly(async (tx) => planFlipCleanup(await loadFlipInput(tx)));
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizePlan(plan) }, null, 2));
    } else if (options.mode === "apply") {
      const result = await applyCleanup(runInTransaction, { expected: options.expected, backupDir: options.backupDir });
      log(JSON.stringify({ modo: "apply concluído", eventosApagados: result.removed, backup: result.backupFile, ...result.summary }, null, 2));
    } else {
      const backup = parseBackupFile(readFileSync(options.file, "utf8"));
      log(JSON.stringify(await restoreFromBackup(options.apply ? runInTransaction : runReadOnly, backup, options.apply), null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as FlipClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
