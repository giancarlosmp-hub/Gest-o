import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDraftItem,
  buildDraftCard,
  buildItemPayload,
  buildOpportunityPayload,
  canCreateDraft,
  confirmOpportunityDraft,
  draftActiveWarnings,
  draftPendingFields,
  draftValue,
  itemPriceDiffPercent,
  productSearchUrl,
  readProductSearchResults,
  reinterpretDraftCard,
  removeDraftItem,
  selectClientCandidate,
  selectProductCandidate,
  selectSearchedClient,
  selectSearchedProduct,
  setDraftField,
  setDraftOwner,
  setDraftProbability,
  setDraftStage,
  setItemField,
  OPPORTUNITY_DRAFT_TTL_MS,
  type OpportunityDraftResponse
} from "../src/lib/opportunityDraft";
import { listOpportunityDrafts, removeOpportunityDraft, saveOpportunityDraft } from "../src/lib/opportunityDraftStore";

// Oportunidade por frase (fase 2): cartão, pendências, payloads, confirmação e rascunhos no aparelho.
// Dados fictícios; API e armazenamento simulados.
const now = new Date("2026-10-28T13:00:00.000Z");
const product = (id: string, name: string, tablePrice: number) => ({
  productId: id, name, className: null, brand: null, unit: "SC", weightKg: 20, tablePrice, unitPrice: tablePrice, total: null, priceDiffPercent: null, score: 4
});
const response = (overrides: Partial<OpportunityDraftResponse> = {}): OpportunityDraftResponse => ({
  client: {
    spokenName: "fazenda ficticia",
    spokenCity: null,
    candidates: [
      { id: "cli-a", name: "Fazenda Ficticia A", fantasyName: null, city: "Cidade Exemplo", state: "GO", score: 6, suggestedOwner: { id: "sel-a", name: "Vendedor Ficticio A" }, ownerPending: false },
      { id: "cli-b", name: "Fazenda Ficticia B", fantasyName: null, city: "Cidade Exemplo", state: "GO", score: 4, suggestedOwner: null, ownerPending: true }
    ]
  },
  owner: { mode: "client_owner" },
  title: "Semente Teste – Fazenda Ficticia",
  stage: { value: "prospeccao", label: "Prospecção" },
  probability: 20,
  priceTable: { code: "1", label: "Tabela 1" },
  items: [
    { spokenName: "semente teste", kg: 20, quantity: 10, price: { mode: "informed", amount: 90 }, candidates: [product("prod-a", "Semente Teste 20kg", 100), product("prod-b", "Semente Teste 25kg", 120)] },
    { spokenName: "outro produto", kg: null, quantity: null, price: { mode: "registered" }, candidates: [] }
  ],
  value: { amount: null, source: null },
  proposalDate: "2026-10-28",
  followUp: { date: "2026-11-05", source: "observation", suggestedByAi: true },
  expectedCloseDate: "2026-11-27",
  notes: "cliente ficticio pediu retorno",
  warnings: [
    { code: "owner_pending", field: "ownerSellerId", message: "Responsável pendente em algum cliente sugerido." },
    { code: "price_differs", field: "items.0.unitPrice", message: "Preço informado abaixo." },
    { code: "product_not_found", field: "items.1.productId", message: "Produto não encontrado." },
    { code: "quantity_missing", field: "items.1.quantity", message: "Quantidade não informada." }
  ],
  pendingFields: ["clientId", "ownerSellerId", "items.0.productId", "items.1.productId", "items.1.quantity"],
  aiFields: ["followUpDate"],
  source: "ai",
  ...overrides
});

// Montagem do cartão: nada pré-selecionado, mesmo com um candidato só.
let card = buildDraftCard(response(), "frase ficticia", { id: "draft-1", now });
assert.equal(card.client.selected, null);
assert.equal(card.owner.mode, "pick");
assert.ok(card.items.every((item) => item.product === null), "produto nunca pré-selecionado");
assert.equal(card.items[0].quantity, "10");
assert.equal(card.items[0].priceMode, "informed");
assert.equal(card.items[0].informedPrice, "90");
assert.equal(card.followUpSuggestedByAi, true);
assert.equal(card.notes, "cliente ficticio pediu retorno");
assert.deepEqual(card.items[1].warnings.map((warning) => warning.code), ["product_not_found", "quantity_missing"]);
assert.ok(!card.warnings.some((warning) => warning.code === "price_differs"), "diferença de preço é recalculada na tela");
const single = buildDraftCard(response({ client: { spokenName: "x", spokenCity: null, candidates: [response().client.candidates[0]] } }), "frase", { now });
assert.equal(single.client.selected, null, "um candidato só ainda pede o toque do vendedor");
const self = buildDraftCard(response({ owner: { mode: "self", sellerId: "sel-self" } }), "frase", { now });
assert.equal(self.owner.mode, "self");

