import { getApiErrorMessage } from "./apiError";

// Oportunidade por voz, fase 2: o rascunho devolvido por POST /ai/crm-assistant/opportunity-draft/parse vira um cartão
// editável. Nada é pré-escolhido: cliente e produto ficam pendentes até o vendedor tocar num candidato (ou buscar à
// mão). A confirmação cria pelas rotas de sempre (POST /opportunities e POST /opportunities/:id/items) e guarda o id
// da oportunidade criada, para uma nova tentativa só repetir os itens que falharam.

// Formato da resposta da rota (cópia de OpportunityDraft em apps/api/src/services/opportunityDraftService.ts).
export type DraftStage = "prospeccao" | "negociacao" | "proposta";
export type DraftWarning = { code: string; field: string; message: string };
export type DraftClientCandidate = {
  id: string;
  name: string;
  fantasyName: string | null;
  city: string | null;
  state: string | null;
  score: number;
  suggestedOwner: { id: string; name: string } | null;
  ownerPending: boolean;
};
export type DraftProductCandidate = {
  productId: string;
  name: string;
  className: string | null;
  brand: string | null;
  unit: string | null;
  weightKg: number | null;
  tablePrice: number;
  unitPrice: number;
  total: number | null;
  priceDiffPercent: number | null;
  score: number;
};
export type DraftSpokenPrice = { mode: "registered" } | { mode: "informed"; amount: number };
export type OpportunityDraftResponse = {
  client: { spokenName: string | null; spokenCity: string | null; candidates: DraftClientCandidate[] };
  owner: { mode: "self"; sellerId: string } | { mode: "client_owner" };
  title: string;
  stage: { value: DraftStage; label: string };
  probability: number;
  priceTable: { code: "1" | "2"; label: string };
  items: Array<{ spokenName: string; kg: number | null; quantity: number | null; price: DraftSpokenPrice; candidates: DraftProductCandidate[] }>;
  value: { amount: number | null; source: "items" | "spoken" | null };
  proposalDate: string;
  followUp: { date: string; source: "default" | "observation"; suggestedByAi: boolean };
  expectedCloseDate: string;
  notes: string | null;
  warnings: DraftWarning[];
  pendingFields: string[];
  aiFields: string[];
  source: "ai" | "deterministic";
};

export const DRAFT_STAGES: DraftStage[] = ["prospeccao", "negociacao", "proposta"];
export const DRAFT_STAGE_LABELS: Record<DraftStage, string> = { prospeccao: "Prospecção", negociacao: "Negociação", proposta: "Proposta" };
// Mesmo padrão por etapa da rota de interpretação.
export const DRAFT_STAGE_PROBABILITY: Record<DraftStage, number> = { prospeccao: 20, negociacao: 50, proposta: 70 };
export const OPPORTUNITY_DRAFT_TTL_MS = 7 * 24 * 3_600_000;

export type DraftProductChoice = { productId: string; name: string; unit: string | null; tablePrice: number; source: "candidate" | "search" };
export type DraftCardItem = {
  key: string;
  spokenName: string;
  candidates: DraftProductCandidate[];
  product: DraftProductChoice | null;
  quantity: string;
  priceMode: "registered" | "informed";
  informedPrice: string;
  warnings: DraftWarning[];
  // Preenchidos na confirmação: item já gravado (não reenviar) ou erro da última tentativa.
  createdItemId?: string;
  error?: string;
};
export type DraftClientChoice = { id: string; name: string; city: string | null; state: string | null; source: "candidate" | "search" };
export type OpportunityDraftCard = {
  version: 1;
  id: string;
  // Validade de 7 dias contada a partir da interpretação.
  interpretedAt: string;
  text: string;
  source: "ai" | "deterministic";
  aiFields: string[];
  client: { spokenName: string | null; spokenCity: string | null; candidates: DraftClientCandidate[]; selected: DraftClientChoice | null };
  // Vendedor: ele mesmo (sellerId vazio, o servidor usa o usuário). Gerente/diretor: vendedor ativo escolhido.
  owner: { mode: "self" } | { mode: "pick"; sellerId: string; sellerName: string; edited: boolean };
  title: string;
  // Título refeito com o produto e o cliente escolhidos até o vendedor editar à mão (rascunho antigo: não editado).
  titleEdited?: boolean;
  stage: DraftStage;
  probability: string;
  probabilityEdited: boolean;
  priceTable: { code: "1" | "2"; label: string };
  items: DraftCardItem[];
  value: string;
  proposalDate: string;
  followUpDate: string;
  followUpSuggestedByAi: boolean;
  expectedCloseDate: string;
  notes: string;
  warnings: DraftWarning[];
  // Depois que POST /opportunities responde, a oportunidade não é criada de novo.
  createdOpportunityId: string | null;
  lastError: string | null;
};

