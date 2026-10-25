import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyClientAddressFix,
  parseCliArgs,
  planClientAddressFix,
  runCli,
  summarizeClientAddressPlan,
  type ClientAddressClient,
  type ClientAddressDb,
  type TransactionRunner,
} from "./fixManualClientAddress.js";

// Clientes fictícios (só os municípios são reais, do catálogo público do IBGE); banco simulado. Endereço manual fora
// da lista oficial: corrige UF/cidade quando o nome existe numa única UF, preenche o tenant, e só relata o resto.
type Row = Record<string, any>;

// Contrato: no container, além de @prisma/client e do Node, só o catálogo (código puro, sem banco).
const scriptSource = readFileSync(fileURLToPath(new URL("./fixManualClientAddress.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
const allowed = new Set(["@prisma/client", "../services/brazilMunicipalities.js", "../utils/normalize.js"]);
for (const specifier of specifiers) assert.ok(allowed.has(specifier) || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"]);

const fixture = (tenants: Row[] = [{ id: "tenant-ficticio", status: "active" }]) => {
  const clients: Row[] = [
    { id: "cli-1", code: null, isArchived: false, state: "PR", city: "CAARAPO", tenantId: null, ownerSellerId: "vendedor-ficticio" },
    { id: "cli-2", code: "", isArchived: false, state: "pr", city: "Navirai", tenantId: "tenant-ficticio", ownerSellerId: "vendedor-ficticio" },
    { id: "cli-3", code: null, isArchived: false, state: "PR", city: "SÃO SEBASTIÃO", tenantId: null, ownerSellerId: "vendedor-ficticio" },
    { id: "cli-4", code: null, isArchived: false, state: "PR", city: "Cidade Inexistente Ficticia", tenantId: null, ownerSellerId: "vendedor-ficticio" },
    // Fica como está: endereço válido, código do ERP (o ERP é dono) e arquivado.
    { id: "cli-5", code: null, isArchived: false, state: "PR", city: "TOLEDO", tenantId: null, ownerSellerId: "vendedor-ficticio" },
    { id: "cli-6", code: "99999", isArchived: false, state: "PR", city: "CAARAPO", tenantId: null, ownerSellerId: "vendedor-ficticio" },
    { id: "cli-7", code: null, isArchived: true, state: "PR", city: "CAARAPO", tenantId: null, ownerSellerId: "vendedor-ficticio" },
  ];
  const events: Row[] = [];
  const db: ClientAddressDb = {
    tenant: { findMany: async ({ take }) => tenants.filter((tenant) => tenant.status === "active").slice(0, take).map((tenant) => ({ id: tenant.id })) },
    client: {
      findMany: async ({ where }) => {
        assert.equal(where.isArchived, false);
        return clients
          .filter((row) => !row.isArchived && (row.code === null || row.code === ""))
          .map(({ id, state, city, tenantId, ownerSellerId }) => ({ id, state, city, tenantId, ownerSellerId }));
      },
      updateMany: async ({ where, data }) => {
        const row = clients.find((client) => client.id === where.id && client.state === where.state && client.city === where.city && !client.isArchived);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    timelineEvent: { create: async ({ data }) => { events.push(data); return data; } },
  };
  return { clients, events, db };
};

const results: string[] = [];

// 1. Plano: corrige só quem tem nome numa única UF; relata o resto; resumo sem IDs.
{
  const { db } = fixture();
  const plan = await planClientAddressFix(db);
  assert.deepEqual(plan.fixes.map((fix) => [fix.id, fix.toState, fix.toCity]), [["cli-1", "MS", "Caarapó"], ["cli-2", "MS", "Naviraí"]]);
  assert.deepEqual(plan.reportOnly.map((item) => item.reason).sort(), ["nenhuma UF", "várias UFs"]);
  const summary = summarizeClientAddressPlan(plan);
  assert.equal(summary.aCorrigir, 2);
  assert.equal(summary.tenantPreenchido, 1, "só quem estava sem tenant");
  assert.deepEqual(summary.correcoes, { "PR/CAARAPO -> MS/Caarapó": 1, "PR/Navirai -> MS/Naviraí": 1 });
  assert.equal(summary.soRelatorio, 2);
  assert.ok(Object.keys(summary.relatorio).some((line) => line.startsWith("PR/SÃO SEBASTIÃO: nome em várias UFs (") && line.includes("SP")));
  assert.ok(Object.keys(summary.relatorio).includes("PR/Cidade Inexistente Ficticia: nome em nenhuma UF"));
  assert.doesNotMatch(JSON.stringify(summary), /cli-|vendedor-ficticio|tenant-ficticio/, "saída sem IDs");
  results.push("plan=PASS");
}

// 2. Um tenant ativo, exatamente: senão nada é feito.
{
  await assert.rejects(planClientAddressFix(fixture([]).db), /exatamente um tenant ativo/);
  await assert.rejects(planClientAddressFix(fixture([{ id: "t1", status: "active" }, { id: "t2", status: "active" }]).db), /exatamente um tenant ativo/);
  results.push("single_tenant_only=PASS");
}

// 3. Apply: --expect divergente não grava; certo corrige, preenche tenant, registra no histórico e é idempotente.
{
  const { clients, events, db } = fixture();
  const run: TransactionRunner = (fn) => fn(db);
  await assert.rejects(applyClientAddressFix(run, { expected: 3 }), /Contagem divergente; nada foi gravado/);
  assert.equal(events.length, 0);
  assert.equal(clients.find((row) => row.id === "cli-1")!.state, "PR");

  const result = await applyClientAddressFix(run, { expected: 2 });
  assert.equal(result.updated, 2);
  const caarapo = clients.find((row) => row.id === "cli-1")!;
  assert.deepEqual([caarapo.state, caarapo.city, caarapo.cityNormalized, caarapo.tenantId], ["MS", "Caarapó", "caarapó", "tenant-ficticio"]);
  const navirai = clients.find((row) => row.id === "cli-2")!;
  assert.deepEqual([navirai.state, navirai.city, navirai.tenantId], ["MS", "Naviraí", "tenant-ficticio"]);
  assert.deepEqual(clients.filter((row) => ["cli-3", "cli-4", "cli-5", "cli-6", "cli-7"].includes(row.id)).map((row) => row.state), ["PR", "PR", "PR", "PR", "PR"], "relatório, válido, ERP e arquivado intactos");
  assert.equal(clients.find((row) => row.id === "cli-3")!.tenantId, null, "só relatório: tenant não muda");
  assert.deepEqual(events.map((event) => [event.type, event.clientId, event.description]), [
    ["status", "cli-1", "Endereço corrigido pela lista oficial do IBGE: CAARAPO/PR para Caarapó/MS."],
    ["status", "cli-2", "Endereço corrigido pela lista oficial do IBGE: Navirai/PR para Naviraí/MS."],
  ]);
  const again = await planClientAddressFix(db);
  assert.equal(again.fixes.length, 0, "segunda rodada não tem o que corrigir");
  results.push("apply_expect_idempotent=PASS");
}

// 4. Cliente alterado depois do plano: a gravação não bate e a transação é desfeita.
{
  const { clients, db } = fixture();
  const racing: ClientAddressDb = {
    ...db,
    client: {
      ...db.client,
      updateMany: async (args) => {
        clients.find((row) => row.id === "cli-2")!.city = "Outro Nome Ficticio";
        return db.client.updateMany(args);
      },
    },
  };
  await assert.rejects(applyClientAddressFix((fn) => fn(racing), { expected: 2 }), /divergente do plano/);
  results.push("concurrent_change_guard=PASS");
}

// 5. CLI: argumentos validados antes de conectar; simulação em transação READ ONLY e sem IDs.
{
  assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
  assert.deepEqual(parseCliArgs(["--apply", "--expect=2"]), { mode: "apply", expected: 2 });
  for (const bad of [["--apply"], ["--expect=2"], ["--apply", "--expect=x"], ["--apply=1", "--expect=2"], ["--outro"], ["--apply", "--apply", "--expect=2"]]) {
    assert.throws(() => parseCliArgs(bad), /uso: fixManualClientAddress/, bad.join(" "));
  }
  let connected = false;
  await assert.rejects(runCli(["--expect=2"], () => { connected = true; throw new Error("não deveria conectar"); }), /uso:/);
  assert.equal(connected, false);

  const { db } = fixture();
  const statements: string[] = [];
  const options: Row[] = [];
  let disconnected = false;
  const client: ClientAddressClient = {
    $transaction: async (fn, opts) => {
      options.push(opts);
      return fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } });
    },
    $disconnect: async () => { disconnected = true; },
  };
  const lines: string[] = [];
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(options[0].isolationLevel, "RepeatableRead");
  assert.equal(disconnected, true);
  const output = JSON.parse(lines.join("\n"));
  assert.equal(output.modo, "simulação (nada foi gravado)");
  assert.equal(output.aCorrigir, 2);
  assert.doesNotMatch(lines.join("\n"), /cli-|vendedor-ficticio|tenant-ficticio/);
  results.push("cli_args_read_only_no_ids=PASS");
}

console.log(`FIX_MANUAL_CLIENT_ADDRESS=PASS ${results.join(" ")}`);
