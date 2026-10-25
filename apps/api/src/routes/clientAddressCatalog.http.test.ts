import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { BRAZIL_STATES, findBrazilMunicipality, listBrazilMunicipalities, statesWithMunicipalityNamed } from "../services/brazilMunicipalities.js";
import { listOfficialTerritoryCities } from "../services/territoryOfficialCities.js";
import { signAccessToken } from "../utils/jwt.js";

// Endereço do cliente da lista oficial do IBGE (Brasil inteiro) no cadastro, na edição e nas duas importações.
// Clientes e usuários fictícios (só os municípios são reais, do catálogo público); Prisma simulado.
type Row = Record<string, any>;

const results: string[] = [];

// 1. Catálogo nacional: 27 UFs e 5.571 municípios; PR, SC e MS iguais ao catálogo dos territórios.
{
  assert.equal(BRAZIL_STATES.length, 27);
  assert.equal(BRAZIL_STATES.reduce((total, state) => total + listBrazilMunicipalities(state).length, 0), 5571);
  for (const state of ["PR", "SC", "MS"]) {
    const national = listBrazilMunicipalities(state).map((item) => `${item.ibgeCode}:${item.city}`).sort();
    const territory = listOfficialTerritoryCities(state).map((item) => `${item.ibgeCode}:${item.city}`).sort();
    assert.deepEqual(national, territory, `${state} igual ao catálogo dos territórios`);
  }
  assert.equal(findBrazilMunicipality("ms", "CAARAPO")?.city, "Caarapó", "sem acento e minúsculas");
  assert.equal(findBrazilMunicipality("PR", "CAARAPO"), null, "nunca procura em outra UF");
  assert.equal(findBrazilMunicipality("PR", "diamante d oeste")?.city, "Diamante D'Oeste");
  assert.equal(findBrazilMunicipality("XX", "Toledo"), null);
  assert.deepEqual(statesWithMunicipalityNamed("Caarapó"), ["MS"]);
  assert(statesWithMunicipalityNamed("São Sebastião").length > 1, "nome em várias UFs");
  results.push("catalog=PASS");
}

const users: Record<string, "vendedor" | "gerente" | "diretor"> = { "seller-a": "vendedor", "director-a": "diretor" };
let clients: Row[] = [];
let opportunities: Row[] = [];
const resetData = () => {
  clients = [
    // Cadastro manual antigo, fora da lista (cidade do MS com UF PR) e sem tenant.
    { id: "client-legacy", tenantId: null, ownerSellerId: "seller-a", name: "Cliente Antigo Ficticio", nameNormalized: "cliente antigo ficticio", city: "CAARAPO", cityNormalized: "caarapo", state: "PR", region: "Oeste", code: null, cnpj: null, cnpjNormalized: null, fantasyName: null, isArchived: false },
    // Cliente do ERP (código fictício): o ERP é dono do cadastro.
    { id: "client-erp", tenantId: "tenant-a", ownerSellerId: "seller-a", name: "Cliente Erp Ficticio", nameNormalized: "cliente erp ficticio", city: "Toledo", cityNormalized: "toledo", state: "PR", region: "Oeste", code: "90001", cnpj: null, cnpjNormalized: null, fantasyName: null, isArchived: false },
  ];
  opportunities = [];
};

