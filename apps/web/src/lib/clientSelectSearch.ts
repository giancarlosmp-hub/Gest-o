// Busca do ClientSelect em GET /clients: q é o parâmetro de busca da API, e com ele a resposta vem paginada.
export type ClientSelectOption = {
  id: string;
  name: string;
  fantasyName?: string | null;
  code?: string | null;
  city?: string | null;
  state?: string | null;
};

export const CLIENT_SELECT_PAGE_SIZE = 20;

// Texto vazio não busca.
export const clientSearchParams = (query: string) => {
  const q = query.trim();
  return q ? { q, page: 1, pageSize: CLIENT_SELECT_PAGE_SIZE } : null;
};

// Com q a API devolve { items, total, page, pageSize }; sem paginação, o array antigo.
export const readClientSearchItems = (data: unknown): ClientSelectOption[] => {
  if (Array.isArray(data)) return data;
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
};

const normalize = (value?: string | null) => String(value ?? "").trim().toLowerCase();

// Mesmos campos que a busca da API usa para nome, código e cidade.
const matchesQuery = (client: ClientSelectOption, query: string) => {
  const term = normalize(query);
  return [client.name, client.fantasyName, client.code, client.city].some((field) => normalize(field).includes(term));
};

// O cliente já selecionado continua na lista quando bate com a busca, mesmo fora dos 20 primeiros resultados.
export const withSelectedClient = (results: ClientSelectOption[], selected: ClientSelectOption | null, query: string) => {
  if (!selected || results.some((client) => client.id === selected.id) || !matchesQuery(selected, query)) return results;
  return [selected, ...results];
};
