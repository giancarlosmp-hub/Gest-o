import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: filtros de UF, região e tipo de GET /clients (sozinhos e combinados com situação, vendedor e
// paginação) e opções dos seletores em GET /clients/filter-options.
type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const users: Row[] = [
  { id: "director-a", role: "diretor" },
  { id: "manager-a", role: "gerente" },
  { id: "seller-a", role: "vendedor" },
  { id: "seller-b", role: "vendedor" },
];
const client = (id: string, ownerSellerId: string, state: string, region: string, clientType: "PF" | "PJ", lastPurchaseDate: Date | null, extra: Row = {}): Row => ({
  id, name: `Cliente Ficticio ${id}`, code: `COD-${id}`, city: `Cidade Ficticia ${state}`, ownerSellerId, state, region, clientType, isArchived: false, lastPurchaseDate, financialProfile: null, ...extra,
});
const clients: Row[] = [
  client("a-pr-norte-pj-ativo", "seller-a", "PR", "Regiao Norte Ficticia", "PJ", daysAgo(30)),
  client("a-pr-norte-pf-prospect", "seller-a", "PR", "Regiao Norte Ficticia", "PF", null),
  client("a-sc-sul-pj-ativo", "seller-a", "SC", "REGIAO SUL FICTICIA", "PJ", daysAgo(40)),
  client("a-ni-pf-ex", "seller-a", "NI", "Não informado", "PF", daysAgo(900)),
  client("a-pr-arquivado", "seller-a", "MS", "Regiao Arquivada Ficticia", "PJ", daysAgo(10), { isArchived: true }),
  client("b-pr-norte-pj-ativo", "seller-b", "PR", "regiao norte ficticia", "PJ", daysAgo(20)),
  client("b-rs-sul-pf-prospect", "seller-b", "RS", "Regiao Sul Ficticia", "PF", null),
];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((condition) => matches(row, condition));
    if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
    if (value && typeof value === "object" && "equals" in value) return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
    if (value && typeof value === "object" && "contains" in value) return String(row[key] ?? "").toLowerCase().includes(String(value.contains).toLowerCase());
    return row[key] === value;
  });

setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null, isActive: true } : null;
  },
  findMany: async () => [],
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findMany: async ({ where, select, include, skip, take }: any) => {
    const rows = clients
      .filter((row) => matches(row, where))
      .map((row) => (include?.ownerSeller ? { ...row, ownerSeller: { id: row.ownerSellerId, name: "Vendedor Ficticio" } } : pick(row, select)));
    return skip === undefined ? rows : rows.slice(skip, skip + take);
  },
  count: async ({ where }: any) => clients.filter((row) => matches(row, where)).length,
});
setModel("erpOrderSync", { findMany: async () => [] });
setModel("opportunity", { findMany: async () => [] });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const get = async (path: string, userId = "director-a") => {
  const user = users.find((row) => row.id === userId)!;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` },
  });
  return { status: response.status, json: (await response.json()) as any };
};
const ids = (json: any) => json.items.map((item: Row) => item.id).sort();
const list = async (query: string, userId?: string) => {
  const response = await get(`/clients?page=1&pageSize=20&${query}`, userId);
  assert.equal(response.status, 200, query);
  return response.json;
};

try {
  // Cada filtro filtra de verdade (sem diferenciar maiúsculas/minúsculas); arquivado nunca entra.
  assert.deepEqual(ids(await list("uf=PR")), ["a-pr-norte-pf-prospect", "a-pr-norte-pj-ativo", "b-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=pr")), ["a-pr-norte-pf-prospect", "a-pr-norte-pj-ativo", "b-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=NI")), ["a-ni-pf-ex"]);
  assert.deepEqual(ids(await list("uf=MS")), []);
  assert.deepEqual(ids(await list(`regiao=${encodeURIComponent("Regiao Norte Ficticia")}`)), ["a-pr-norte-pf-prospect", "a-pr-norte-pj-ativo", "b-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list(`regiao=${encodeURIComponent("Regiao Sul Ficticia")}`)), ["a-sc-sul-pj-ativo", "b-rs-sul-pf-prospect"]);
  assert.deepEqual(ids(await list(`regiao=${encodeURIComponent("Não informado")}`)), ["a-ni-pf-ex"]);
  assert.deepEqual(ids(await list("tipo=PF")), ["a-ni-pf-ex", "a-pr-norte-pf-prospect", "b-rs-sul-pf-prospect"]);
  assert.deepEqual(ids(await list("tipo=pj")), ["a-pr-norte-pj-ativo", "a-sc-sul-pj-ativo", "b-pr-norte-pj-ativo"]);
  assert.equal((await list("tipo=XX")).total, 6, "tipo inválido é ignorado");

  // Os nomes antigos que a tela mandava não filtram: o contrato é uf, regiao e tipo.
  assert.equal((await list("state=PR&region=Sul&clientType=PF")).total, 6);

  // Combinação entre filtros, com situação e vendedor, e com a busca.
  assert.deepEqual(ids(await list("uf=PR&tipo=PJ")), ["a-pr-norte-pj-ativo", "b-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=PR&tipo=PJ&ownerSellerId=seller-a", "manager-a")), ["a-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list(`regiao=${encodeURIComponent("Regiao Sul Ficticia")}&status=prospect`)), ["b-rs-sul-pf-prospect"]);
  assert.deepEqual(ids(await list("uf=PR&status=ativo&ownerSellerId=seller-b", "manager-a")), ["b-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=PR&status=prospect&tipo=PF&ownerSellerId=seller-a")), ["a-pr-norte-pf-prospect"]);
  assert.deepEqual(ids(await list("uf=SC&status=prospect")), []);
  assert.deepEqual(ids(await list("q=sc-sul&tipo=PJ")), ["a-sc-sul-pj-ativo"]);

  // Busca do seletor de cliente (ClientSelect): q por nome, código e cidade, resposta paginada com 20 por página.
  const byName = await get("/clients?q=Cliente%20Ficticio%20a-sc&page=1&pageSize=20");
  assert.deepEqual({ ids: ids(byName.json), total: byName.json.total, page: byName.json.page, pageSize: byName.json.pageSize }, { ids: ["a-sc-sul-pj-ativo"], total: 1, page: 1, pageSize: 20 });
  assert.deepEqual(ids((await get("/clients?q=cod-b-rs&page=1&pageSize=20")).json), ["b-rs-sul-pf-prospect"]);
  assert.deepEqual(ids((await get("/clients?q=Cidade%20Ficticia%20SC&page=1&pageSize=20")).json), ["a-sc-sul-pj-ativo"]);
  const onlyQ = await get("/clients?q=Cliente");
  assert(!Array.isArray(onlyQ.json) && onlyQ.json.pageSize === 20 && onlyQ.json.total === 6, "só com q a resposta já vem paginada (pageSize padrão 20)");
  const ignoredSearch = await get("/clients?search=a-sc");
  assert(Array.isArray(ignoredSearch.json) && ignoredSearch.json.length === 6, "?search= não é lido pela API");

  // Paginação com filtro, com e sem situação.
  const ufPage1 = await get("/clients?page=1&pageSize=2&uf=PR");
  const ufPage2 = await get("/clients?page=2&pageSize=2&uf=PR");
  assert.equal(ufPage1.json.total, 3);
  assert.equal(ufPage1.json.items.length, 2);
  assert.equal(ufPage2.json.items.length, 1);
  const statusPage2 = await get("/clients?page=2&pageSize=1&uf=PR&status=ativo");
  assert.equal(statusPage2.json.total, 2);
  assert.equal(statusPage2.json.items.length, 1);

  // Total da lista com vendedor escolhido = fatia do Dashboard do mesmo vendedor.
  for (const sellerId of ["seller-a", "seller-b"]) {
    const dashboard = await get(`/dashboard/portfolio?sellerId=${sellerId}`, "manager-a");
    assert.equal(dashboard.status, 200);
    for (const status of ["ativo", "inativoRecente", "exCliente", "prospect"]) {
      const result = await list(`status=${status}&ownerSellerId=${sellerId}`, "manager-a");
      assert(result.items.every((item: Row) => item.ownerSellerId === sellerId));
      assert.equal(result.total, dashboard.json.walletStatus[status], `${sellerId} ${status} = fatia do Dashboard`);
    }
  }

  // Vendedor não vê a carteira de outro pela URL: ownerSellerId de outro é ignorado.
  assert.deepEqual(ids(await list("ownerSellerId=seller-b", "seller-a")), ["a-ni-pf-ex", "a-pr-norte-pf-prospect", "a-pr-norte-pj-ativo", "a-sc-sul-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=PR&status=ativo&ownerSellerId=seller-b", "seller-a")), ["a-pr-norte-pj-ativo"]);
  assert.deepEqual(ids(await list("uf=RS&ownerSellerId=seller-b", "seller-a")), []);

  // Opções dos seletores: valores gravados, sem arquivados, sem repetir por maiúsculas/minúsculas.
  const options = await get("/clients/filter-options");
  assert.equal(options.status, 200);
  assert.deepEqual(options.json.ufs, ["NI", "PR", "RS", "SC"]);
  assert.deepEqual(options.json.regions, ["Não informado", "Regiao Norte Ficticia", "REGIAO SUL FICTICIA"]);
  for (const region of options.json.regions) assert((await list(`regiao=${encodeURIComponent(region)}`)).total > 0, `opção ${region} filtra`);
  for (const uf of options.json.ufs) assert((await list(`uf=${uf}`)).total > 0, `opção ${uf} filtra`);

  // Vendedor só vê as opções da própria carteira.
  const sellerOptions = await get("/clients/filter-options", "seller-b");
  assert.deepEqual(sellerOptions.json, { ufs: ["PR", "RS"], regions: ["regiao norte ficticia", "Regiao Sul Ficticia"] });
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("CLIENT_LIST_FILTERS=PASS uf=PASS regiao=PASS tipo=PASS combined=PASS pagination=PASS dashboard_total=PASS seller_scope=PASS filter_options=PASS");
