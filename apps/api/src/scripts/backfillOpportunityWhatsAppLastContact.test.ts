import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyWhatsAppLastContactBackfill,
  parseCliArgs,
  planWhatsAppLastContactBackfill,
  runCli,
  summarizeWhatsAppLastContactPlan,
  type TransactionRunner,
  type WhatsAppLastContactClient,
  type WhatsAppLastContactDb,
} from "./backfillOpportunityWhatsAppLastContact.js";

// Dados fictícios; banco simulado. Histórico do WhatsApp como contato: oportunidades abertas do cliente avançam
// para a última mensagem enviada das conversas vinculadas, nunca voltam para trás, só grava com --apply
// --expect=N e a saída não traz IDs.
type Row = Record<string, any>;

// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const scriptSource = readFileSync(fileURLToPath(new URL("./backfillOpportunityWhatsAppLastContact.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"]);

const at = (iso: string) => new Date(iso);
const fixture = () => {
  const conversations: Row[] = [
    // Duas conversas do mesmo cliente (números diferentes da empresa): vale a enviada mais recente.
    { clientId: "client-a", lastOutboundAt: at("2026-11-10T12:00:00.000Z") },
    { clientId: "client-a", lastOutboundAt: at("2026-11-12T12:00:00.000Z") },
    { clientId: "client-b", lastOutboundAt: at("2026-11-05T12:00:00.000Z") },
    // Só recebidas: não conta.
    { clientId: "client-c", lastOutboundAt: null },
    // Sem vínculo: não conta.
    { clientId: null, lastOutboundAt: at("2026-11-12T12:00:00.000Z") },
  ];
  const opportunities: Row[] = [
    { id: "opp-a-sem-contato", clientId: "client-a", stage: "proposta", lastContactAt: null },
    { id: "opp-a-antigo", clientId: "client-a", stage: "negociacao", lastContactAt: at("2026-11-01T12:00:00.000Z") },
    { id: "opp-a-ganha", clientId: "client-a", stage: "ganho", lastContactAt: null },
    { id: "opp-b-mais-novo", clientId: "client-b", stage: "proposta", lastContactAt: at("2026-11-08T12:00:00.000Z") },
    { id: "opp-c", clientId: "client-c", stage: "prospeccao", lastContactAt: null },
  ];
  const writes: Row[] = [];
  const db: WhatsAppLastContactDb = {
    communicationConversation: {
      groupBy: async () => {
        const latest = new Map<string, Date>();
        for (const row of conversations) {
          if (row.clientId === null || row.lastOutboundAt === null) continue;
          const current = latest.get(row.clientId);
          if (!current || row.lastOutboundAt > current) latest.set(row.clientId, row.lastOutboundAt);
        }
        return [...latest].map(([clientId, lastOutboundAt]) => ({ clientId, _max: { lastOutboundAt } }));
      },
    },
    opportunity: {
      findMany: async ({ where }) =>
        opportunities
          .filter((row) => where.clientId.in.includes(row.clientId) && !where.stage.notIn.includes(row.stage))
          .map((row) => ({ id: row.id, clientId: row.clientId, stage: row.stage, lastContactAt: row.lastContactAt })),
      updateMany: async ({ where, data }) => {
        const row = opportunities.find((item) => item.id === where.id);
        if (!row || where.stage.notIn.includes(row.stage)) return { count: 0 };
        if (row.lastContactAt !== null && !(row.lastContactAt < where.OR[1].lastContactAt.lt)) return { count: 0 };
        row.lastContactAt = data.lastContactAt;
        writes.push({ id: row.id, lastContactAt: data.lastContactAt });
        return { count: 1 };
      },
    },
  };
  return { opportunities, writes, db };
};

// Plano: só oportunidades abertas, só avança; recebida e conversa sem vínculo ficam fora.
{
  const { db } = fixture();
  const plan = await planWhatsAppLastContactBackfill(db);
  assert.equal(plan.clientsWithSent, 2);
  assert.deepEqual(plan.updates.map((update) => [update.opportunityId, update.to.toISOString()]), [
    ["opp-a-antigo", "2026-11-12T12:00:00.000Z"],
    ["opp-a-sem-contato", "2026-11-12T12:00:00.000Z"],
  ]);
  assert.deepEqual(summarizeWhatsAppLastContactPlan(plan), {
    clientesComMensagemEnviada: 2,
    seriamAtualizadas: 2,
    semUltimoContatoAntes: 1,
    comUltimoContatoMaisAntigo: 1,
    porEtapa: { negociacao: 1, proposta: 1 },
  });
}

// Argumentos: simulação por padrão; --apply exige --expect=N.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=2"]), { mode: "apply", expected: 2 });
assert.throws(() => parseCliArgs(["--apply"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--expect=2"]), /só vale com --apply/);
assert.throws(() => parseCliArgs(["--apply", "--expect=dois"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--force"]), /uso:/);

const directRunner = (db: WhatsAppLastContactDb): TransactionRunner => (fn) => fn(db);

// Contagem divergente: nada é gravado.
{
  const { db, writes } = fixture();
  await assert.rejects(applyWhatsAppLastContactBackfill(directRunner(db), { expected: 3 }), /Contagem divergente; nada foi gravado/);
  assert.equal(writes.length, 0);
}

// Contagem certa: grava, não volta nenhuma data e não toca oportunidade fechada.
{
  const { db, writes, opportunities } = fixture();
  const result = await applyWhatsAppLastContactBackfill(directRunner(db), { expected: 2 });
  assert.equal(result.updated, 2);
  assert.equal(writes.length, 2);
  const byId = (id: string) => opportunities.find((row) => row.id === id)!;
  assert.equal(byId("opp-a-sem-contato").lastContactAt.toISOString(), "2026-11-12T12:00:00.000Z");
  assert.equal(byId("opp-a-antigo").lastContactAt.toISOString(), "2026-11-12T12:00:00.000Z");
  assert.equal(byId("opp-a-ganha").lastContactAt, null, "fechada não muda");
  assert.equal(byId("opp-b-mais-novo").lastContactAt.toISOString(), "2026-11-08T12:00:00.000Z", "nunca volta para trás");
  assert.equal(byId("opp-c").lastContactAt, null, "só recebida não conta");
  // Rodar de novo não acha mais nada.
  assert.equal((await planWhatsAppLastContactBackfill(db)).updates.length, 0);
}

// CLI: simulação em transação READ ONLY e saída só com contagens (sem IDs).
{
  const { db, writes } = fixture();
  const statements: string[] = [];
  const lines: string[] = [];
  let disconnected = false;
  const client: WhatsAppLastContactClient = {
    $transaction: async (fn) => fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => { disconnected = true; },
  };
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(writes.length, 0, "simulação não grava");
  assert.equal(disconnected, true);
  const output = lines.join(" ");
  assert.match(output, /"seriamAtualizadas": 2/);
  assert.doesNotMatch(output, /opp-|client-/, "saída sem IDs");
  let created = false;
  await assert.rejects(runCli(["--apply"], () => { created = true; return client; }), /--apply exige/);
  assert.equal(created, false, "argumento inválido nunca abre conexão");
}

console.log("BACKFILL_OPPORTUNITY_WHATSAPP_LAST_CONTACT=PASS plan_open_only_advances=PASS cli_args=PASS expect_mismatch_no_write=PASS apply_never_regresses=PASS simulate_read_only_no_ids=PASS");