const looseMatch = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "AND") return (expected as Row[]).every((branch) => looseMatch(row, branch));
    if (key === "OR") return (expected as Row[]).some((branch) => looseMatch(row, branch));
    if (key === "NOT") return true;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("not" in expected) return row[key] !== expected.not;
      if ("in" in expected) return (expected.in as unknown[]).includes(row[key]);
      if ("equals" in expected) return String(row[key] ?? "").toLowerCase() === String(expected.equals ?? "").toLowerCase();
      return true;
    }
    return row[key] === expected;
  });
};
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, name: where.id, role: users[where.id], region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: where.id, role: users[where.id], isActive: true } : null),
  findMany: async () => Object.entries(users).filter(([, role]) => role === "vendedor").map(([id, role]) => ({ id, name: id, email: `${id}@test.invalid`, role, isActive: true })),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findFirst: async ({ where }: any) => clients.find((row) => looseMatch(row, where)) ?? null,
  findUnique: async ({ where }: any) => clients.find((row) => row.id === where.id) ?? null,
  findMany: async ({ where }: any) => clients.filter((row) => looseMatch(row, where)),
  create: async ({ data }: any) => {
    const created = { id: `client-new-${clients.length + 1}`, isArchived: false, code: null, ...data };
    clients.push(created);
    return created;
  },
  update: async ({ where, data }: any) => {
    const index = clients.findIndex((row) => row.id === where.id);
    clients[index] = { ...clients[index], ...data };
    return clients[index];
  },
});
setModel("clientCodeAudit", { create: async ({ data }: any) => data });
setModel("timelineEvent", { create: async ({ data }: any) => data });
setModel("opportunity", {
  findFirst: async () => null,
  findMany: async () => [],
  create: async ({ data }: any) => { const created = { id: `opp-${opportunities.length + 1}`, createdAt: new Date(), ...data }; opportunities.push(created); return created; },
  update: async ({ data }: any) => data,
});
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId] })}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};
const newClient = { name: "Cliente Novo Ficticio", region: "Oeste", clientType: "PJ" };