export type PendingField = { field: string; message: string };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const toTwoDecimals = (value: number) => Math.round(value * 100) / 100;
const newId = () => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Sem crypto: cai no id por data.
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// Número digitado com vírgula ou ponto; vazio ou inválido = null.
export const parseDecimalInput = (value: string): number | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const itemFieldIndex = (field: string) => {
  const match = /^items\.(\d+)\./.exec(field);
  return match ? Number(match[1]) : null;
};

// "price_differs" sai: a diferença é recalculada na tela com o produto escolhido.
const isLiveWarning = (warning: DraftWarning) => warning.code !== "price_differs";

export const buildDraftCard = (
  response: OpportunityDraftResponse,
  text: string,
  options: { id?: string; now?: Date } = {}
): OpportunityDraftCard => {
  const items: DraftCardItem[] = response.items.map((item, index) => ({
    key: `item-${index + 1}`,
    spokenName: item.spokenName,
    candidates: item.candidates,
    product: null,
    quantity: item.quantity !== null ? String(item.quantity) : "",
    priceMode: item.price.mode,
    informedPrice: item.price.mode === "informed" ? String(item.price.amount) : "",
    warnings: response.warnings.filter((warning) => itemFieldIndex(warning.field) === index && isLiveWarning(warning))
  }));
  return {
    version: 1,
    id: options.id ?? newId(),
    interpretedAt: (options.now ?? new Date()).toISOString(),
    text,
    source: response.source,
    aiFields: response.aiFields,
    client: { spokenName: response.client.spokenName, spokenCity: response.client.spokenCity, candidates: response.client.candidates, selected: null },
    owner: response.owner.mode === "self" ? { mode: "self" } : { mode: "pick", sellerId: "", sellerName: "", edited: false },
    title: response.title,
    stage: response.stage.value,
    probability: String(response.probability),
    probabilityEdited: false,
    priceTable: response.priceTable,
    items,
    value: response.value.source === "spoken" && response.value.amount !== null ? String(response.value.amount) : "",
    proposalDate: response.proposalDate,
    followUpDate: response.followUp.date,
    followUpSuggestedByAi: response.followUp.suggestedByAi,
    expectedCloseDate: response.expectedCloseDate,
    notes: response.notes ?? "",
    warnings: response.warnings.filter((warning) => itemFieldIndex(warning.field) === null && isLiveWarning(warning)),
    createdOpportunityId: null,
    lastError: null
  };
};

// "Interpretar de novo": novo cartão da nova frase, no mesmo rascunho. As escolhas do cartão são refeitas.
export const reinterpretDraftCard = (previous: OpportunityDraftCard, response: OpportunityDraftResponse, text: string, now?: Date) =>
  buildDraftCard(response, text, { id: previous.id, now });

export const isDraftExpired = (card: Pick<OpportunityDraftCard, "interpretedAt">, now: Date = new Date()) => {
  const interpretedAt = Date.parse(card.interpretedAt);
  return !Number.isFinite(interpretedAt) || now.getTime() - interpretedAt >= OPPORTUNITY_DRAFT_TTL_MS;
};

export const isDraftCreated = (card: OpportunityDraftCard) => Boolean(card.createdOpportunityId);
// Depois de criada a oportunidade, só os itens ainda não gravados continuam editáveis.
export const isItemLocked = (item: DraftCardItem) => Boolean(item.createdItemId);

// "<produto do 1º item escolhido> – <cliente escolhido>"; sem nenhuma escolha, fica o título da interpretação.
export const draftAutoTitle = (card: OpportunityDraftCard): string => {
  const product = card.items.find((item) => item.product)?.product?.name.trim().slice(0, 120);
  const client = card.client.selected?.name.trim().slice(0, 120);
  if (product && client) return `${product} – ${client}`;
  if (client) return `Nova oportunidade – ${client}`;
  if (product) return `${product} – Cliente a definir`;
  return card.title;
};
const withAutoTitle = (card: OpportunityDraftCard): OpportunityDraftCard =>
  card.titleEdited || isDraftCreated(card) ? card : { ...card, title: draftAutoTitle(card) };

