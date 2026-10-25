import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyTerritoryTenantBackfill,
  parseCliArgs,
  planTerritoryTenantBackfill,
  runCli,
  summarizeTerritoryTenantPlan,
  type TerritoryTenantClient,
  type TerritoryTenantDb,
  type TransactionRunner,
} from "./backfillTerritoryCityTenant.js";

// Dados fictícios; banco simulado. Cidades de território sem tenantId recebem o único tenant ativo, só com
// --apply --expect=N; cidades já atribuídas nunca mudam e a saída não traz IDs.
type Row = Record<string, any>;

// Contrato: o script roda no container só com @prisma/client e módulos do Node.
const scriptSource = readFileSync(fileURLToPath(new URL("./backfillTerritoryCityTenant.ts", import.meta.url)), "utf8");
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
  const cities: Row[] = [
    { id: "cidade-1", sellerId: "vendedor-ficticio-a", state: "PR", tenantId: null },
    { id: "cidade-2", sellerId: "vendedor-ficticio-a", state: "SC", tenantId: null },
    { id: "cidade-3", sellerId: "vendedor-ficticio-b", state: "PR", tenantId: null },
    { id: "cidade-4", sellerId: "vendedor-ficticio-inativo", state: "MS", tenantId: null },
    // Já atribuída: fica como está.
    { id: "cidade-5", sellerId: "vendedor-ficticio-b", state: "MS", tenantId: "tenant-ficticio" },
  ];
  const writes: Row[] = [];
  const db: TerritoryTenantDb = {
    tenant: { findMany: async ({ take }) => tenants.filter((tenant) => tenant.status === "active").slice(0, take).map((tenant) => ({ id: tenant.id })) },
    sellerTerritoryCity: {
      findMany: async () => cities.filter((row) => row.tenantId === null).map((row) => ({ id: row.id, state: row.state, sellerId: row.sellerId, seller: { isActive: sellers.find((seller) => seller.id === row.sellerId)!.isActive } })),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of cities) {
          if (!where.id.in.includes(row.id) || row.tenantId !== null) continue;
          row.tenantId = data.tenantId;
          writes.push({ id: row.id, tenantId: data.tenantId });
          count += 1;
        }
        return { count };
      },
    },
  };
  return { cities, writes, db };
};

// Plano: só cidades sem tenant; resumo só com contagens.
{
  const { db } = fixture();
  const plan = await planTerritoryTenantBackfill(db);
  assert.equal(plan.tenantId, "tenant-ficticio");
  assert.deepEqual(plan.rows.map((row) => row.id), ["cidade-1", "cidade-2", "cidade-3", "cidade-4"]);
  assert.deepEqual(summarizeTerritoryTenantPlan(plan), { cidadesSemTenant: 4, vendedores: 3, deVendedoresInativos: 1, porUF: { MS: 1, PR: 2, SC: 1 } });
}

// Mais de um tenant ativo (ou nenhum): recusa sem gravar.
{
  const { db, writes } = fixture([{ id: "tenant-ficticio", status: "active" }, { id: "tenant-ficticio-2", status: "active" }]);
  await assert.rejects(planTerritoryTenantBackfill(db), /exatamente um tenant ativo/);
  await assert.rejects(applyTerritoryTenantBackfill((fn) => fn(db), { expected: 4 }), /exatamente um tenant ativo/);
  assert.equal(writes.length, 0);
  const none = fixture([]);
  await assert.rejects(planTerritoryTenantBackfill(none.db), /encontrado\(s\) 0/);
}

// Argumentos: simulação por padrão; --apply exige --expect=N.
assert.deepEqual(parseCliArgs([]), { mode: "simulate" });
assert.deepEqual(parseCliArgs(["--apply", "--expect=344"]), { mode: "apply", expected: 344 });
assert.throws(() => parseCliArgs(["--apply"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--expect=4"]), /só vale com --apply/);
assert.throws(() => parseCliArgs(["--apply", "--expect=quatro"]), /--apply exige --expect=N/);
assert.throws(() => parseCliArgs(["--force"]), /uso:/);

const directRunner = (db: TerritoryTenantDb): TransactionRunner => (fn) => fn(db);

// Contagem divergente: nada é gravado.
{
  const { db, writes } = fixture();
  await assert.rejects(applyTerritoryTenantBackfill(directRunner(db), { expected: 5 }), /Contagem divergente; nada foi gravado/);
  assert.equal(writes.length, 0);
}

// Contagem certa: grava só as sem tenant e rodar de novo não acha mais nada.
{
  const { db, writes, cities } = fixture();
  const result = await applyTerritoryTenantBackfill(directRunner(db), { expected: 4 });
  assert.equal(result.updated, 4);
  assert.deepEqual(writes.map((write) => write.id), ["cidade-1", "cidade-2", "cidade-3", "cidade-4"]);
  assert.ok(cities.every((row) => row.tenantId === "tenant-ficticio"));
  assert.equal((await planTerritoryTenantBackfill(db)).rows.length, 0);
}

// CLI: simulação em transação READ ONLY e saída só com contagens (sem IDs).
{
  const { db, writes } = fixture();
  const statements: string[] = [];
  const lines: string[] = [];
  let disconnected = false;
  const client: TerritoryTenantClient = {
    $transaction: async (fn) => fn({ ...db, $executeRaw: async (query: TemplateStringsArray) => { statements.push(query.join("")); return 0; } }),
    $disconnect: async () => { disconnected = true; },
  };
  await runCli([], () => client, (line) => lines.push(line));
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert.equal(writes.length, 0, "simulação não grava");
  assert.equal(disconnected, true);
  const output = lines.join("\n");
  assert.match(output, /"cidadesSemTenant": 4/);
  assert.doesNotMatch(output, /cidade-|vendedor-|tenant-ficticio/, "saída sem IDs");
  let created = false;
  await assert.rejects(runCli(["--apply"], () => { created = true; return client; }), /--apply exige/);
  assert.equal(created, false, "argumento inválido nunca abre conexão");
}

console.log("BACKFILL_TERRITORY_CITY_TENANT=PASS plan_only_null=PASS single_tenant_only=PASS cli_args=PASS expect_mismatch_no_write=PASS apply_idempotent=PASS simulate_read_only_no_ids=PASS");
