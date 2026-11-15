import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEGACY_ARCHIVED_DUPLICATE_PREFIX,
  PARTNERS_CONFIG_KEY,
  PARTNERS_LAST_SEEN_CONFIG_KEY,
  PARTNER_CODE_KEYS,
  PARTNER_SELLER_CODE_KEYS,
  loadSimulationInput,
  runCli,
  simulatePartnerOwnerRule,
  type OwnerRuleClient,
  type SimulationInput,
} from "./simulatePartnerOwnerRule.js";

// Dados fictícios: usuários, tenants, códigos e ids inventados.

// ---------------------------------------------------------------------------------------------
// Contrato: só leitura, imports mínimos e constantes iguais às da sincronização.
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const importsOf = (text: string) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
const scriptSource = source("./simulatePartnerOwnerRule.ts");
const specifiers = importsOf(scriptSource);
assert.ok(specifiers.length > 0, "o teste de contrato precisa encontrar os imports");
for (const specifier of specifiers) {
  assert.ok(
    specifier === "@prisma/client" || specifier.startsWith("node:") || specifier === "../services/partnerOwnerRule.js",
    `import não permitido no script: ${specifier}`,
  );
}
assert.deepEqual(importsOf(source("../services/partnerOwnerRule.ts")), [], "a regra do dono não importa nada (roda no container sem config da API)");
assert.doesNotMatch(scriptSource, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRawUnsafe|\$queryRawUnsafe)\s*\(/, "o script não pode ter chamadas de escrita");
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"], "único SQL cru é o READ ONLY");
assert.doesNotMatch(scriptSource, /--apply|--write|--execute/, "não existe modo de gravação");