export const selectClientCandidate = (card: OpportunityDraftCard, clientId: string): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  const candidate = card.client.candidates.find((item) => item.id === clientId);
  if (!candidate) return card;
  const selected: DraftClientChoice = { id: candidate.id, name: candidate.name, city: candidate.city, state: candidate.state, source: "candidate" };
  // Gerente/diretor: o dono do cliente vira o responsável sugerido, se ainda não foi trocado à mão.
  const owner = card.owner.mode === "pick" && !card.owner.edited
    ? { ...card.owner, sellerId: candidate.suggestedOwner?.id ?? "", sellerName: candidate.suggestedOwner?.name ?? "" }
    : card.owner;
  return withAutoTitle({ ...card, client: { ...card.client, selected }, owner });
};

export const selectSearchedClient = (card: OpportunityDraftCard, client: { id: string; name: string; city?: string | null; state?: string | null } | null): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  const selected: DraftClientChoice | null = client ? { id: client.id, name: client.name, city: client.city ?? null, state: client.state ?? null, source: "search" } : null;
  return withAutoTitle({ ...card, client: { ...card.client, selected } });
};

export const setDraftOwner = (card: OpportunityDraftCard, seller: { id: string; name: string } | null): OpportunityDraftCard => {
  if (card.owner.mode !== "pick" || isDraftCreated(card)) return card;
  return { ...card, owner: { mode: "pick", sellerId: seller?.id ?? "", sellerName: seller?.name ?? "", edited: true } };
};

// Trocar a etapa volta a probabilidade ao padrão da etapa, salvo se o vendedor já editou a probabilidade.
export const setDraftStage = (card: OpportunityDraftCard, stage: DraftStage): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  return { ...card, stage, probability: card.probabilityEdited ? card.probability : String(DRAFT_STAGE_PROBABILITY[stage]) };
};

export const setDraftProbability = (card: OpportunityDraftCard, probability: string): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  return { ...card, probability, probabilityEdited: true };
};

type EditableFields = Pick<OpportunityDraftCard, "title" | "value" | "proposalDate" | "followUpDate" | "expectedCloseDate" | "notes">;
export const setDraftField = <K extends keyof EditableFields>(card: OpportunityDraftCard, field: K, value: EditableFields[K]): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  // O retorno escolhido à mão deixa de ser "sugerido pela IA"; o título editado à mão não é mais refeito.
  return { ...card, [field]: value, ...(field === "followUpDate" ? { followUpSuggestedByAi: false } : {}), ...(field === "title" ? { titleEdited: true } : {}) };
};

const updateItem = (card: OpportunityDraftCard, key: string, change: (item: DraftCardItem) => DraftCardItem): OpportunityDraftCard => ({
  ...card,
  items: card.items.map((item) => (item.key === key && !item.createdItemId ? change(item) : item))
});

export const selectProductCandidate = (card: OpportunityDraftCard, key: string, productId: string) =>
  withAutoTitle(updateItem(card, key, (item) => {
    const candidate = item.candidates.find((option) => option.productId === productId);
    if (!candidate) return item;
    return { ...item, product: { productId: candidate.productId, name: candidate.name, unit: candidate.unit, tablePrice: candidate.tablePrice, source: "candidate" } };
  }));

// Resultado de GET /products/search na tabela do rascunho: o preço da tabela vem da própria busca.
export type ProductSearchResult = { id: string; name: string; unit?: string | null; price?: number | null; className?: string | null; brand?: string | null };
export const readProductSearchResults = (data: unknown): ProductSearchResult[] =>
  (Array.isArray(data) ? data : []).filter((item): item is ProductSearchResult =>
    Boolean(item && typeof item.id === "string" && typeof item.name === "string" && Number.isFinite(Number(item.price)) && Number(item.price) > 0)
  );

export const selectSearchedProduct = (card: OpportunityDraftCard, key: string, product: ProductSearchResult) =>
  withAutoTitle(updateItem(card, key, (item) => ({
    ...item,
    product: { productId: product.id, name: product.name, unit: product.unit ?? null, tablePrice: toTwoDecimals(Number(product.price)), source: "search" }
  })));

export const productSearchUrl = (card: OpportunityDraftCard, query: string) => {
  const q = query.trim().slice(0, 120);
  return q ? `/products/search?q=${encodeURIComponent(q)}&priceTableCode=${encodeURIComponent(card.priceTable.code)}` : null;
};

type ItemFields = Pick<DraftCardItem, "quantity" | "priceMode" | "informedPrice">;
export const setItemField = <K extends keyof ItemFields>(card: OpportunityDraftCard, key: string, field: K, value: ItemFields[K]) =>
  updateItem(card, key, (item) => ({ ...item, [field]: value }));

