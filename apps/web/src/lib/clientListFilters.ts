// Filtros da lista de clientes: nomes que GET /clients lê, parâmetros vindos da URL e links do Dashboard.
export type ClientQuickFilters = {
  uf: string;
  region: string;
  clientType: string;
  ownerSellerId: string;
  portfolioStatus: string;
  // Curva ABC (?abc=A|B|C), a mesma do Dashboard.
  abc: string;
};

export const EMPTY_CLIENT_QUICK_FILTERS: ClientQuickFilters = { uf: "", region: "", clientType: "", ownerSellerId: "", portfolioStatus: "", abc: "" };

export const canFilterClientsBySeller = (role?: string) => role === "diretor" || role === "gerente";

// Vendedor fica restrito à própria carteira: ?ownerSellerId= só vale para gerente e diretor.
export const ownerSellerIdFromUrl = (searchParams: URLSearchParams, role?: string) =>
  canFilterClientsBySeller(role) ? searchParams.get("ownerSellerId")?.trim() || "" : "";

export const buildClientListParams = (options: {
  page: number;
  pageSize: number;
  search: string;
  filters: ClientQuickFilters;
  canFilterBySeller: boolean;
  includeArchived: boolean;
  // Só clientes em cobrança (?cobranca=1).
  collection?: boolean;
}) => {
  const { filters } = options;
  const params: Record<string, string | number> = { page: options.page, pageSize: options.pageSize };
  if (options.search) params.q = options.search;
  if (filters.uf) params.uf = filters.uf;
  if (filters.region) params.regiao = filters.region;
  if (filters.clientType) params.tipo = filters.clientType;
  if (options.canFilterBySeller && filters.ownerSellerId) params.ownerSellerId = filters.ownerSellerId;
  if (options.includeArchived) params.includeArchived = 1;
  if (filters.portfolioStatus) params.status = filters.portfolioStatus;
  if (filters.abc) params.abc = filters.abc;
  if (options.collection) params.cobranca = 1;
  return params;
};

// Valor vazio remove o parâmetro; os demais parâmetros da URL ficam como estão.
export const withUrlFilters = (current: URLSearchParams, values: Record<string, string>) => {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(values)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
};

// Fatia do donut "Carteira de clientes": com vendedor escolhido, a lista abre na carteira dele.
export const portfolioStatusClientsPath = (status: string, sellerId?: string) =>
  `/clientes?${withUrlFilters(new URLSearchParams(), { status, ownerSellerId: sellerId ?? "" }).toString()}`;

// Fatia do donut "Curva ABC de clientes": mesma regra de vendedor do donut da carteira.
export const abcClientsPath = (abc: string, sellerId?: string) =>
  `/clientes?${withUrlFilters(new URLSearchParams(), { abc, ownerSellerId: sellerId ?? "" }).toString()}`;

// Filtro "Em cobrança" da lista de clientes: ?cobranca=1 na URL e na API.
export const COLLECTION_URL_PARAM = "cobranca";
export const isCollectionFilterInUrl = (searchParams: URLSearchParams) => ["1", "true"].includes(searchParams.get(COLLECTION_URL_PARAM) ?? "");
export const collectionClientsPath = () => `/clientes?${COLLECTION_URL_PARAM}=1`;
