import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyClientTenantBackfill,
  parseCliArgs,
  planClientTenantBackfill,
  runCli,
  summarizeClientTenantPlan,
  type ClientTenantClient,
  type ClientTenantDb,
  type TransactionRunner,
} from "./backfillClientTenant.js";

// Dados fictícios; banco simulado. Clientes ativos, sem código do ERP e sem tenantId recebem o único tenant ativo,
// só com --apply --expect=N, com uma auditoria por cliente; nenhum outro campo muda e a saída não traz IDs.
type Row = Record<string, any>;

// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const scriptSource = readFileSync(fileURLToPath(new URL("./backfillClientTenant.ts", import.meta.url)), "utf8");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.ok(specifiers.length > 0);
for (const specifier of specifiers) assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"]);

const fixture = (tenants: Row[] = [{ id: "tenant-ficticio", status: "active" }]) => {
  const sellers: Row[] = [
    { id: "vendedor-ficticio-a", isActive: true },
    { id: "vendedor-ficticio-b", isActive: true },
    { id: "vendedor-ficticio-inativo", isActive: false },
  ];
  const clients: Row[] = [
    { id: "cliente-1", code: null, isArchived: false, ownerSellerId: "vendedor-ficticio-a", tenantId: null, name: "Fazenda Fictícia Um", city: "Cidade Fictícia" },
    { id: "cliente-2", code: "", isArchived: false, ownerSellerId: "vendedor-ficticio-a", tenantId: null, name: "Fazenda Fictícia Dois", city: "Cidade Fictícia" },
    { id: "cliente-3", code: "  ", isArchived: false, ownerSellerId: "vendedor-ficticio-b", tenantId: null, name: "Fazenda Fictícia Três", city: "Cidade Fictícia" },
    { id: "cliente-4", code: null, isArchived: false, ownerSellerId: "vendedor-ficticio-inativo", tenantId: null, name: "Fazenda Fictícia Quatro", city: "Cidade Fictícia" },
    // Fora do escopo: arquivados sem tenant, ativo com código do ERP e cliente que já tem tenant.
    { id: "cliente-5", code: null, isArchived: true, ownerSellerId: "vendedor-ficticio-a", tenantId: null, name: "Arquivado Fictício", city: "Cidade Fictícia" },
    { id: "cliente-6", code: "C-FICT-6", isArchived: true, ownerSellerId: "vendedor-ficticio-b", tenantId: null, name: "Arquivado Fictício Com Código", city: "Cidade Fictícia" },
    { id: "cliente-7", code: "C-FICT-7", isArchived: false, ownerSellerId: "vendedor-ficticio-b", tenantId: null, name: "Ativo Fictício Com Código", city: "Cidade Fictícia" },
    { id: "cliente-8", code: null, isArchived: false, ownerSellerId: "vendedor-ficticio-a", tenantId: "tenant-ficticio", name: "Já Atribuído", city: "Cidade Fictícia" },
  ];
  const original = clients.map((client) => ({ ...client }));
  const writes: Row[] = [];
  const audits: Row[] = [];
  const db: ClientTenantDb = {
    tenant: { findMany: async ({ take }) => tenants.filter((tenant) => tenant.status === "active").slice(0, take).map((tenant) => ({ id: tenant.id })) },
    client: {
      findMany: async () => clients.filter((row) => row.tenantId === null).map((row) => ({
        id: row.id, code: row.code, isArchived: row.isArchived, ownerSellerId: row.ownerSellerId,
        ownerSeller: { isActive: sellers.find((seller) => seller.id === row.ownerSellerId)!.isActive },
      })),
      updateMany: async ({ where, data }) => {
        assert.deepEqual(Object.keys(data), ["tenantId"], "só o tenantId é gravado");
        let count = 0;
        for (const row of clients) {
          if (!where.id.in.includes(row.id) || row.tenantId !== null || row.isArchived !== where.isArchived) continue;
          row.tenantId = data.tenantId;
          writes.push({ id: row.id, tenantId: data.tenantId });
          count += 1;
        }
        return { count };
      },
    },
    clientCodeAudit: {
      createMany: async ({ data }) => { audits.push(...data); return { count: data.length }; },
    },
  };
  return { clients, original, writes, audits, db };
};

// Plano: só ativos sem código e sem tenant; resumo só com contagens.
{
  const { db } = fixture();
  const plan = await planClientTenantBackfill(db);
  assert.equal(plan.tenantId, "tenant-ficticio");
  assert.deepEqual(plan.rows.map((row) => row.id), ["cliente-1", "cliente-2", "cliente-3", "cliente-4"]);
  assert.deepEqual(summarizeClientTenantPlan(plan), {
    ativosSemTenant: 4, donos: 3, deDonosInativos: 1, donosInativos: 1,
    foraDoEscopo: { arquivadosSemTenant: 2, ativosSemTenantComCodigo: 1 },
  });
}

// Mais de um tenant ativo (ou nenhum): recusa sem gravar.
{
  const { db, writes, audits } = fixture([{ id: "tenant-ficticio", status: "active" }, { id: "tenant-ficticio-2", status: "active" }]);
  await assert.rejects(planClientTenantBackfill(db), /exatamente um tenant ativo/);
  await assert.rejects(applyClientTenantBackfill((fn) => fn(db), { expected: 4 }), /exatamente um tenant ativo/);
  assert.equal(writes.length + audits.length, 0);
  const none = fixture([{ id: "tenant-ficticio", status: "suspended" }]);
  await assert.rejects(planClientTenantBackfill(none.db), /encontrado\(s\) 0/);
}

