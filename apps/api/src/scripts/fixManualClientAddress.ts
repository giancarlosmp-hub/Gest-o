/**
 * Endereço de cliente cadastrado à mão fora da lista oficial do IBGE (ex.: cidade do MS gravada com UF PR): corrige a
 * UF e o nome da cidade quando o nome existe em exatamente uma UF do Brasil e preenche o tenant (instalação com
 * exatamente um tenant ativo). Alvo: clientes não arquivados, sem código do ERP (o ERP é dono do cadastro dos demais)
 * e com o par UF/cidade fora do catálogo. Nome que existe em várias UFs (ex.: São Sebastião) ou em nenhuma só aparece
 * no relatório: o script nunca adivinha a UF.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/fixManualClientAddress.js                 (simulação: nada é gravado)
 *   node dist/scripts/fixManualClientAddress.js --apply --expect=N
 *
 * A simulação roda numa transação READ ONLY; o apply refaz o plano numa transação serializável e só grava se o total a
 * corrigir for exatamente N. Cada cliente corrigido ganha um evento no histórico. A saída traz só UF, cidade e
 * contagens: nunca nome, código, documento ou ID de cliente ou vendedor.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { findBrazilMunicipality, statesWithMunicipalityNamed } from "../services/brazilMunicipalities.js";
import { normalizeText } from "../utils/normalize.js";

type ClientRow = { id: string; state: string; city: string; tenantId: string | null; ownerSellerId: string };

export type ClientAddressDb = {
  tenant: {
    findMany(args: { where: { status: "active" }; select: { id: true }; take: 2 }): Promise<Array<{ id: string }>>;
  };
  client: {
    findMany(args: {
      where: { isArchived: false; OR: Array<{ code: null } | { code: string }> };
      select: { id: true; state: true; city: true; tenantId: true; ownerSellerId: true };
    }): Promise<ClientRow[]>;
    updateMany(args: {
      where: { id: string; state: string; city: string; isArchived: false };
      data: { state: string; city: string; cityNormalized: string; tenantId?: string };
    }): Promise<{ count: number }>;
  };
  timelineEvent: {
    create(args: { data: { type: "status"; clientId: string; ownerSellerId: string; description: string } }): Promise<unknown>;
  };
};

export type ClientAddressFix = ClientRow & { toState: string; toCity: string };
export type ClientAddressReport = { state: string; city: string; reason: "várias UFs" | "nenhuma UF"; states: string[] };
export type ClientAddressPlan = { tenantId: string; fixes: ClientAddressFix[]; reportOnly: ClientAddressReport[] };

export async function planClientAddressFix(db: ClientAddressDb): Promise<ClientAddressPlan> {
  const activeTenants = await db.tenant.findMany({ where: { status: "active" }, select: { id: true }, take: 2 });
  if (activeTenants.length !== 1) throw new Error(`É preciso exatamente um tenant ativo; encontrado(s) ${activeTenants.length}. Nada foi gravado.`);
  const rows = await db.client.findMany({
    where: { isArchived: false, OR: [{ code: null }, { code: "" }] },
    select: { id: true, state: true, city: true, tenantId: true, ownerSellerId: true }
  });
  const fixes: ClientAddressFix[] = [];
  const reportOnly: ClientAddressReport[] = [];
  for (const row of rows) {
    if (findBrazilMunicipality(row.state, row.city)) continue;
    const states = statesWithMunicipalityNamed(row.city);
    if (states.length === 1) {
      fixes.push({ ...row, toState: states[0], toCity: findBrazilMunicipality(states[0], row.city)!.city });
    } else {
      reportOnly.push({ state: row.state, city: row.city, reason: states.length ? "várias UFs" : "nenhuma UF", states });
    }
  }
  return { tenantId: activeTenants[0].id, fixes: fixes.sort((a, b) => a.id.localeCompare(b.id)), reportOnly };
}

const countBy = <T>(items: T[], keyOf: (item: T) => string) => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

// Só UF, cidade e contagens.
export function summarizeClientAddressPlan(plan: ClientAddressPlan) {
  return {
    aCorrigir: plan.fixes.length,
    tenantPreenchido: plan.fixes.filter((fix) => !fix.tenantId).length,
    correcoes: countBy(plan.fixes, (fix) => `${fix.state.trim().toUpperCase()}/${fix.city.trim()} -> ${fix.toState}/${fix.toCity}`),
    soRelatorio: plan.reportOnly.length,
    relatorio: countBy(plan.reportOnly, (item) => `${item.state.trim().toUpperCase()}/${item.city.trim()}: nome em ${item.reason}${item.states.length ? ` (${item.states.join(", ")})` : ""}`)
  };
}

export type TransactionRunner = <T>(fn: (tx: ClientAddressDb) => Promise<T>) => Promise<T>;

export async function applyClientAddressFix(runInTransaction: TransactionRunner, options: { expected: number }) {
  return runInTransaction(async (tx) => {
    const plan = await planClientAddressFix(tx);
    const summary = summarizeClientAddressPlan(plan);
    if (plan.fixes.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect=${options.expected}, encontrado ${plan.fixes.length}.`);
    }
    let updated = 0;
    for (const fix of plan.fixes) {
      // A condição pelo endereço antigo garante que um cliente alterado depois do plano não é sobrescrito.
      updated += (await tx.client.updateMany({
        where: { id: fix.id, state: fix.state, city: fix.city, isArchived: false },
        data: { state: fix.toState, city: fix.toCity, cityNormalized: normalizeText(fix.toCity), ...(fix.tenantId ? {} : { tenantId: plan.tenantId }) }
      })).count;
      await tx.timelineEvent.create({ data: {
        type: "status",
        clientId: fix.id,
        ownerSellerId: fix.ownerSellerId,
        description: `Endereço corrigido pela lista oficial do IBGE: ${fix.city.trim()}/${fix.state.trim().toUpperCase()} para ${fix.toCity}/${fix.toState}.`
      } });
    }
    if (updated !== plan.fixes.length) throw new Error("Atualização divergente do plano; transação desfeita.");
    return { summary, updated };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { mode: "simulate" } | { mode: "apply"; expected: number };

const USAGE = "uso: fixManualClientAddress [--apply --expect=N]";

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

export type ClientAddressClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = ClientAddressDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => ClientAddressClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const plan = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        return planClientAddressFix(readOnly);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizeClientAddressPlan(plan) }, null, 2));
    } else {
      const runInTransaction: TransactionRunner = (fn) =>
        client.$transaction((tx) => fn(tx as ClientAddressDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 10_000 });
      const result = await applyClientAddressFix(runInTransaction, { expected: options.expected });
      log(JSON.stringify({ modo: "apply concluído", atualizados: result.updated, ...result.summary }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as ClientAddressClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