export const addDraftItem = (card: OpportunityDraftCard): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  const next = card.items.reduce((max, item) => Math.max(max, Number(item.key.replace("item-", "")) || 0), 0) + 1;
  return {
    ...card,
    items: [...card.items, { key: `item-${next}`, spokenName: "", candidates: [], product: null, quantity: "", priceMode: "registered", informedPrice: "", warnings: [] }]
  };
};

export const removeDraftItem = (card: OpportunityDraftCard, key: string): OpportunityDraftCard => {
  if (isDraftCreated(card)) return card;
  return withAutoTitle({ ...card, items: card.items.filter((item) => item.key !== key) });
};

export const itemUnitPrice = (item: DraftCardItem): number | null => {
  if (!item.product) return null;
  if (item.priceMode === "registered") return item.product.tablePrice;
  const informed = parseDecimalInput(item.informedPrice);
  return informed !== null && informed > 0 ? toTwoDecimals(informed) : null;
};

// Mesma conta da rota de interpretação: (informado − tabela) / tabela, com 1 casa.
export const itemPriceDiffPercent = (item: DraftCardItem): number | null => {
  const unitPrice = itemUnitPrice(item);
  if (!item.product || item.priceMode !== "informed" || unitPrice === null || item.product.tablePrice <= 0) return null;
  return Number((((unitPrice - item.product.tablePrice) / item.product.tablePrice) * 100).toFixed(1));
};

export const itemTotal = (item: DraftCardItem): number | null => {
  const quantity = parseDecimalInput(item.quantity);
  const unitPrice = itemUnitPrice(item);
  return quantity !== null && quantity > 0 && unitPrice !== null ? toTwoDecimals(quantity * unitPrice) : null;
};

export const draftValue = (card: OpportunityDraftCard): number | null => {
  if (!card.items.length) {
    const value = parseDecimalInput(card.value);
    return value !== null && value > 0 ? toTwoDecimals(value) : null;
  }
  const totals = card.items.map(itemTotal);
  return totals.every((total) => total !== null) ? toTwoDecimals(totals.reduce((sum: number, total) => sum + (total ?? 0), 0)) : null;
};

// Pendências calculadas na tela a cada edição (a lista da rota vale só para o momento da interpretação).
export const draftPendingFields = (card: OpportunityDraftCard): PendingField[] => {
  const pending: PendingField[] = [];
  if (!card.client.selected) pending.push({ field: "clientId", message: "Escolha o cliente." });
  if (card.owner.mode === "pick" && !card.owner.sellerId) pending.push({ field: "ownerSellerId", message: "Escolha o responsável." });
  if (card.title.trim().length < 2) pending.push({ field: "title", message: "Informe o título." });
  const probability = parseDecimalInput(card.probability);
  if (probability === null || !Number.isInteger(probability) || probability < 0 || probability > 100) {
    pending.push({ field: "probability", message: "Probabilidade deve ser um número inteiro de 0 a 100." });
  }
  card.items.forEach((item, index) => {
    if (item.createdItemId) return;
    const label = card.items.length > 1 ? ` (item ${index + 1})` : "";
    if (!item.product) pending.push({ field: `items.${item.key}.productId`, message: `Escolha o produto${label}.` });
    const quantity = parseDecimalInput(item.quantity);
    if (quantity === null || quantity <= 0) pending.push({ field: `items.${item.key}.quantity`, message: `Informe a quantidade de sacas${label}.` });
    const informed = parseDecimalInput(item.informedPrice);
    if (item.priceMode === "informed" && (informed === null || informed <= 0)) {
      pending.push({ field: `items.${item.key}.unitPrice`, message: `Informe o preço${label}.` });
    }
  });
  if (!card.items.length && draftValue(card) === null) pending.push({ field: "value", message: "Sem produto: informe o valor da oportunidade." });
  if (!DAY_KEY.test(card.proposalDate)) pending.push({ field: "proposalDate", message: "Informe a data de entrada." });
  if (!DAY_KEY.test(card.followUpDate)) pending.push({ field: "followUpDate", message: "Informe a data de retorno." });
  else if (DAY_KEY.test(card.proposalDate) && card.followUpDate < card.proposalDate) {
    pending.push({ field: "followUpDate", message: "O retorno não pode ser antes da entrada." });
  }
  if (!DAY_KEY.test(card.expectedCloseDate)) pending.push({ field: "expectedCloseDate", message: "Informe o fechamento previsto." });
  if (card.notes.length > 2000) pending.push({ field: "notes", message: "Notas com no máximo 2000 caracteres." });
  return pending;
};