// Bloqueio com pendências.
assert.equal(canCreateDraft(card, now), false);
assert.deepEqual(draftPendingFields(card).map((item) => item.field), [
  "clientId", "ownerSellerId", "items.item-1.productId", "items.item-2.productId", "items.item-2.quantity"
]);

// Cliente candidato traz o dono sugerido; troca manual do responsável não é desfeita por nova escolha de cliente.
card = selectClientCandidate(card, "cli-a");
assert.equal(card.client.selected?.id, "cli-a");
assert.deepEqual(card.owner, { mode: "pick", sellerId: "sel-a", sellerName: "Vendedor Ficticio A", edited: false });
assert.ok(!draftActiveWarnings(card).some((warning) => warning.field === "ownerSellerId"));
card = setDraftOwner(card, { id: "sel-c", name: "Vendedor Ficticio C" });
card = selectClientCandidate(card, "cli-b");
assert.equal(card.owner.mode === "pick" && card.owner.sellerId, "sel-c");
const pendingOwner = selectClientCandidate(buildDraftCard(response(), "frase", { now }), "cli-b");
assert.ok(draftPendingFields(pendingOwner).some((item) => item.field === "ownerSellerId"), "dono pendente deixa o responsável a escolher");
assert.equal(selectSearchedClient(card, { id: "cli-manual", name: "Cliente Manual Ficticio", city: "Cidade", state: "MT" }).client.selected?.source, "search");

// Item: candidato, preço informado com diferença em %.
card = selectProductCandidate(card, "item-1", "prod-a");
assert.equal(itemPriceDiffPercent(card.items[0]), -10);
assert.equal(itemPriceDiffPercent(setItemField(card, "item-1", "priceMode", "registered").items[0]), null);

// Busca manual de produto na tabela do rascunho, com o preço da própria busca.
assert.equal(productSearchUrl(card, "  milho teste "), "/products/search?q=milho%20teste&priceTableCode=1");
assert.equal(productSearchUrl(card, "  "), null);
const found = readProductSearchResults([
  { id: "prod-m", name: "Milho Teste", unit: "SC", price: 55.5, className: null },
  { id: "prod-sem-preco", name: "Sem Preco", price: 0 },
  null
]);
assert.deepEqual(found.map((item) => item.id), ["prod-m"]);
card = selectSearchedProduct(card, "item-2", found[0]);
assert.deepEqual(card.items[1].product, { productId: "prod-m", name: "Milho Teste", unit: "SC", tablePrice: 55.5, source: "search" });
assert.ok(draftPendingFields(card).some((item) => item.field === "items.item-2.quantity"));
card = setItemField(card, "item-2", "quantity", "4");
assert.deepEqual(draftPendingFields(card), []);
assert.equal(canCreateDraft(card, now), true);
assert.equal(draftValue(card), 10 * 90 + 4 * 55.5);

// Adicionar/remover item; sem item, o valor é obrigatório.
const withExtra = addDraftItem(card);
assert.equal(withExtra.items[2].key, "item-3");
assert.ok(draftPendingFields(withExtra).some((item) => item.field === "items.item-3.productId"));
let noItems = removeDraftItem(removeDraftItem(card, "item-1"), "item-2");
assert.deepEqual(draftPendingFields(noItems).map((item) => item.field), ["value"]);
noItems = setDraftField(noItems, "value", "15000,50");
assert.equal(canCreateDraft(noItems, now), true);
assert.equal(buildOpportunityPayload(noItems).value, 15000.5);

// Regra da probabilidade: etapa volta ao padrão até o vendedor editar a probabilidade.
let stageCard = setDraftStage(card, "negociacao");
assert.equal(stageCard.probability, "50");
stageCard = setDraftStage(stageCard, "proposta");
assert.equal(stageCard.probability, "70");
stageCard = setDraftProbability(stageCard, "35");
stageCard = setDraftStage(stageCard, "prospeccao");
assert.equal(stageCard.probability, "35", "probabilidade editada não volta ao padrão");
assert.ok(draftPendingFields(setDraftProbability(card, "120")).some((item) => item.field === "probability"));

// Datas e retorno manual tiram o selo "sugerida pela IA".
assert.equal(setDraftField(card, "followUpDate", "2026-11-10").followUpSuggestedByAi, false);
assert.ok(draftPendingFields(setDraftField(card, "followUpDate", "2026-10-01")).some((item) => item.field === "followUpDate"));

