/**
 * Histórico do último contato da oportunidade: leva Opportunity.lastContactAt para a data (Activity.date) da
 * atividade realizada mais recente vinculada a ela, quando essa data é mais recente que o valor atual. Nunca
 * volta a data para trás. É a mesma regra que a API passou a aplicar ao registrar uma atividade
 * (advanceOpportunityLastContactInTx em routes/crudRoutes.ts), base de "Proposta sem retorno".
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/backfillOpportunityLastContact.js                 (simulação: nada é gravado)
 *   node dist/scripts/backfillOpportunityLastContact.js --apply --expect=N
 *
 * Autocontido: importa só @prisma/client e módulos do Node. A simulação roda numa transação READ ONLY; o apply
 * refaz o plano numa transação serializável e só grava se o total for exatamente N. A saída traz só contagens:
 * nunca nome, código, documento ou ID de cliente ou de oportunidade.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

export type LastContactDb = {
  activity: {
    groupBy(args: {
      by: ["opportunityId"];
      where: { done: true; opportunityId: { not: null }; date: { not: null } };
      _max: { date: true };
    }): Promise<Array<{ opportunityId: string | null; _max: { date: Date | null } }>>;
  };
  opportunity: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; stage: true; lastContactAt: true } }): Promise<Array<{ id: string; stage: string; lastContactAt: Date | null }>>;
    updateMany(args: {
      where: { id: string; OR: [{ lastContactAt: null }, { lastContactAt: { lt: Date } }] };
      data: { lastContactAt: Date };
    }): Promise<{ count: number }>;
  };
};

export type LastContactUpdate = { opportunityId: string; stage: string; from: Date | null; to: Date };

// Lote da leitura das oportunidades: fica longe do limite de parâmetros do Postgres.
const READ_CHUNK_SIZE = 1000;
const chunks = <T>(items: T[], size = READ_CHUNK_SIZE) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function planLastContactBackfill(db: LastContactDb): Promise<{ withActivities: number; updates: LastContactUpdate[] }> {
  const latest = await db.activity.groupBy({
    by: ["opportunityId"],
    where: { done: true, opportunityId: { not: null }, date: { not: null } },
    _max: { date: true }
  });
  const latestByOpportunity = new Map<string, Date>();
  for (const row of latest) if (row.opportunityId && row._max.date) latestByOpportunity.set(row.opportunityId, row._max.date);

  const updates: LastContactUpdate[] = [];
  for (const ids of chunks([...latestByOpportunity.keys()])) {
    const opportunities = await db.opportunity.findMany({ where: { id: { in: ids } }, select: { id: true, stage: true, lastContactAt: true } });
    for (const opportunity of opportunities) {
      const activityDate = latestByOpportunity.get(opportunity.id)!;
      if (!opportunity.lastContactAt || opportunity.lastContactAt < activityDate) {
        updates.push({ opportunityId: opportunity.id, stage: opportunity.stage, from: opportunity.lastContactAt, to: activityDate });
      }
    }
  }
  updates.sort((a, b) => a.opportunityId.localeCompare(b.opportunityId));
  return { withActivities: latestByOpportunity.size, updates };
}

// Só contagens: total, quantas estavam sem data e quantas por etapa.
export function summarizeLastContactPlan(plan: { withActivities: number; updates: LastContactUpdate[] }) {
  const byStage: Record<string, number> = {};
  for (const update of plan.updates) byStage[update.stage] = (byStage[update.stage] ?? 0) + 1;
  return {
    oportunidadesComAtividadeRealizada: plan.withActivities,
    seriamAtualizadas: plan.updates.length,
    semUltimoContatoAntes: plan.updates.filter((update) => update.from === null).length,
    comUltimoContatoMaisAntigo: plan.updates.filter((update) => update.from !== null).length,
    porEtapa: Object.fromEntries(Object.entries(byStage).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export type TransactionRunner = <T>(fn: (tx: LastContactDb) => Promise<T>) => Promise<T>;

export async function applyLastContactBackfill(runInTransaction: TransactionRunner, options: { expected: number }) {
  return runInTransaction(async (tx) => {
    const plan = await planLastContactBackfill(tx);
    const summary = summarizeLastContactPlan(plan);
    if (plan.updates.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.updates.length}.`);
    }
    let updated = 0;
    for (const update of plan.updates) {
      // A condição repete a regra: só avança, nunca volta a data para trás.
      updated += (await tx.opportunity.updateMany({
        where: { id: update.opportunityId, OR: [{ lastContactAt: null }, { lastContactAt: { lt: update.to } }] },
        data: { lastContactAt: update.to }
      })).count;
    }
    if (updated !== plan.updates.length) throw new Error("Atualização divergente do plano; transação desfeita.");
    return { summary, updated };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { mode: "simulate" } | { mode: "apply"; expected: number };

const USAGE = "uso: backfillOpportunityLastContact [--apply --expect=N]";

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

export type LastContactClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = LastContactDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => LastContactClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planLastContactBackfill(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeLastContactPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as LastContactDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 10_000 });
      const result = await applyLastContactBackfill(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizadas: result.updated, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as LastContactClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