// Avisos da interpretação que ainda valem com o que foi escolhido no cartão.
export const draftActiveWarnings = (card: OpportunityDraftCard): DraftWarning[] =>
  card.warnings.filter((warning) => {
    if (warning.field === "clientId") return !card.client.selected;
    if (warning.field === "ownerSellerId") return card.owner.mode === "pick" && !card.owner.sellerId;
    if (warning.field === "value") return !card.items.length && draftValue(card) === null;
    return true;
  });

export const itemActiveWarnings = (item: DraftCardItem): DraftWarning[] =>
  item.warnings.filter((warning) => {
    if (warning.field.endsWith(".productId")) return !item.product;
    if (warning.field.endsWith(".quantity")) return !(Number(parseDecimalInput(item.quantity)) > 0);
    return true;
  });

// Vencido não cria; depois de criada a oportunidade, a validade não impede gravar os itens que faltam.
export const canCreateDraft = (card: OpportunityDraftCard, now: Date = new Date()) =>
  (isDraftCreated(card) || !isDraftExpired(card, now)) && draftPendingFields(card).length === 0;

export const buildOpportunityPayload = (card: OpportunityDraftCard) => {
  const notes = card.notes.trim();
  return {
    title: card.title.trim(),
    value: draftValue(card) ?? 0,
    stage: card.stage,
    probability: Number(parseDecimalInput(card.probability)),
    proposalEntryDate: card.proposalDate,
    expectedReturnDate: card.followUpDate,
    proposalDate: card.proposalDate,
    followUpDate: card.followUpDate,
    expectedCloseDate: card.expectedCloseDate,
    ...(notes ? { notes } : {}),
    clientId: card.client.selected?.id ?? "",
    // Vendedor não manda: o servidor usa o próprio usuário.
    ...(card.owner.mode === "pick" ? { ownerSellerId: card.owner.sellerId } : {}),
    priceTableCode: card.priceTable.code
  };
};

// Sem desconto: o preço informado vai como preço unitário (não há regra de desconto por perfil).
export const buildItemPayload = (item: DraftCardItem) => ({
  productId: item.product?.productId ?? "",
  productNameSnapshot: (item.product?.name ?? "").slice(0, 240),
  ...(item.product?.unit ? { unit: item.product.unit } : {}),
  quantity: Number(parseDecimalInput(item.quantity)),
  unitPrice: itemUnitPrice(item) ?? 0,
  discountType: "value" as const,
  discountValue: 0
});

export type DraftApi = { post: (url: string, body: unknown) => Promise<{ data?: any }> };
export type ConfirmResult =
  | { status: "done"; card: OpportunityDraftCard; opportunityId: string }
  | { status: "failed" | "partial" | "blocked"; card: OpportunityDraftCard };

// Cria a oportunidade (uma vez só) e os itens que faltam. onProgress recebe o cartão a cada passo gravado, para o
// rascunho no aparelho guardar o id criado mesmo se o app fechar no meio.
export const confirmOpportunityDraft = async (
  card: OpportunityDraftCard,
  api: DraftApi,
  options: { now?: Date; onProgress?: (card: OpportunityDraftCard) => void } = {}
): Promise<ConfirmResult> => {
  if (!canCreateDraft(card, options.now)) return { status: "blocked", card };
  let current: OpportunityDraftCard = { ...card, lastError: null };
  if (!current.createdOpportunityId) {
    try {
      const { data } = await api.post("/opportunities", buildOpportunityPayload(current));
      const id = data?.id || data?.item?.id || data?.opportunity?.id;
      if (!id) throw new Error("A oportunidade foi enviada, mas a resposta não trouxe o id.");
      current = { ...current, createdOpportunityId: String(id) };
      options.onProgress?.(current);
    } catch (error) {
      current = { ...current, lastError: getApiErrorMessage(error, "Não foi possível criar a oportunidade.") };
      return { status: "failed", card: current };
    }
  }
  const opportunityId = current.createdOpportunityId as string;
  for (const item of current.items) {
    if (item.createdItemId) continue;
    let next: DraftCardItem;
    try {
      const { data } = await api.post(`/opportunities/${opportunityId}/items`, buildItemPayload(item));
      next = { ...item, createdItemId: String(data?.id || "criado"), error: undefined };
    } catch (error) {
      next = { ...item, error: getApiErrorMessage(error, "Não foi possível salvar o item.") };
    }
    current = { ...current, items: current.items.map((entry) => (entry.key === item.key ? next : entry)) };
    options.onProgress?.(current);
  }
  if (current.items.some((item) => !item.createdItemId)) {
    current = { ...current, lastError: "Oportunidade criada, mas algum item não foi salvo. Use \"Tentar de novo\" para os itens pendentes." };
    return { status: "partial", card: current };
  }
  return { status: "done", card: current, opportunityId };
};