const sync = source("../services/ultraFv3SyncService.ts");
assert.ok(sync.includes(`const PARTNERS_CONFIG_KEY = "${PARTNERS_CONFIG_KEY}";`), "chave do cache do /partners divergente");
assert.ok(sync.includes(`const PARTNERS_LAST_SEEN_CONFIG_KEY = "${PARTNERS_LAST_SEEN_CONFIG_KEY}";`), "chave da data de visto divergente");
assert.ok(sync.includes(`const LEGACY_ARCHIVED_DUPLICATE_PREFIX = "${LEGACY_ARCHIVED_DUPLICATE_PREFIX}";`), "prefixo de duplicado divergente");
const codeBlock = /export const pickUltraFv3PartnerCode = [\s\S]*?\]\)\);/.exec(sync)?.[0] ?? "";
assert.deepEqual([...codeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_CODE_KEYS, "chaves do código do parceiro divergentes");
const sellerBlock = /const partnerSellerCodeKeys = \[[\s\S]*?\];/.exec(sync)?.[0] ?? "";
assert.deepEqual([...sellerBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_SELLER_CODE_KEYS, "chaves do vendedor do parceiro divergentes");
assert.ok(sync.includes('return String(raw).trim().toUpperCase() === "S" ? "customer" : "not_customer";'), "regra do IDN_CLIENTE mudou");
assert.ok(sync.includes("erpSellerCode: pickFirstString(payload, partnerSellerCodeKeys),"), "a sincronização deve usar o campo Vendedor do ERP na regra do dono");
assert.ok(sync.includes('where: { role: "vendedor", erpCode: { not: null }, isActive: true },'), "consulta de vendedores da sincronização mudou");

// ---------------------------------------------------------------------------------------------
// Simulação.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const RECENT = "2026-11-15T10:00:00.000Z";
const OLD = "2026-11-10T10:00:00.000Z";
const T = "tenant-ficticio";
const partner = (code: string, seller: string | null, flag = "S") => ({ PARCEIRO: code, IDN_CLIENTE: flag, ...(seller === null ? {} : { VENDEDOR_DO_PARCEIRO: seller }) });
const input: SimulationInput = {
  partnerCacheRows: [
    partner("8001", "101"), // dono atual B, ERP diz A → muda B → A
    partner("8002", "101"), // dono atual B, ERP diz A → muda B → A
    partner("8003", "0202"), // dono atual B, ERP diz B → sem mudança
    partner("8004", null), // campo vazio → sem vendedor no cadastro
    partner("8005", "999"), // vendedor sem usuário ativo
    partner("8006", "303"), // usuário ativo sem login FV3 → muda A → sem-login (arquivado)
    partner("8007", "101"), // não visto na janela → ignorado
    partner("8008", "101", "N"), // não é cliente → ignorado
    partner("8009", "101"), // sem cliente no CRM
    partner("8010", "101"), // código em dois clientes
    partner("8011", "101"), // cliente sem tenant
    { RAZAO_SOCIAL: "Sem codigo ficticio" },
    "linha invalida",
  ],
  partnerLastSeen: Object.fromEntries(["8001", "8002", "8003", "8004", "8005", "8006", "8008", "8009", "8010", "8011"].map((code) => [code, RECENT]).concat([["8007", OLD]])),
  users: [
    { id: "user-a", erpCode: "101", tenantMemberships: [{ tenantId: T }] },
    { id: "user-b", erpCode: "202", tenantMemberships: [{ tenantId: T }] },
    { id: "user-sem-login", erpCode: "303", tenantMemberships: [{ tenantId: T }] },
  ],
  clients: [
    { id: "cli-1", code: "8001", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-2", code: "8002", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-3", code: "8003", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-4", code: "8004", tenantId: T, ownerSellerId: "user-a", isArchived: false },
    { id: "cli-5", code: "8005", tenantId: T, ownerSellerId: "user-a", isArchived: false },
    { id: "cli-6", code: "8006", tenantId: T, ownerSellerId: "user-a", isArchived: true },
    { id: "cli-7", code: "8007", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-10a", code: "8010", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-10b", code: "8010", tenantId: T, ownerSellerId: "user-b", isArchived: false },
    { id: "cli-11", code: "8011", tenantId: null, ownerSellerId: "user-b", isArchived: false },
  ],
};
const summary = simulatePartnerOwnerRule(input, NOW);
assert.deepEqual(summary.cache, { linhas: 13, ignoradasNaoVistasNaJanela: 1, ignoradasNaoCliente: 1, ignoradasSemCodigo: 1, ignoradasInvalidas: 1 });
assert.deepEqual(summary.clientes, {
  avaliados: 6, mudariamDeDono: 3, mudariamDeDonoArquivados: 1, semMudanca: 1, semVendedorNoCadastro: 1,
  vendedorDoCadastroSemUsuarioAtivo: 1, semClienteNoCrmPeloCodigo: 1, codigoEmMaisDeUmCliente: 1, clienteSemTenant: 1,
});
assert.deepEqual(summary.mudancas, [
  { donoAtualId: "user-b", novoDonoId: "user-a", clientes: 2 },
  { donoAtualId: "user-a", novoDonoId: "user-sem-login", clientes: 1 },
]);

// A saída não traz id nem código de cliente.
const printed = JSON.stringify(summary);
for (const forbidden of ["cli-", "8001", "8006", "Sem codigo ficticio"]) assert.ok(!printed.includes(forbidden), `saída vazou dado de cliente: ${forbidden}`);

// ---------------------------------------------------------------------------------------------
// CLI: argumento inválido não conecta; leitura em transação READ ONLY; consulta filtra duplicados no banco.
let connected = 0;
await assert.rejects(runCli(["--apply"], () => { connected += 1; throw new Error("não deveria conectar"); }), /uso: simulatePartnerOwnerRule/);
assert.equal(connected, 0);

const calls: string[] = [];
let clientQuery: any = null;
const fakeTx = {
  $executeRaw: async (query: TemplateStringsArray) => { calls.push(query.join("")); return 0; },
  appConfig: {
    findUnique: async ({ where }: any) => ({
      value: where.key === PARTNERS_CONFIG_KEY ? JSON.stringify(input.partnerCacheRows) : JSON.stringify(input.partnerLastSeen),
    }),
  },
  user: { findMany: async () => input.users },
  client: { findMany: async (args: any) => { clientQuery = args; return input.clients; } },
};
const fakeClient: OwnerRuleClient = {
  $transaction: async (fn) => fn(fakeTx),
  $disconnect: async () => { calls.push("disconnect"); },
};
const lines: string[] = [];
await runCli([], () => fakeClient, (line) => lines.push(line), NOW);
assert.deepEqual(calls, ["SET TRANSACTION READ ONLY", "disconnect"]);
assert.deepEqual(JSON.parse(lines[0]), summary);
assert.equal(clientQuery.where.NOT.name.startsWith, LEGACY_ARCHIVED_DUPLICATE_PREFIX);
assert.equal(clientQuery.select.name, undefined, "o nome do cliente não é lido");

// Sem cache: avisa e não simula.
const empty = await loadSimulationInput({ ...fakeTx, appConfig: { findUnique: async () => null } });
assert.equal(empty.partnerCacheRows, null);

console.log("SIMULATE_PARTNER_OWNER_RULE=PASS contract=PASS summary=PASS no_client_data=PASS read_only=PASS");
