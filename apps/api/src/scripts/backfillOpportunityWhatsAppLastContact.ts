/**
 * Histórico do WhatsApp como contato: leva Opportunity.lastContactAt das oportunidades ABERTAS de cada cliente
 * para a última mensagem ENVIADA (pelo CRM ou pelo app do celular) das conversas vinculadas ao cliente
 * (CommunicationConversation.lastOutboundAt, de qualquer número da empresa), quando essa data é mais recente
 * que o valor atual. Nunca volta a data para trás. Mensagem só recebida não conta. Daqui para frente a API já
 * grava na ingestão e no envio (services/whatsappMessages/whatsappLastContact.ts).
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/backfillOpportunityWhatsAppLastContact.js                 (simulação: nada é gravado)
 *   node dist/scripts/backfillOpportunityWhatsAppLastContact.js --apply --expect=N
 *
 * Autocontido: importa só @prisma/client e módulos do Node. A simulação roda numa transação READ ONLY; o apply
 * refaz o plano numa transação serializável e só grava se o total for exatamente N. A saída traz só contagens:
 * nunca nome, código, documento, telefone ou ID de cliente, conversa ou oportunidade.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

const CLOSED_STAGES = ["ganho", "perdido"] as const;

export type WhatsAppLastContactDb = {
  communicationConversation: {
    groupBy(args: {
      by: ["clientId"];
      where: { clientId: { not: null }; lastOutboundAt: { not: null } };
      _max: { lastOutboundAt: true };
    }): Promise<Array<{ clientId: string | null; _max: { lastOutboundAt: Date | null } }>>;
  };
  opportunity: {
    findMany(args: {
      where: { clientId: { in: string[] }; stage: { notIn: string[] } };
      select: { id: true; clientId: true; stage: true; lastContactAt: true };
    }): Promise<Array<{ id: string; clientId: string; stage: string; lastContactAt: Date | null }>>;
    updateMany(args: {
      where: { id: string; stage: { notIn: string[] }; OR: [{ lastContactAt: null }, { lastContactAt: { lt: Date } }] };
      data: { lastContactAt: Date };
    }): Promise<{ count: number }>;
  };
};

export type WhatsAppLastContactUpdate = { opportunityId: string; stage: string; from: Date | null; to: Date };

// Lote da leitura das oportunidades: fica longe do limite de parâmetros do Postgres.
const READ_CHUNK_SIZE = 1000;
const chunks = <T>(items: T[], size = READ_CHUNK_SIZE) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function planWhatsAppLastContactBackfill(db: WhatsAppLastContactDb): Promise<{ clientsWithSent: number; updates: WhatsAppLastContactUpdate[] }> {
  const latest = await db.communicationConversation.groupBy({
    by: ["clientId"],
    where: { clientId: { not: null }, lastOutboundAt: { not: null } },
    _max: { lastOutboundAt: true }
  });
  const latestByClient = new Map<string, Date>();
  for (const row of latest) if (row.clientId && row._max.lastOutboundAt) latestByClient.set(row.clientId, row._max.lastOutboundAt);

  const updates: WhatsAppLastContactUpdate[] = [];
  for (const ids of chunks([...latestByClient.keys()])) {
    const opportunities = await db.opportunity.findMany({
      where: { clientId: { in: ids }, stage: { notIn: [...CLOSED_STAGES] } },
      select: { id: true, clientId: true, stage: true, lastContactAt: true }
    });
    for (const opportunity of opportunities) {
      const sentAt = latestByClient.get(opportunity.clientId);
      if (!sentAt) continue;
      if (!opportunity.lastContactAt || opportunity.lastContactAt < sentAt) {
        updates.push({ opportunityId: opportunity.id, stage: opportunity.stage, from: opportunity.lastContactAt, to: sentAt });
      }
    }
  }
  updates.sort((a, b) => a.opportunityId.localeCompare(b.opportunityId));
  return { clientsWithSent: latestByClient.size, updates };
}

// Só contagens: total, quantas estavam sem data e quantas por etapa.
export function summarizeWhatsAppLastContactPlan(plan: { clientsWithSent: number; updates: WhatsAppLastContactUpdate[] }) {
  const byStage: Record<string, number> = {};
  for (const update of plan.updates) byStage[update.stage] = (byStage[update.stage] ?? 0) + 1;
  return {
    clientesComMensagemEnviada: plan.clientsWithSent,
    seriamAtualizadas: plan.updates.length,
    semUltimoContatoAntes: plan.updates.filter((update) => update.from === null).length,
    comUltimoContatoMaisAntigo: plan.updates.filter((update) => update.from !== null).length,
    porEtapa: Object.fromEntries(Object.entries(byStage).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export type TransactionRunner = <T>(fn: (tx: WhatsAppLastContactDb) => Promise<T>) => Promise<T>;

export async function applyWhatsAppLastContactBackfill(runInTransaction: TransactionRunner, options: { expected: number }) {
  return runInTransaction(async (tx) => {
    const plan = await planWhatsAppLastContactBackfill(tx);
    const summary = summarizeWhatsAppLastContactPlan(plan);
    if (plan.updates.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.updates.length}.`);
    }
    let updated = 0;
    for (const update of plan.updates) {
      // A condição repete a regra: só oportunidade aberta e só avança, nunca volta a data para trás.
      updated += (await tx.opportunity.updateMany({
        where: { id: update.opportunityId, stage: { notIn: [...CLOSED_STAGES] }, OR: [{ lastContactAt: null }, { lastContactAt: { lt: update.to } }] },
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

const USAGE = "uso: backfillOpportunityWhatsAppLastContact [--apply --expect=N]";

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

export type WhatsAppLastContactClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = WhatsAppLastContactDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => WhatsAppLastContactClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planWhatsAppLastContactBackfill(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeWhatsAppLastContactPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as WhatsAppLastContactDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 10_000 });
      const result = await applyWhatsAppLastContactBackfill(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizadas: result.updated, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as WhatsAppLastContactClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