// Argumentos: simulação por padrão; --apply exige --expect=N.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=62"]), { mode: "apply", expected: 62 });
assert.throws(() => parseCliArgs(["--apply"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--expect=4"]), /só vale com --apply/);
assert.throws(() => parseCliArgs(["--apply", "--expect=quatro"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--apply", "--apply", "--expect=4"]), /uso:/);
assert.throws(() => parseCliArgs(["--force"]), /uso:/);

const directRunner = (db: ClientTenantDb): TransactionRunner => (fn) => fn(db);

// Contagem divergente: nada é gravado.
{
  const { db, writes, audits } = fixture();
  await assert.rejects(applyClientTenantBackfill(directRunner(db), { expected: 5 }), /Contagem divergente; nada foi gravado/);
  await assert.rejects(applyClientTenantBackfill(directRunner(db), { expected: 0 }), /Contagem divergente/);
  assert.equal(writes.length + audits.length, 0);
}

// Contagem certa: grava só o tenantId dos ativos sem código, audita cada um e rodar de novo não acha mais nada.
{
  const { db, writes, audits, clients, original } = fixture();
  const result = await applyClientTenantBackfill(directRunner(db), { expected: 4, requestId: "req-ficticio" });
  assert.equal(result.updated, 4);
  assert.equal(result.audited, 4);
  assert.deepEqual(writes.map((write) => write.id), ["cliente-1", "cliente-2", "cliente-3", "cliente-4"]);
  assert.deepEqual(audits.map((audit) => audit.clientId), ["cliente-1", "cliente-2", "cliente-3", "cliente-4"]);
  for (const audit of audits) {
    assert.deepEqual(audit, {
      clientId: audit.clientId, oldValue: null, newValue: null, partnerErp: null, origin: "Script", requestId: "req-ficticio",
      metadata: { operation: "tenant_backfill", tenantId: "tenant-ficticio" },
    });
  }
  for (const client of clients) {
    const before = original.find((row) => row.id === client.id)!;
    const target = ["cliente-1", "cliente-2", "cliente-3", "cliente-4"].includes(client.id);
    assert.deepEqual(client, target ? { ...before, tenantId: "tenant-ficticio" } : before, `cliente ${client.id}: nenhum outro campo muda`);
  }
  assert.equal((await planClientTenantBackfill(db)).rows.length, 0);
}

// Sem requestId explícito: um único requestId gerado para o lote todo.
{
  const { db, audits } = fixture();
  await applyClientTenantBackfill(directRunner(db), { expected: 4 });
  assert.equal(new Set(audits.map((audit) => audit.requestId)).size, 1);
  assert.match(audits[0].requestId, /^backfill-client-tenant:[0-9a-f-]{36}$/);
}

// Cliente arquivado entre o plano e a gravação: a contagem não fecha e a transação é desfeita.
{
  const { db, clients } = fixture();
  const racing: ClientTenantDb = { ...db, client: { ...db.client, updateMany: async (args) => { clients.find((row) => row.id === "cliente-2")!.isArchived = true; return db.client.updateMany(args); } } };
  await assert.rejects(applyClientTenantBackfill(directRunner(racing), { expected: 4 }), /Atualização divergente do plano/);
}

// CLI: simulação em transação READ ONLY e saída só com contagens (sem IDs nem nomes).
{
  const { db, writes, audits } = fixture();
  const statements: string[] = [];
  const lines: string[] = [];
  let disconnected = false;
  const client: ClientTenantClient = {
    $transaction: async (fn) => fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => { disconnected = true; },
  };
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(writes.length + audits.length, 0, "simulação não grava");
  assert.equal(disconnected, true);
  const output = lines.join("\n");
  assert.match(output, /"ativosSemTenant": 4/);
  assert.match(output, /"arquivadosSemTenant": 2/);
  assert.doesNotMatch(output, /cliente-|vendedor-|tenant-ficticio|Fictíci|C-FICT/, "saída sem IDs, nomes ou códigos");
  let created = false;
  await assert.rejects(runCli(["--apply"], () => { created = true; return client; }), /--apply exige/);
  assert.equal(created, false, "argumento inválido nunca abre conexão");
}

// CLI: apply grava e a saída continua só com contagens.
{
  const { db, writes } = fixture();
  const lines: string[] = [];
  const client: ClientTenantClient = { $transaction: async (fn) => fn(db), $disconnect: async () => {} };
  await runCli(["--apply", "--expect=4"], () => client, (line) => lines.push(line));
  assert.equal(writes.length, 4);
  const output = lines.join("\n");
  assert.match(output, /"atualizados": 4/);
  assert.match(output, /"auditados": 4/);
  assert.doesNotMatch(output, /cliente-|vendedor-|tenant-ficticio|Fictíci|C-FICT/);
}

console.log("BACKFILL_CLIENT_TENANT=PASS plan_active_without_code=PASS single_tenant_only=PASS cli_args=PASS expect_mismatch_no_write=PASS apply_only_tenant_with_audit=PASS apply_idempotent=PASS race_rollback=PASS simulate_read_only_no_ids=PASS");