// Título refeito com o produto e o cliente escolhidos (nunca com o texto cru), até o vendedor editar à mão.
const neutral = buildDraftCard(response({ title: "Nova oportunidade – Fazenda Ficticia" }), "frase", { now });
assert.equal(neutral.title, "Nova oportunidade – Fazenda Ficticia");
const titledClient = selectClientCandidate(neutral, "cli-a");
assert.equal(titledClient.title, "Nova oportunidade – Fazenda Ficticia A");
const titledProduct = selectProductCandidate(titledClient, "item-1", "prod-a");
assert.equal(titledProduct.title, "Semente Teste 20kg – Fazenda Ficticia A");
assert.equal(selectProductCandidate(neutral, "item-1", "prod-b").title, "Semente Teste 25kg – Cliente a definir");
assert.equal(selectProductCandidate(titledProduct, "item-1", "prod-b").title, "Semente Teste 25kg – Fazenda Ficticia A", "troca de produto refaz");
assert.equal(selectSearchedProduct(titledClient, "item-2", { id: "prod-m", name: "Milho Teste", price: 50 }).title, "Milho Teste – Fazenda Ficticia A", "1º item com produto escolhido");
const handTitled = setDraftField(titledProduct, "title", "Título do vendedor");
assert.equal(handTitled.titleEdited, true);
assert.equal(selectClientCandidate(handTitled, "cli-b").title, "Título do vendedor", "título editado não é refeito");
assert.equal(removeDraftItem(titledProduct, "item-1").title, "Nova oportunidade – Fazenda Ficticia A");
const oldStored = { ...neutral, titleEdited: undefined };
assert.equal(selectClientCandidate(oldStored, "cli-a").title, "Nova oportunidade – Fazenda Ficticia A", "rascunho antigo conta como não editado");

// Payloads de criação e de itens.
assert.equal(card.title, "Semente Teste 20kg – Fazenda Ficticia B");
assert.deepEqual(buildOpportunityPayload(card), {
  title: "Semente Teste 20kg – Fazenda Ficticia B",
  value: 1122,
  stage: "prospeccao",
  probability: 20,
  proposalEntryDate: "2026-10-28",
  expectedReturnDate: "2026-11-05",
  proposalDate: "2026-10-28",
  followUpDate: "2026-11-05",
  expectedCloseDate: "2026-11-27",
  notes: "cliente ficticio pediu retorno",
  clientId: "cli-b",
  ownerSellerId: "sel-c",
  priceTableCode: "1"
});
const selfCard = setItemField(
  selectProductCandidate(selectClientCandidate(removeDraftItem(self, "item-2"), "cli-a"), "item-1", "prod-b"),
  "item-1", "priceMode", "registered"
);
assert.equal("ownerSellerId" in buildOpportunityPayload(selfCard), false, "vendedor não manda responsável");
assert.deepEqual(buildItemPayload(card.items[0]), {
  productId: "prod-a", productNameSnapshot: "Semente Teste 20kg", unit: "SC", quantity: 10, unitPrice: 90, discountType: "value", discountValue: 0
});
assert.equal(buildItemPayload(selfCard.items[0]).unitPrice, 120, "preço cadastrado = preço da tabela");

// Confirmação: falha parcial de item e nova tentativa sem duplicar a oportunidade.
const calls: Array<{ url: string; body: any }> = [];
let failSecondItem = true;
const fakeApi = {
  post: async (url: string, body: unknown) => {
    calls.push({ url, body });
    if (url === "/opportunities") return { data: { id: "opp-ficticia" } };
    if ((body as any).productId === "prod-m" && failSecondItem) {
      throw { response: { status: 400, data: { message: "Produto ficticio indisponível." } } };
    }
    return { data: { id: `item-${calls.length}` } };
  }
};
const progress: string[] = [];
const first = await confirmOpportunityDraft(card, fakeApi, { now, onProgress: (next) => progress.push(next.createdOpportunityId ?? "") });
assert.equal(first.status, "partial");
assert.equal(first.card.createdOpportunityId, "opp-ficticia");
assert.equal(progress[0], "opp-ficticia", "id da oportunidade guardado antes dos itens");
assert.ok(first.card.items[0].createdItemId);
assert.equal(first.card.items[1].createdItemId, undefined);
assert.equal(first.card.items[1].error, "Produto ficticio indisponível.");
assert.match(first.card.lastError ?? "", /Tentar de novo/);
assert.deepEqual(calls.map((call) => call.url), ["/opportunities", "/opportunities/opp-ficticia/items", "/opportunities/opp-ficticia/items"]);
// Depois de criada: só os itens pendentes continuam editáveis.
const locked = setDraftField(selectClientCandidate(first.card, "cli-a"), "title", "Outro título");
assert.equal(locked.client.selected?.id, "cli-b");
assert.equal(locked.title, first.card.title);
assert.equal(setItemField(first.card, "item-1", "quantity", "99").items[0].quantity, "10", "item gravado fica travado");
assert.equal(setItemField(first.card, "item-2", "quantity", "5").items[1].quantity, "5", "item pendente continua editável");
assert.equal(addDraftItem(first.card).items.length, 2);
failSecondItem = false;
calls.length = 0;
const retry = await confirmOpportunityDraft(first.card, fakeApi, { now });
assert.equal(retry.status, "done");
assert.equal(retry.status === "done" && retry.opportunityId, "opp-ficticia");
assert.deepEqual(calls.map((call) => call.url), ["/opportunities/opp-ficticia/items"], "nova tentativa só manda o item pendente");
assert.equal(calls[0].body.productId, "prod-m");

