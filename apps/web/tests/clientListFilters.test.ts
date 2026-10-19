import assert from "node:assert/strict";
import {
  EMPTY_CLIENT_QUICK_FILTERS,
  buildClientListParams,
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
    filters: { uf: "SC", region: "Regiao Ficticia", clientType: "PF", ownerSellerId: "seller-a", portfolioStatus: "ativo" },
  }),
  { page: 3, pageSize: 10, q: "fazenda", uf: "SC", regiao: "Regiao Ficticia", tipo: "PF", ownerSellerId: "seller-a", includeArchived: 1, status: "ativo" }
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

console.log("CLIENT_LIST_FILTERS=PASS api_param_names=PASS combined=PASS seller_scope=PASS url_sync=PASS clear=PASS donut_links=PASS");
