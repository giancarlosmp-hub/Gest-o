/**
 * Origem das oportunidades antigas da automação de inativos recentes: preenche Opportunity.origin com
 * "automation:inactive_recent" nas oportunidades que têm a marca "workflow_cliente_sem_compra" nas notas e origin nulo
 * (criadas antes da coluna). Não mexe nas notas nem em nenhum outro campo.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/backfillOpportunityOrigin.js                 (simulação: nada é gravado)
 *   node dist/scripts/backfillOpportunityOrigin.js --apply --expect=N
 *
 * Autocontido: importa só @prisma/client e módulos do Node (as duas constantes repetem as de
 * services/commercialAutomationsService.ts; o teste confere). A simulação roda numa transação READ ONLY; o apply refaz
 * o plano numa transação serializável e só grava se o total for exatamente N. A saída traz só contagens: nunca nome,
 * código, documento ou ID de cliente ou de oportunidade.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

export const WORKFLOW_INACTIVE_CLIENT_ORIGIN = "workflow_cliente_sem_compra";
export const INACTIVE_RECENT_AUTOMATION_ORIGIN = "automation:inactive_recent";

type PendingWhere = { origin: null; notes: { contains: string } };
const pendingWhere: PendingWhere = { origin: null, notes: { contains: WORKFLOW_INACTIVE_CLIENT_ORIGIN } };

export type OriginDb = {
  opportunity: {
    findMany(args: { where: PendingWhere; select: { id: true; stage: true } }): Promise<Array<{ id: string; stage: string }>>;
    updateMany(args: { where: PendingWhere & { id: { in: string[] } }; data: { origin: string } }): Promise<{ count: number }>;
  };
};

// Lote da escrita: fica longe do limite de parâmetros do Postgres.
const WRITE_CHUNK_SIZE = 1000;
const chunks = <T>(items: T[], size = WRITE_CHUNK_SIZE) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function planOriginBackfill(db: OriginDb) {
  const rows = await db.opportunity.findMany({ where: pendingWhere, select: { id: true, stage: true } });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

// Só contagens: total e quantas por etapa.
export function summarizeOriginPlan(plan: Array<{ stage: string }>) {
  const byStage: Record<string, number> = {};
  for (const row of plan) byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
  return {
    seriamAtualizadas: plan.length,
    porEtapa: Object.fromEntries(Object.entries(byStage).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export type TransactionRunner = <T>(fn: (tx: OriginDb) => Promise<T>) => Promise<T>;

export async function applyOriginBackfill(runInTransaction: TransactionRunner, options: { expected: number }) {
  return runInTransaction(async (tx) => {
    const plan = await planOriginBackfill(tx);
    const summary = summarizeOriginPlan(plan);
    if (plan.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.length}.`);
    }
    let updated = 0;
    for (const ids of chunks(plan.map((row) => row.id))) {
      // A condição repete a regra: só preenche origin nula de quem tem a marca; notas intactas.
      updated += (await tx.opportunity.updateMany({ where: { id: { in: ids }, ...pendingWhere }, data: { origin: INACTIVE_RECENT_AUTOMATION_ORIGIN } })).count;
    }
    if (updated !== plan.length) throw new Error("Atualização divergente do plano; transação desfeita.");
    return { summary, updated };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { mode: "simulate" } | { mode: "apply"; expected: number };

const USAGE = "uso: backfillOpportunityOrigin [--apply --expect=N]";

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--(apply|expect)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    values.set(match[1], match[2] ?? true);
  }
  if (values.has("apply")) {
    if (values.get("apply") !== true) throw new Error(USAGE);
    const expected = values.get("expect");
    if (typeof expected !== "string" || !/^\d+$/.test(expected)) throw new Error(`${USAGE}\n--apply exige --expect=N.`);
    return { mode: "apply", expected: Number(expected) };
  }
  if (values.size) throw new Error(`${USAGE}\nA opção --expect só vale com --apply.`);
  return { mode: "simulate" };
}

export type OriginClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = OriginDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => OriginClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planOriginBackfill(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeOriginPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as OriginDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 10_000 });
      const result = await applyOriginBackfill(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizadas: result.updated, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as OriginClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
