import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyLastContactBackfill,
  parseCliArgs,
  planLastContactBackfill,
  runCli,
  summarizeLastContactPlan,
  type LastContactClient,
  type LastContactDb,
  type TransactionRunner,
} from "./backfillOpportunityLastContact.js";

// Dados fictícios; banco simulado. Histórico do último contato: avança para a atividade realizada mais recente
// vinculada, nunca volta para trás, só grava com --apply --expect=N e a saída não traz IDs.
type Row = Record<string, any>;

// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const scriptSource = readFileSync(fileURLToPath(new URL("./backfillOpportunityLastContact.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"]);

const at = (iso: string) => new Date(iso);
const fixture = () => {
  const opportunities: Row[] = [
    { id: "opp-sem-contato", stage: "proposta", lastContactAt: null },
    { id: "opp-contato-antigo", stage: "proposta", lastContactAt: at("2026-10-01T12:00:00.000Z") },
    { id: "opp-contato-novo", stage: "negociacao", lastContactAt: at("2026-10-22T12:00:00.000Z") },
    { id: "opp-sem-atividade", stage: "proposta", lastContactAt: null },
  ];
  const activities: Row[] = [
    { opportunityId: "opp-sem-contato", done: true, date: at("2026-10-10T12:00:00.000Z") },
    { opportunityId: "opp-sem-contato", done: true, date: at("2026-10-15T12:00:00.000Z") },
    { opportunityId: "opp-contato-antigo", done: true, date: at("2026-10-20T12:00:00.000Z") },
    // Mais antiga que o valor atual: não volta a data.
    { opportunityId: "opp-contato-novo", done: true, date: at("2026-10-05T12:00:00.000Z") },
    // Pendente e sem data não contam.
    { opportunityId: "opp-sem-atividade", done: false, date: at("2026-10-21T12:00:00.000Z") },
    { opportunityId: "opp-sem-atividade", done: true, date: null },
    { opportunityId: null, done: true, date: at("2026-10-21T12:00:00.000Z") },
  ];
  const writes: Row[] = [];
  const db: LastContactDb = {
    activity: {
      groupBy: async ({ where }) => {
        const latest = new Map<string, Date>();
        for (const row of activities) {
          if (row.done !== where.done || row.opportunityId === null || row.date === null) continue;
          const current = latest.get(row.opportunityId);
          if (!current || row.date > current) latest.set(row.opportunityId, row.date);
        }
        return [...latest].map(([opportunityId, date]) => ({ opportunityId, _max: { date } }));
      },
    },
    opportunity: {
      findMany: async ({ where }) => opportunities.filter((row) => where.id.in.includes(row.id)).map((row) => ({ id: row.id, stage: row.stage, lastContactAt: row.lastContactAt })) as any,
      updateMany: async ({ where, data }) => {
        const row = opportunities.find((item) => item.id === where.id);
        if (!row || (row.lastContactAt !== null && !(row.lastContactAt < where.OR[1].lastContactAt.lt))) return { count: 0 };
        row.lastContactAt = data.lastContactAt;
        writes.push({ id: row.id, lastContactAt: data.lastContactAt });
        return { count: 1 };
      },
    },
  };
  return { opportunities, writes, db };
};

// Plano: só avança; pendente, sem data e sem oportunidade ficam fora.
{
  const { db } = fixture();
  const plan = await planLastContactBackfill(db);
  assert.equal(plan.withActivities, 3);
  assert.deepEqual(plan.updates.map((update) => [update.opportunityId, update.to.toISOString()]), [
    ["opp-contato-antigo", "2026-10-20T12:00:00.000Z"],
    ["opp-sem-contato", "2026-10-15T12:00:00.000Z"],
  ]);
  assert.deepEqual(summarizeLastContactPlan(plan), {
    oportunidadesComAtividadeRealizada: 3,
    seriamAtualizadas: 2,
    semUltimoContatoAntes: 1,
    comUltimoContatoMaisAntigo: 1,
    porEtapa: { proposta: 2 },
  });
}

// Argumentos: simulação por padrão; --apply exige --expect=N.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=2"]), { mode: "apply", expected: 2 });
assert.throws(() => parseCliArgs(["--apply"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--expect=2"]), /só vale com --apply/);
assert.throws(() => parseCliArgs(["--apply", "--expect=dois"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--force"]), /uso:/);

const directRunner = (db: LastContactDb): TransactionRunner => (fn) => fn(db);

// Contagem divergente: nada é gravado.
{
  const { db, writes } = fixture();
  await assert.rejects(applyLastContactBackfill(directRunner(db), { expected: 3 }), /Contagem divergente; nada foi gravado/);
  assert.equal(writes.length, 0);
}

// Contagem certa: grava e não volta nenhuma data.
{
  const { db, writes, opportunities } = fixture();
  const result = await applyLastContactBackfill(directRunner(db), { expected: 2 });
  assert.equal(result.updated, 2);
  assert.equal(writes.length, 2);
  const byId = (id: string) => opportunities.find((row) => row.id === id)!;
  assert.equal(byId("opp-sem-contato").lastContactAt.toISOString(), "2026-10-15T12:00:00.000Z");
  assert.equal(byId("opp-contato-antigo").lastContactAt.toISOString(), "2026-10-20T12:00:00.000Z");
  assert.equal(byId("opp-contato-novo").lastContactAt.toISOString(), "2026-10-22T12:00:00.000Z", "nunca volta para trás");
  assert.equal(byId("opp-sem-atividade").lastContactAt, null);
  // Rodar de novo não acha mais nada.
  assert.equal((await planLastContactBackfill(db)).updates.length, 0);
}

// CLI: simulação em transação READ ONLY e saída só com contagens (sem IDs).
{
  const { db, writes } = fixture();
  const statements: string[] = [];
  const lines: string[] = [];
  let disconnected = false;
  const client: LastContactClient = {
    $transaction: async (fn) => fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => { disconnected = true; },
  };
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(writes.length, 0, "simulação não grava");
  assert.equal(disconnected, true);
  const output = lines.join("\n");
  assert.match(output, /"seriamAtualizadas": 2/);
  assert.doesNotMatch(output, /opp-/, "saída sem IDs");
  let created = false;
  await assert.rejects(runCli(["--apply"], () => { created = true; return client; }), /--apply exige/);
  assert.equal(created, false, "argumento inválido nunca abre conexão");
}

console.log("BACKFILL_OPPORTUNITY_LAST_CONTACT=PASS plan_only_advances=PASS cli_args=PASS expect_mismatch_no_write=PASS apply_never_regresses=PASS simulate_read_only_no_ids=PASS");
