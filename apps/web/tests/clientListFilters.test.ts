import assert from "node:assert/strict";
import {
  EMPTY_CLIENT_QUICK_FILTERS,
  abcClientsPath,
  buildClientListParams,
  collectionClientsPath,
  isCollectionFilterInUrl,
  ownerSellerIdFromUrl,
  portfolioStatusClientsPath,
  withUrlFilters,
} from "../src/lib/clientListFilters.js";

// Dados fictícios: filtros da lista de clientes, ?ownerSellerId= da URL e links do donut do Dashboard.
const base = { page: 1, pageSize: 10, search: "", canFilterBySeller: true, includeArchived: false };

// UF, Região e Tipo saem com os nomes que GET /clients lê (uf, regiao, tipo).
assert.deepEqual(
  buildClientListParams({ ...base, filters: { ...EMPTY_CLIENT_QUICK_FILTERS, uf: "PR", region: "Regiao Ficticia", clientType: "PJ" } }),
  { page: 1, pageSize: 10, uf: "PR", regiao: "Regiao Ficticia", tipo: "PJ" }
);

// Todos os filtros combinam entre si e com a página.
assert.deepEqual(
  buildClientListParams({
    ...base,
    page: 3,
    search: "fazenda",
    includeArchived: true,
    filters: { uf: "SC", region: "Regiao Ficticia", clientType: "PF", ownerSellerId: "seller-a", portfolioStatus: "ativo", abc: "B" },
  }),
  { page: 3, pageSize: 10, q: "fazenda", uf: "SC", regiao: "Regiao Ficticia", tipo: "PF", ownerSellerId: "seller-a", includeArchived: 1, status: "ativo", abc: "B" }
);

// Vendedor não manda ownerSellerId; filtros vazios não viram parâmetro.
assert.deepEqual(
  buildClientListParams({ ...base, canFilterBySeller: false, filters: { ...EMPTY_CLIENT_QUICK_FILTERS, ownerSellerId: "seller-b" } }),
  { page: 1, pageSize: 10 }
);
assert.deepEqual(buildClientListParams({ ...base, filters: EMPTY_CLIENT_QUICK_FILTERS }), { page: 1, pageSize: 10 });

// ?ownerSellerId= da URL só vale para gerente e diretor.
const url = new URLSearchParams("status=ativo&ownerSellerId=seller-b");
assert.equal(ownerSellerIdFromUrl(url, "gerente"), "seller-b");
assert.equal(ownerSellerIdFromUrl(url, "diretor"), "seller-b");
assert.equal(ownerSellerIdFromUrl(url, "vendedor"), "");
assert.equal(ownerSellerIdFromUrl(url, undefined), "");
assert.equal(ownerSellerIdFromUrl(new URLSearchParams("ownerSellerId=%20%20"), "gerente"), "");

// Filtro muda a URL sem perder os outros parâmetros; "Limpar filtros" tira situação e vendedor.
assert.equal(withUrlFilters(new URLSearchParams("tab=empresas"), { ownerSellerId: "seller-a" }).toString(), "tab=empresas&ownerSellerId=seller-a");
assert.equal(withUrlFilters(url, { status: "prospect" }).toString(), "status=prospect&ownerSellerId=seller-b");
assert.equal(withUrlFilters(new URLSearchParams("tab=empresas&status=ativo&ownerSellerId=seller-a"), { status: "", ownerSellerId: "" }).toString(), "tab=empresas");

// Fatias do donut: com vendedor escolhido, a lista abre na carteira dele.
assert.equal(portfolioStatusClientsPath("ativo"), "/clientes?status=ativo");
assert.equal(portfolioStatusClientsPath("exCliente", ""), "/clientes?status=exCliente");
assert.equal(portfolioStatusClientsPath("inativoRecente", "seller-a"), "/clientes?status=inativoRecente&ownerSellerId=seller-a");
assert.equal(portfolioStatusClientsPath("prospect", "seller a&b"), "/clientes?status=prospect&ownerSellerId=seller+a%26b");

// "Em cobrança": ?cobranca=1 na URL e na API, combinável com os demais filtros.
assert.deepEqual(buildClientListParams({ ...base, collection: true, filters: { ...EMPTY_CLIENT_QUICK_FILTERS, portfolioStatus: "ativo" } }), { page: 1, pageSize: 10, status: "ativo", cobranca: 1 });
assert.deepEqual(buildClientListParams({ ...base, collection: false, filters: EMPTY_CLIENT_QUICK_FILTERS }), { page: 1, pageSize: 10 });
assert.equal(isCollectionFilterInUrl(new URLSearchParams("cobranca=1")), true);
assert.equal(isCollectionFilterInUrl(new URLSearchParams("cobranca=0")), false);
assert.equal(isCollectionFilterInUrl(new URLSearchParams("")), false);
assert.equal(collectionClientsPath(), "/clientes?cobranca=1");
assert.equal(withUrlFilters(new URLSearchParams("cobranca=1&status=ativo"), { cobranca: "" }).toString(), "status=ativo");

// Curva ABC: ?abc= na API e nas fatias do donut do Dashboard (com o vendedor escolhido).
assert.deepEqual(buildClientListParams({ ...base, filters: { ...EMPTY_CLIENT_QUICK_FILTERS, abc: "A", uf: "PR" } }), { page: 1, pageSize: 10, uf: "PR", abc: "A" });
assert.equal(abcClientsPath("A"), "/clientes?abc=A");
assert.equal(abcClientsPath("C", ""), "/clientes?abc=C");
assert.equal(abcClientsPath("B", "seller-a"), "/clientes?abc=B&ownerSellerId=seller-a");
assert.equal(withUrlFilters(new URLSearchParams("abc=A&status=ativo"), { abc: "" }).toString(), "status=ativo");

console.log("CLIENT_LIST_FILTERS=PASS api_param_names=PASS combined=PASS seller_scope=PASS url_sync=PASS clear=PASS donut_links=PASS collection=PASS abc=PASS");