// 403/409 da criação: mensagem da API e o rascunho continua sem id.
for (const status of [403, 409]) {
  const denied = await confirmOpportunityDraft(card, { post: async () => { throw { response: { status, data: { message: `Mensagem ficticia ${status}` } } }; } }, { now });
  assert.equal(denied.status, "failed");
  assert.equal(denied.card.createdOpportunityId, null);
  assert.equal(denied.card.lastError, `Mensagem ficticia ${status}`);
}
assert.equal((await confirmOpportunityDraft(buildDraftCard(response(), "frase", { now }), fakeApi, { now })).status, "blocked");

// "Interpretar de novo": mesmo rascunho, nova frase, escolhas refeitas e validade renovada.
const later = new Date(now.getTime() + 2 * 24 * 3_600_000);
const redone = reinterpretDraftCard(card, response({ stage: { value: "negociacao", label: "Negociação" }, probability: 50 }), "frase ficticia corrigida", later);
assert.equal(redone.id, card.id);
assert.equal(redone.text, "frase ficticia corrigida");
assert.equal(redone.client.selected, null);
assert.ok(redone.items.every((item) => item.product === null));
assert.equal(redone.stage, "negociacao");
assert.equal(redone.interpretedAt, later.toISOString());

// Validade de 7 dias e armazenamento por usuário.
const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  };
};
const blockedStorage = {
  getItem: () => { throw new Error("SecurityError ficticio"); },
  setItem: () => { throw new Error("QuotaExceededError ficticio"); },
  removeItem: () => { throw new Error("SecurityError ficticio"); }
};
const storage = memoryStorage();
assert.equal(saveOpportunityDraft("user-a", card, { storage }), true);
assert.equal(saveOpportunityDraft("user-a", buildDraftCard(response(), "segunda", { id: "draft-2", now: later }), { storage }), true);
assert.equal(saveOpportunityDraft("user-a", setDraftField(card, "title", "Editado"), { storage }), true, "editar regrava o mesmo rascunho");
let stored = listOpportunityDrafts("user-a", { storage, now: later });
assert.deepEqual(stored.map((item) => item.card.id), ["draft-2", "draft-1"]);
assert.equal(stored[1].card.title, "Editado");
assert.deepEqual(listOpportunityDrafts("user-b", { storage, now }), [], "rascunho é por usuário");
const justBefore = new Date(now.getTime() + OPPORTUNITY_DRAFT_TTL_MS - 1);
assert.equal(listOpportunityDrafts("user-a", { storage, now: justBefore }).find((item) => item.card.id === "draft-1")?.expired, false);
const expiredAt = new Date(now.getTime() + OPPORTUNITY_DRAFT_TTL_MS);
stored = listOpportunityDrafts("user-a", { storage, now: expiredAt });
assert.equal(stored.find((item) => item.card.id === "draft-1")?.expired, true, "vencido continua na lista, marcado");
assert.equal(canCreateDraft(card, expiredAt), false, "vencido não cria");
assert.equal(canCreateDraft(first.card, expiredAt), true, "depois de criada, a validade não impede tentar de novo os itens");
assert.equal(removeOpportunityDraft("user-a", "draft-1", { storage }), true);
assert.deepEqual(listOpportunityDrafts("user-a", { storage, now }).map((item) => item.card.id), ["draft-2"]);
storage.data.set("gest-o:opportunity-drafts:user-c", "{json quebrado");
assert.deepEqual(listOpportunityDrafts("user-c", { storage, now }), []);

// Armazenamento bloqueado ou ausente não quebra.
assert.deepEqual(listOpportunityDrafts("user-a", { storage: blockedStorage, now }), []);
assert.equal(saveOpportunityDraft("user-a", card, { storage: blockedStorage }), false);
assert.equal(removeOpportunityDraft("user-a", "draft-1", { storage: blockedStorage }), false);
assert.equal(saveOpportunityDraft("user-a", card, { storage: null }), false);
assert.equal(saveOpportunityDraft(null, card, { storage }), false);

// Logout não apaga os rascunhos de oportunidade (só a visita em andamento).
const auth = readFileSync(new URL("../src/context/AuthContext.tsx", import.meta.url), "utf8");
assert.doesNotMatch(auth, /opportunityDraft/);

console.log("OPPORTUNITY_DRAFT=PASS");
