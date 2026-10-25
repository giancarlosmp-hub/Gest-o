/**
 * Território comercial sem tenant: preenche SellerTerritoryCity.tenantId das cidades gravadas sem ele (rotas antigas
 * de cadastro manual, lote e "Salvar" da configuração). Só roda numa instalação com exatamente um tenant ativo, que é
 * o tenant atribuído. A API já lê essas linhas nesse cenário; o script só deixa o dado explícito.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/backfillTerritoryCityTenant.js                 (simulação: nada é gravado)
 *   node dist/scripts/backfillTerritoryCityTenant.js --apply --expect=N
 *
 * Autocontido: importa só @prisma/client e módulos do Node. A simulação roda numa transação READ ONLY; o apply
 * refaz o plano numa transação serializável e só grava se o total for exatamente N. A saída traz só contagens:
 * nunca nome, código, documento ou ID de vendedor, cliente ou cidade.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

export type TerritoryTenantDb = {
  tenant: {
    findMany(args: { where: { status: "active" }; select: { id: true }; take: 2 }): Promise<Array<{ id: string }>>;
  };
  sellerTerritoryCity: {
    findMany(args: { where: { tenantId: null }; select: { id: true; state: true; sellerId: true; seller: { select: { isActive: true } } } }): Promise<Array<{ id: string; state: string; sellerId: string; seller: { isActive: boolean } }>>;
    updateMany(args: { where: { id: { in: string[] }; tenantId: null }; data: { tenantId: string } }): Promise<{ count: number }>;
  };
};

export type TerritoryTenantPlan = { tenantId: string; rows: Array<{ id: string; state: string; sellerId: string; sellerIsActive: boolean }> };

export async function planTerritoryTenantBackfill(db: TerritoryTenantDb): Promise<TerritoryTenantPlan> {
  const activeTenants = await db.tenant.findMany({ where: { status: "active" }, select: { id: true }, take: 2 });
  if (activeTenants.length !== 1) throw new Error(`É preciso exatamente um tenant ativo para atribuir as cidades; encontrado(s) ${activeTenants.length}. Nada foi gravado.`);
  const rows = await db.sellerTerritoryCity.findMany({ where: { tenantId: null }, select: { id: true, state: true, sellerId: true, seller: { select: { isActive: true } } } });
  return {
    tenantId: activeTenants[0].id,
    rows: rows.map((row) => ({ id: row.id, state: row.state, sellerId: row.sellerId, sellerIsActive: row.seller.isActive })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

// Só contagens: total, por UF, quantos vendedores e quantas cidades de vendedores inativos.
export function summarizeTerritoryTenantPlan(plan: TerritoryTenantPlan) {
  const byState: Record<string, number> = {};
  for (const row of plan.rows) {
    const state = row.state.trim().toUpperCase();
    byState[state] = (byState[state] ?? 0) + 1;
  }
  return {
    cidadesSemTenant: plan.rows.length,
    vendedores: new Set(plan.rows.map((row) => row.sellerId)).size,
    deVendedoresInativos: plan.rows.filter((row) => !row.sellerIsActive).length,
    porUF: Object.fromEntries(Object.entries(byState).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export type TransactionRunner = <T>(fn: (tx: TerritoryTenantDb) => Promise<T>) => Promise<T>;

// Lote da gravação: fica longe do limite de parâmetros do Postgres.
const WRITE_CHUNK_SIZE = 1000;

export async function applyTerritoryTenantBackfill(runInTransaction: TransactionRunner, options: { expected: number }) {
  return runInTransaction(async (tx) => {
    const plan = await planTerritoryTenantBackfill(tx);
    const summary = summarizeTerritoryTenantPlan(plan);
    if (plan.rows.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.rows.length}.`);
    }
    let updated = 0;
    for (let index = 0; index < plan.rows.length; index += WRITE_CHUNK_SIZE) {
      const ids = plan.rows.slice(index, index + WRITE_CHUNK_SIZE).map((row) => row.id);
      // A condição tenantId: null garante que nenhuma cidade já atribuída é alterada.
      updated += (await tx.sellerTerritoryCity.updateMany({ where: { id: { in: ids }, tenantId: null }, data: { tenantId: plan.tenantId } })).count;
    }
    if (updated !== plan.rows.length) throw new Error("Atualização divergente do plano; transação desfeita.");
    return { summary, updated };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { mode: "simulate" } | { mode: "apply"; expected: number };

const USAGE = "uso: backfillTerritoryCityTenant [--apply --expect=N]";

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

export type TerritoryTenantClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = TerritoryTenantDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => TerritoryTenantClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planTerritoryTenantBackfill(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeTerritoryTenantPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as TerritoryTenantDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 10_000 });
      const result = await applyTerritoryTenantBackfill(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizadas: result.updated, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as TerritoryTenantClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
