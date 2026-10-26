/**
 * Clientes ativos sem tenant: preenche Client.tenantId dos clientes não arquivados, sem código do ERP e sem tenant
 * (cadastros manuais antigos). Só roda numa instalação com exatamente um tenant ativo, que é o tenant atribuído
 * (decisão do Giancarlos de 25/10/2026, mesmo critério do #997/#999). Cada cliente preenchido ganha uma linha em
 * ClientCodeAudit (operation "tenant_backfill"); nenhum outro campo do cliente muda.
 *
 * Fora do escopo, só contados: arquivados sem tenant (o scheduler passaria a reativá-los) e ativos sem tenant com
 * código do ERP (a sincronização autenticada é que adota o tenant deles).
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/backfillClientTenant.js                 (simulação: nada é gravado)
 *   node dist/scripts/backfillClientTenant.js --apply --expect=N
 *
 * Autocontido: importa só @prisma/client e módulos do Node. A simulação roda numa transação READ ONLY; o apply
 * refaz o plano numa transação serializável e só grava se o total for exatamente N. A saída traz só contagens:
 * nunca nome, código, documento ou ID de vendedor ou cliente.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

type ClientRow = { id: string; code: string | null; isArchived: boolean; ownerSellerId: string; ownerSeller: { isActive: boolean } };

export type ClientTenantDb = {
  tenant: {
    findMany(args: { where: { status: "active" }; select: { id: true }; take: 2 }): Promise<Array<{ id: string }>>;
  };
  client: {
    findMany(args: { where: { tenantId: null }; select: { id: true; code: true; isArchived: true; ownerSellerId: true; ownerSeller: { select: { isActive: true } } } }): Promise<ClientRow[]>;
    updateMany(args: { where: { id: { in: string[] }; tenantId: null; isArchived: false }; data: { tenantId: string } }): Promise<{ count: number }>;
  };
  clientCodeAudit: {
    createMany(args: { data: Array<{ clientId: string; oldValue: null; newValue: null; partnerErp: null; origin: string; requestId: string; metadata: { operation: "tenant_backfill"; tenantId: string } }> }): Promise<{ count: number }>;
  };
};

export type ClientTenantPlan = {
  tenantId: string;
  rows: Array<{ id: string; ownerSellerId: string; ownerIsActive: boolean }>;
  archivedOutOfScope: number;
  activeWithCodeOutOfScope: number;
};

export async function planClientTenantBackfill(db: ClientTenantDb): Promise<ClientTenantPlan> {
  const activeTenants = await db.tenant.findMany({ where: { status: "active" }, select: { id: true }, take: 2 });
  if (activeTenants.length !== 1) throw new Error(`É preciso exatamente um tenant ativo para atribuir os clientes; encontrado(s) ${activeTenants.length}. Nada foi gravado.`);
  const clients = await db.client.findMany({ where: { tenantId: null }, select: { id: true, code: true, isArchived: true, ownerSellerId: true, ownerSeller: { select: { isActive: true } } } });
  const active = clients.filter((client) => !client.isArchived);
  return {
    tenantId: activeTenants[0].id,
    rows: active
      .filter((client) => !client.code?.trim())
      .map((client) => ({ id: client.id, ownerSellerId: client.ownerSellerId, ownerIsActive: client.ownerSeller.isActive }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    archivedOutOfScope: clients.length - active.length,
    activeWithCodeOutOfScope: active.filter((client) => client.code?.trim()).length
  };
}

// Só contagens: alvo, donos, clientes de donos inativos e o que ficou fora do escopo.
export function summarizeClientTenantPlan(plan: ClientTenantPlan) {
  const inactiveOwners = plan.rows.filter((row) => !row.ownerIsActive);
  return {
    ativosSemTenant: plan.rows.length,
    donos: new Set(plan.rows.map((row) => row.ownerSellerId)).size,
    deDonosInativos: inactiveOwners.length,
    donosInativos: new Set(inactiveOwners.map((row) => row.ownerSellerId)).size,
    foraDoEscopo: { arquivadosSemTenant: plan.archivedOutOfScope, ativosSemTenantComCodigo: plan.activeWithCodeOutOfScope }
  };
}

export type TransactionRunner = <T>(fn: (tx: ClientTenantDb) => Promise<T>) => Promise<T>;

// Lote da gravação: fica longe do limite de parâmetros do Postgres.
const WRITE_CHUNK_SIZE = 1000;

export async function applyClientTenantBackfill(runInTransaction: TransactionRunner, options: { expected: number; requestId?: string }) {
  const requestId = options.requestId ?? `backfill-client-tenant:${randomUUID()}`;
  return runInTransaction(async (tx) => {
    const plan = await planClientTenantBackfill(tx);
    const summary = summarizeClientTenantPlan(plan);
    if (plan.rows.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.rows.length}.`);
    }
    let updated = 0;
    let audited = 0;
    for (let index = 0; index < plan.rows.length; index += WRITE_CHUNK_SIZE) {
      const ids = plan.rows.slice(index, index + WRITE_CHUNK_SIZE).map((row) => row.id);
      // As condições tenantId: null e isArchived: false garantem que nenhum cliente fora do plano é alterado.
      updated += (await tx.client.updateMany({ where: { id: { in: ids }, tenantId: null, isArchived: false }, data: { tenantId: plan.tenantId } })).count;
      audited += (await tx.clientCodeAudit.createMany({ data: ids.map((clientId) => ({
        clientId, oldValue: null, newValue: null, partnerErp: null, origin: "Script", requestId,
        metadata: { operation: "tenant_backfill" as const, tenantId: plan.tenantId }
      })) })).count;
    }
    if (updated !== plan.rows.length || audited !== plan.rows.length) throw new Error("Atualização divergente do plano; transação desfeita.");
    return { summary, updated, audited };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { mode: "simulate" } | { mode: "apply"; expected: number };

const USAGE = "uso: backfillClientTenant [--apply --expect=N]";

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

export type ClientTenantClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = ClientTenantDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => ClientTenantClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planClientTenantBackfill(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeClientTenantPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as ClientTenantDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 10_000 });
      const result = await applyClientTenantBackfill(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizados: result.updated, auditados: result.audited, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as ClientTenantClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
