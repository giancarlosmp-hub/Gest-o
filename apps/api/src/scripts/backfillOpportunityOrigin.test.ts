import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as automations from "../services/commercialAutomationsService.js";
import {
  applyOriginBackfill,
  INACTIVE_RECENT_AUTOMATION_ORIGIN,
  parseCliArgs,
  planOriginBackfill,
  runCli,
  summarizeOriginPlan,
  WORKFLOW_INACTIVE_CLIENT_ORIGIN,
  type OriginClient,
  type OriginDb,
  type TransactionRunner,
} from "./backfillOpportunityOrigin.js";

// Dados fictícios; banco simulado. Preenche origin das oportunidades antigas da automação (marca nas notas, origin
// nula), sem mexer nas notas; só grava com --apply --expect=N e a saída não traz IDs.
type Row = Record<string, any>;

// Contrato: o script roda no container só com @prisma/client e módulos do Node; as constantes são as do serviço.
const scriptSource = readFileSync(fileURLToPath(new URL("./backfillOpportunityOrigin.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"]);
assert.equal(WORKFLOW_INACTIVE_CLIENT_ORIGIN, automations.WORKFLOW_INACTIVE_CLIENT_ORIGIN);
assert.equal(INACTIVE_RECENT_AUTOMATION_ORIGIN, automations.INACTIVE_RECENT_AUTOMATION_ORIGIN);
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
assert.equal(packageJson.scripts["opportunities:backfill-origin"], "node dist/scripts/backfillOpportunityOrigin.js");

const fixture = () => {
  const marked = `${WORKFLOW_INACTIVE_CLIENT_ORIGIN}\nInativo recente ficticio.`;
  const opportunities: Row[] = [
    { id: "opp-antiga-1", stage: "perdido", origin: null, notes: marked },
    { id: "opp-antiga-2", stage: "prospeccao", origin: null, notes: marked },
    { id: "opp-ja-com-origin", stage: "prospeccao", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, notes: marked },
    { id: "opp-nova", stage: "prospeccao", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN, notes: "Inativo recente ficticio." },
    { id: "opp-manual", stage: "negociacao", origin: null, notes: "Observação ficticia" },
    { id: "opp-sem-notas", stage: "perdido", origin: null, notes: null },
  ];
  const pending = (row: Row, where: Row) => row.origin === where.origin && typeof row.notes === "string" && row.notes.includes(where.notes.contains);
  const writes: Row[] = [];
  const db: OriginDb = {
    opportunity: {
      findMany: async ({ where }) => opportunities.filter((row) => pending(row, where)).map((row) => ({ id: row.id, stage: row.stage })),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of opportunities) {
          if (!where.id.in.includes(row.id) || !pending(row, where)) continue;
          row.origin = data.origin;
          writes.push({ id: row.id, ...data });
          count += 1;
        }
        return { count };
      },
    },
  };
  return { opportunities, writes, db };
};

// Plano: só origin nula com a marca nas notas.
{
  const { db } = fixture();
  const plan = await planOriginBackfill(db);
  assert.deepEqual(plan.map((row) => row.id), ["opp-antiga-1", "opp-antiga-2"]);
  assert.deepEqual(summarizeOriginPlan(plan), { seriamAtualizadas: 2, porEtapa: { perdido: 1, prospeccao: 1 } });
}

// Argumentos: simulação por padrão; --apply exige --expect=N.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=2"]), { mode: "apply", expected: 2 });
assert.throws(() => parseCliArgs(["--apply"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--expect=2"]), /só vale com --apply/);
assert.throws(() => parseCliArgs(["--apply", "--expect=dois"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--force"]), /uso:/);

const directRunner = (db: OriginDb): TransactionRunner => (fn) => fn(db);

// --expect errado: nada é gravado.
{
  const { db, writes } = fixture();
  await assert.rejects(applyOriginBackfill(directRunner(db), { expected: 3 }), /Contagem divergente; nada foi gravado. --expect=3, encontrado 2/);
  await assert.rejects(applyOriginBackfill(directRunner(db), { expected: 1 }), /Contagem divergente/);
  assert.equal(writes.length, 0);
}

// --expect certo: grava só origin, notas intactas; rodar de novo não acha mais nada.
{
  const { db, writes, opportunities } = fixture();
  const before = opportunities.map((row) => ({ id: row.id, notes: row.notes }));
  const result = await applyOriginBackfill(directRunner(db), { expected: 2 });
  assert.equal(result.updated, 2);
  assert.deepEqual(writes, [
    { id: "opp-antiga-1", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN },
    { id: "opp-antiga-2", origin: INACTIVE_RECENT_AUTOMATION_ORIGIN },
  ]);
  assert.deepEqual(opportunities.map((row) => ({ id: row.id, notes: row.notes })), before, "notas não mudam");
  const byId = (id: string) => opportunities.find((row) => row.id === id)!;
  assert.equal(byId("opp-manual").origin, null);
  assert.equal(byId("opp-sem-notas").origin, null);
  assert.equal((await planOriginBackfill(db)).length, 0);
}

// CLI: simulação em transação READ ONLY e saída só com contagens (sem IDs); apply com --expect errado não grava.
{
  const { db, writes } = fixture();
  const statements: string[] = [];
  const lines: string[] = [];
  let disconnected = 0;
  const client: OriginClient = {
    $transaction: async (fn) => fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => { disconnected += 1; },
  };
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(writes.length, 0, "simulação não grava");
  assert.equal(disconnected, 1);
  const output = lines.join("\n");
  assert.match(output, /"modo": "simulação \(nada foi gravado\)"/);
  assert.match(output, /"seriamAtualizadas": 2/);
  assert.doesNotMatch(output, /opp-|ficticia|ficticio/i, "saída sem IDs nem notas");
  await assert.rejects(runCli(["--apply", "--expect=5"], () => client, (line) => lines.push(line)), /Contagem divergente; nada foi gravado/);
  assert.equal(writes.length, 0, "--expect errado não grava");
  assert.equal(disconnected, 2, "desconecta mesmo com erro");
  let created = false;
  await assert.rejects(runCli(["--apply"], () => { created = true; return client; }), /--apply exige/);
  assert.equal(created, false, "argumento inválido nunca abre conexão");
}

console.log("BACKFILL_OPPORTUNITY_ORIGIN=PASS plan_marked_null_only=PASS cli_args=PASS expect_mismatch_no_write=PASS apply_origin_only_notes_intact=PASS simulate_read_only_no_ids=PASS");