try {
  // 2. Catálogo para a tela: todas as UFs; com ?uf=, os municípios dela (qualquer perfil).
  {
    const all = await call("seller-a", "GET", "/api/clients/address-catalog");
    assert.equal(all.status, 200);
    assert.equal(all.json.states.length, 27);
    assert.deepEqual(all.json.municipalities, []);
    const ms = await call("seller-a", "GET", "/api/clients/address-catalog?uf=ms");
    assert.equal(ms.json.municipalities.length, 79);
    assert(ms.json.municipalities.some((item: Row) => item.city === "Caarapó" && /^50\d{5}$/.test(item.ibgeCode)));
    assert.deepEqual((await call("seller-a", "GET", "/api/clients/address-catalog?uf=XX")).json.municipalities, []);
    results.push("catalog_endpoint=PASS");
  }

  // 3. Cadastro manual: par fora da lista é recusado; válido grava o nome oficial e o tenant.
  {
    resetData();
    const wrong = await call("seller-a", "POST", "/api/clients", { ...newClient, city: "CAARAPO", state: "PR" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.message, "Cidade \"CAARAPO\" não encontrada na UF PR. Escolha a UF e a cidade da lista oficial do IBGE.");
    assert.equal((await call("seller-a", "POST", "/api/clients", { ...newClient, city: "Toledo", state: "XX" })).status, 400, "UF inválida");
    assert.equal(clients.length, 2, "nada gravado");
    const created = await call("seller-a", "POST", "/api/clients", { ...newClient, city: "caarapo", state: "ms" });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const row = clients.find((client) => client.id === created.json.id)!;
    assert.deepEqual([row.city, row.state, row.tenantId], ["Caarapó", "MS", "tenant-a"]);
    results.push("manual_create=PASS");
  }

  // 4. Edição: outros campos não exigem corrigir o endereço antigo (e o tenant vazio é preenchido); mudar UF ou cidade
  //    exige o par da lista.
  {
    resetData();
    const renamed = await call("seller-a", "PUT", "/api/clients/client-legacy", { name: "Cliente Antigo Renomeado", city: "CAARAPO", state: "PR" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    let legacy = clients.find((client) => client.id === "client-legacy")!;
    assert.deepEqual([legacy.name, legacy.city, legacy.state, legacy.tenantId], ["Cliente Antigo Renomeado", "CAARAPO", "PR", "tenant-a"]);

    const invalid = await call("seller-a", "PUT", "/api/clients/client-legacy", { city: "Cidade Inexistente Ficticia", state: "PR" });
    assert.equal(invalid.status, 400);
    assert.equal(clients.find((client) => client.id === "client-legacy")!.city, "CAARAPO", "nada gravado");

    const fixed = await call("seller-a", "PUT", "/api/clients/client-legacy", { city: "CAARAPO", state: "MS" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
    legacy = clients.find((client) => client.id === "client-legacy")!;
    assert.deepEqual([legacy.city, legacy.state], ["Caarapó", "MS"]);
    results.push("manual_edit=PASS");

    // Cliente com código do ERP: UF e cidade não mudam pelo CRM (nem para um par válido); outros campos seguem
    // editáveis e o endereço reenviado com outra grafia não é regravado.
    const erpMessage = "UF e cidade de cliente com código do ERP vêm somente do ERP e não podem ser alteradas no CRM. Corrija o cadastro no ERP e aguarde a próxima sincronização.";
    for (const body of [{ city: "Cascavel", state: "PR" }, { city: "Toledo", state: "SP" }, { city: "Cascavel" }, { state: "MS" }]) {
      const blocked = await call("director-a", "PUT", "/api/clients/client-erp", { name: "Cliente Erp Renomeado", ...body });
      assert.equal(blocked.status, 400, JSON.stringify(body));
      assert.equal(blocked.json.message, erpMessage);
    }
    let erp = clients.find((client) => client.id === "client-erp")!;
    assert.deepEqual([erp.name, erp.city, erp.state], ["Cliente Erp Ficticio", "Toledo", "PR"], "nada gravado");
    const sameAddress = await call("seller-a", "PUT", "/api/clients/client-erp", { name: "Cliente Erp Renomeado", city: "TOLEDO", state: "pr" });
    assert.equal(sameAddress.status, 200, JSON.stringify(sameAddress.json));
    erp = clients.find((client) => client.id === "client-erp")!;
    assert.deepEqual([erp.name, erp.city, erp.state, erp.code], ["Cliente Erp Renomeado", "Toledo", "PR", "90001"], "endereço do ERP intacto");
    results.push("erp_address_read_only=PASS");
  }

  // 5. Importação de clientes: linha com cidade fora da UF não entra e aparece nos erros (prévia e importação).
  {
    resetData();
    const rows = [
      { ...newClient, name: "Cliente Planilha Valido", city: "naviraí", state: "MS", ownerSellerId: "seller-a" },
      { ...newClient, name: "Cliente Planilha Invalido", city: "NAVIRAI", state: "PR", ownerSellerId: "seller-a" },
    ];
    const preview = await call("director-a", "POST", "/api/clients/import/preview", { rows });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.novos.length, 1);
    assert.deepEqual(preview.json.erros.map((item: Row) => item.message), ["Cidade \"NAVIRAI\" não encontrada na UF PR. Escolha a UF e a cidade da lista oficial do IBGE."]);
    const imported = await call("director-a", "POST", "/api/clients/import", { rows });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.created, 1);
    assert.equal(imported.json.errors.length, 1);
    assert.equal(clients.some((client) => client.name === "Cliente Planilha Invalido"), false, "linha inválida não entra");
    const created = clients.find((client) => client.name === "Cliente Planilha Valido")!;
    assert.deepEqual([created.city, created.state, created.tenantId], ["Naviraí", "MS", "tenant-a"]);

    // Cliente do ERP com cidade vazia: a planilha não preenche o endereço (o ERP é dono); sem código, preenche.
    resetData();
    Object.assign(clients.find((client) => client.id === "client-erp")!, { city: "", cnpj: "00000000000191", cnpjNormalized: "00000000000191" });
    Object.assign(clients.find((client) => client.id === "client-legacy")!, { tenantId: "tenant-a", city: "", cnpj: "00000000000272", cnpjNormalized: "00000000000272" });
    await call("director-a", "POST", "/api/clients/import", { rows: [
      { ...newClient, name: "Cliente Erp Ficticio", city: "Cascavel", state: "PR", ownerSellerId: "seller-a", cnpj: "00000000000191", fantasyName: "Fantasia Ficticia" },
      { ...newClient, name: "Cliente Antigo Ficticio", city: "Cascavel", state: "PR", ownerSellerId: "seller-a", cnpj: "00000000000272" },
    ] });
    const erpAfterImport = clients.find((client) => client.id === "client-erp")!;
    assert.deepEqual([erpAfterImport.city, erpAfterImport.state, erpAfterImport.fantasyName], ["", "PR", "Fantasia Ficticia"], "outros campos vazios enriquecidos; endereço do ERP não");
    const legacyAfterImport = clients.find((client) => client.id === "client-legacy")!;
    assert.deepEqual([legacyAfterImport.city, legacyAfterImport.state], ["Cascavel", "PR"], "sem código: endereço vazio preenchido");
    results.push("client_import=PASS");
  }

  // 6. Importação de oportunidades com "criar cliente": só com cidade e UF da lista e com tenant; senão a linha vai
  //    para os erros e nenhum cliente é criado.
  {
    resetData();
    const base = { value: 1000, stage: "prospeccao", probability: 20, ownerEmail: "seller-a@test.invalid", followUpDate: "2026-12-01" };
    const rows = [
      { ...base, title: "Oportunidade Ficticia 1", clientNameOrId: "Cliente Importado Valido", cidade_cliente: "SETE QUEDAS", uf_cliente: "ms" },
      { ...base, title: "Oportunidade Ficticia 2", clientNameOrId: "Cliente Importado Sem Cidade" },
      { ...base, title: "Oportunidade Ficticia 3", clientNameOrId: "Cliente Importado UF Errada", cidade_cliente: "Sete Quedas", uf_cliente: "PR" },
    ];
    const preview = await call("director-a", "POST", "/api/opportunities/import", { rows, options: { createClientIfMissing: true, dryRun: true } });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.deepEqual(preview.json.rowResults.filter((item: Row) => item.status === "error").map((item: Row) => [item.row, item.reason]), [[2, "client_invalid_address"], [3, "client_invalid_address"]]);
    assert.equal(clients.length, 2, "prévia não cria cliente");

    const imported = await call("director-a", "POST", "/api/opportunities/import", { rows, options: { createClientIfMissing: true } });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    const errors = imported.json.rowResults.filter((item: Row) => item.status === "error");
    assert.deepEqual(errors.map((item: Row) => item.row), [2, 3]);
    assert.match(errors[0].message, /cliente novo sem cidade válida: Cidade "-" não encontrada na UF -|UF "-" inválida/);
    const created = clients.filter((client) => client.id.startsWith("client-new-"));
    assert.deepEqual(created.map((client) => [client.name, client.city, client.state, client.tenantId]), [["Cliente Importado Valido", "Sete Quedas", "MS", "tenant-a"]]);
    assert.equal(clients.some((client) => client.state === "NA" || client.city === "N/A"), false, "sem N/A/NA");
    assert.equal(opportunities.length, 1);
    results.push("opportunity_import=PASS");
  }

  // 7. Tela: formulário e criação rápida com listas do catálogo; importação de oportunidades com cidade e UF.
  {
    const crudSource = readFileSync(new URL("../../../web/src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
    const quickSource = readFileSync(new URL("../../../web/src/components/clients/QuickCreateClientSection.tsx", import.meta.url), "utf8");
    const importSource = readFileSync(new URL("../../../web/src/components/opportunities/OpportunityImportModal.tsx", import.meta.url), "utf8");
    assert(crudSource.includes("<ClientAddressFields") && quickSource.includes("<ClientAddressFields"));
    assert(crudSource.includes('const addressFromErp = Boolean(editing && typeof form.code === "string" && form.code.trim());') && crudSource.includes("disabled={addressFromErp}"), "UF e cidade somente leitura para cliente do ERP");
    assert(!quickSource.includes('placeholder="UF"') && !quickSource.includes('placeholder="Cidade"'), "sem texto livre na criação rápida");
    assert(quickSource.includes("resolveOfficialAddress(state, city)"), "consulta de CNPJ preenche UF e cidade oficiais");
    assert(importSource.includes('"cidade_cliente",') && importSource.includes('"uf_cliente",'));
    results.push("screen=PASS");
  }

  console.log(`CLIENT_ADDRESS_CATALOG=PASS ${results.join(" ")}`);
} finally {
  server.close();
}
