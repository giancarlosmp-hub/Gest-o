import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { aiService } from "../services/ai/aiService.js";
import { defaultFollowUpDate, parseObservationDate } from "../services/opportunityDraftParser.js";
import { brazilTodayKey, shiftDayKey } from "../utils/dateRange.js";
import { signAccessToken } from "../utils/jwt.js";

// Rascunho de oportunidade por voz, fase 1: POST /ai/crm-assistant/opportunity-draft/parse só interpreta a frase e
// devolve candidatos, preços e avisos; não grava nada. Banco simulado em memória, IA simulada (nada sai da máquina),
// dados fictícios.
type Row = Record<string, any>;

const today = brazilTodayKey();
const past = new Date("2026-01-01T00:00:00.000Z");

const users: Row[] = [
  { id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A", isActive: true, tenantId: "tenant-a" },
  { id: "seller-b", role: "vendedor", name: "Vendedor Ficticio B", isActive: true, tenantId: "tenant-a" },
  { id: "seller-off", role: "vendedor", name: "Vendedor Desligado", isActive: false, tenantId: "tenant-a" },
  { id: "manager-a", role: "gerente", name: "Gerente Ficticio", isActive: true, tenantId: "tenant-a" },
  { id: "seller-no-tenant", role: "vendedor", name: "Vendedor Sem Tenant", isActive: true, tenantId: null }
];
const baseClient = { tenantId: "tenant-a", state: "PR", isArchived: false, fantasyName: null };
const clients: Row[] = [
  { ...baseClient, id: "c-alfa", name: "AGRO TESTE ALFA LTDA", fantasyName: "ALFA AGRO", city: "VILA SERENA", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-alfa-filial", name: "AGRO TESTE ALFA FILIAL", city: "CAMPO CLARO", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-alfa-sementes", name: "COMERCIAL ALFA SEMENTES", city: "VILA SERENA", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-beta", name: "AGRO TESTE BETA", city: "CAMPO CLARO", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-alfa-norte", name: "AGRO TESTE ALFA NORTE", city: "SERRA AZUL", ownerSellerId: "seller-b" },
  { ...baseClient, id: "c-delta", name: "AGRO TESTE DELTA", city: "SERRA AZUL", ownerSellerId: "seller-off" },
  { ...baseClient, id: "c-alfa-arquivada", name: "AGRO TESTE ALFA ARQUIVADA", city: "VILA SERENA", ownerSellerId: "seller-a", isArchived: true },
  { ...baseClient, id: "c-bonvita", name: "BONVITA COMERCIAL", city: "TOLEDO", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-bonvita-filial", name: "BONVITA FILIAL", city: "VILA SERENA", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-alfa-outro-tenant", name: "AGRO TESTE ALFA OUTRO", city: "VILA SERENA", ownerSellerId: "seller-a", tenantId: "tenant-b" }
];
const priceRow = (table: string, price: number) => ({ erpPriceId: table, branchCode: null, price, source: "prices", availabilityState: "available", validFrom: past, sourceChangedAt: past });
const baseProduct = { unit: "SC", isActive: true, isSuspended: false };
const products: Row[] = [
  { ...baseProduct, id: "p-aurora-10", name: "SEM BRACHIARIA BRIZANTHA AURORA", className: "PELETIZADA 10KG", brand: "SEMENTES EXEMPLO", rawErpPayload: { PESO_PRODUTO: 10 }, prices: [priceRow("1", 140), priceRow("2", 175)] },
  { ...baseProduct, id: "p-aurora-20", name: "SEM BRACHIARIA BRIZANTHA AURORA", className: "PELETIZADA 20KG", brand: "SEMENTES EXEMPLO", rawErpPayload: { PESO_PRODUTO: "20,000" }, prices: [priceRow("1", 260)] },
  { ...baseProduct, id: "p-boreal", name: "SEM CAPIM BOREAL", className: "INCRUSTADA 20KG", brand: "MARCA TESTE", rawErpPayload: { PESO_PRODUTO: 20 }, prices: [priceRow("1", 100)] },
  { ...baseProduct, id: "p-aurora-inativo", name: "SEM BRACHIARIA AURORA ANTIGA", className: "PELETIZADA 10KG", brand: "SEMENTES EXEMPLO", rawErpPayload: { PESO_PRODUTO: 10 }, prices: [priceRow("1", 120)], isActive: false },
  { ...baseProduct, id: "p-aurora-sem-preco", name: "SEM BRACHIARIA AURORA ZERADA", className: "PELETIZADA 10KG", brand: "SEMENTES EXEMPLO", rawErpPayload: { PESO_PRODUTO: 10 }, prices: [{ ...priceRow("1", 0), availabilityState: "explicit_zero" }] },
  { ...baseProduct, id: "p-marandu-10", name: "SEM MARANDU", className: "INCRUSTADA 10KG", brand: "VITAL SEED", rawErpPayload: { PESO_PRODUTO: 10 }, prices: [priceRow("1", 200)] },
  { ...baseProduct, id: "p-marandu-20", name: "SEM MARANDU", className: "INCRUSTADA 20KG", brand: "VITAL SEED", rawErpPayload: { PESO_PRODUTO: 20 }, prices: [priceRow("1", 380)] },
  { ...baseProduct, id: "p-mombaca-10", name: "SEM MOMBACA", className: "INCRUSTADA 10KG", brand: "VITAL SEED", rawErpPayload: { PESO_PRODUTO: 10 }, prices: [priceRow("1", 210)] },
  { ...baseProduct, id: "p-aurora-nao-sincronizado", name: "SEM BRACHIARIA AURORA LOCAL", className: "PELETIZADA 10KG", brand: "SEMENTES EXEMPLO", rawErpPayload: null, prices: [priceRow("1", 110)] }
];

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (condition && typeof condition === "object" && "contains" in condition) return String(row[key] ?? "").toLowerCase().includes(String(condition.contains).toLowerCase());
    return row[key] === condition;
  });
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};

const clientQueries: Row[] = [];
const writes: string[] = [];
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id && (where?.isActive === undefined || row.isActive === where.isActive));
    return user ? { id: user.id, email: `${user.id}@test.invalid`, role: user.role, region: null } : null;
  }
});
setModel("tenantMembership", {
  findMany: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.userId);
    return user?.tenantId ? [{ tenantId: user.tenantId }] : [];
  }
});
setModel("client", {
  findMany: async ({ where }: any) => {
    clientQueries.push(where);
    return clients.filter((row) => matches(row, where)).map((row) => {
      const owner = users.find((user) => user.id === row.ownerSellerId)!;
      return {
        id: row.id,
        name: row.name,
        fantasyName: row.fantasyName,
        city: row.city,
        state: row.state,
        ownerSeller: { id: owner.id, name: owner.name, role: owner.role, isActive: owner.isActive, tenantMemberships: owner.tenantId === "tenant-a" ? [{ tenantId: "tenant-a" }] : [] }
      };
    });
  }
});
setModel("product", { findMany: async ({ where }: any) => products.filter((row) => matches(row, where)).map((row) => ({ ...row, erpProductCode: row.id, erpProductClassCode: "1" })) });
setModel("appConfig", { findMany: async () => [] });
// Nada pode ser gravado: qualquer escrita nestes modelos fica registrada e falha o teste.
for (const model of ["opportunity", "opportunityItem", "timelineEvent", "client", "product"]) {
  const methods: Record<string, unknown> = {};
  for (const method of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) methods[method] = async () => { writes.push(`${model}.${method}`); throw new Error("write not allowed"); };
  setModel(model, methods);
}

// IA simulada: guarda o que recebeu e quem é cobrado; a resposta é definida por cenário.
let aiReply: string | null = null;
const aiCalls: Array<{ content: string; system: string; userId: string | null | undefined }> = [];
(aiService as any).chat = async (request: { system?: string; messages: Array<{ content: string }> }, options: { userId?: string | null } = {}) => {
  aiCalls.push({ content: request.messages[0]?.content ?? "", system: request.system ?? "", userId: options.userId });
  return aiReply === null ? null : { content: aiReply, provider: "fake", model: "fake" };
};

const logged: Row[] = [];
const originalInfo = console.info;
console.info = (payload: unknown) => { if (payload && typeof payload === "object") logged.push(payload as Row); };

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const PATH = "/ai/crm-assistant/opportunity-draft/parse";
const call = async (userId: string | null, body: unknown) => {
  const user = users.find((row) => row.id === userId);
  const response = await fetch(`${baseUrl}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { Authorization: `Bearer ${signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role })}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const parse = async (text: string, userId = "seller-a") => {
  const response = await call(userId, { text });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
};
const codes = (draft: Row) => draft.warnings.map((warning: Row) => warning.code);
const MODEL_PHRASE = "Nova oportunidade. Cliente Agro Teste Alfa, Vila Serena. Etapa proposta. Tabela revenda. Produto semente de braquiária Aurora, Sementes Exemplo, 10 quilos, 100 sacas, preço cadastrado. Observação: cliente pediu visita técnica.";

try {
  // 1. Frase-modelo.
  const model = await parse(MODEL_PHRASE);
  assert.deepEqual(model.client.candidates.map((candidate: Row) => candidate.id), ["c-alfa", "c-alfa-filial", "c-alfa-sementes", "c-beta"], "só a carteira do vendedor, no tenant, sem arquivados; cidade pesa");
  assert.equal(model.client.spokenName, "Agro Teste Alfa");
  assert.equal(model.client.spokenCity, "Vila Serena");
  assert.equal(model.client.candidates[0].suggestedOwner, null);
  assert.deepEqual(model.owner, { mode: "self", sellerId: "seller-a" });
  assert.deepEqual(clientQueries.at(-1)!.AND.slice(0, 2), [{ tenantId: "tenant-a", isArchived: false }, { ownerSellerId: "seller-a" }]);
  assert.equal(model.title, "Nova oportunidade – Agro Teste Alfa", "título neutro: a tela refaz com o produto e o cliente escolhidos");
  assert.deepEqual(model.stage, { value: "proposta", label: "Proposta" });
  assert.equal(model.probability, 70);
  assert.deepEqual(model.priceTable, { code: "1", label: "Tabela 1" });
  assert.equal(model.items.length, 1);
  assert.deepEqual(model.items[0].candidates.map((candidate: Row) => candidate.productId), ["p-aurora-10", "p-aurora-20"], "kg falado pesa; inativo, sem preço e não sincronizado ficam de fora");
  assert.deepEqual(
    (({ tablePrice, unitPrice, total, priceDiffPercent, weightKg, unit }) => ({ tablePrice, unitPrice, total, priceDiffPercent, weightKg, unit }))(model.items[0].candidates[0]),
    { tablePrice: 140, unitPrice: 140, total: 14000, priceDiffPercent: null, weightKg: 10, unit: "SC" }
  );
  assert.equal(model.items[0].candidates[1].weightKg, 20, "PESO_PRODUTO com vírgula");
  assert.deepEqual(model.value, { amount: 14000, source: "items" });
  assert.equal(model.proposalDate, today);
  assert.deepEqual(model.followUp, { date: defaultFollowUpDate(today), source: "default", suggestedByAi: false });
  assert.equal(model.expectedCloseDate, shiftDayKey(today, 30));
  assert.equal(model.notes, "cliente pediu visita técnica");
  assert.deepEqual(model.warnings, []);
  assert.deepEqual(model.pendingFields, ["clientId", "items.0.productId"], "o vendedor sempre escolhe cliente e produto");
  assert.deepEqual(model.aiFields, []);
  assert.equal(model.source, "deterministic");
  assert.equal(aiCalls.length, 0, "frase no padrão não chama a IA");
  const parsedLog = logged.filter((entry) => entry.message === "[opportunity-draft] parsed").at(-1);
  assert(parsedLog, "log do rascunho");
  assert(!/alfa|aurora|serena|visita/i.test(JSON.stringify(parsedLog)), "log sem conteúdo da frase");

  // 2. Ordem trocada, sem pontuação, consumidor final = Tabela 2 (só produtos com preço nela).
  const reordered = await parse("produto braquiaria Aurora 10 kg 100 sacas preço cadastrado etapa negociação tabela consumidor final cliente Agro Teste Alfa cidade Vila Serena");
  assert.equal(reordered.client.candidates[0].id, "c-alfa");
  assert.deepEqual(reordered.stage, { value: "negociacao", label: "Negociação" });
  assert.equal(reordered.probability, 50);
  assert.deepEqual(reordered.priceTable, { code: "2", label: "Tabela 2" });
  assert.deepEqual(reordered.items[0].candidates.map((candidate: Row) => [candidate.productId, candidate.tablePrice]), [["p-aurora-10", 175]]);
  assert.deepEqual(reordered.value, { amount: 17500, source: "items" });

  // 3. Sem tabela e sem etapa: Tabela 1 e Prospecção (20%).
  const noTable = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora 10 kg, 50 sacas");
  assert.deepEqual(noTable.priceTable, { code: "1", label: "Tabela 1" });
  assert.deepEqual(noTable.stage, { value: "prospeccao", label: "Prospecção" });
  assert.equal(noTable.probability, 20);
  assert.deepEqual(noTable.value, { amount: 7000, source: "items" });

  // 4 e 5. Preço informado abaixo e acima do cadastrado: só a diferença em %, sem bloquear (não há regra de desconto).
  const below = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 quilos, 100 sacas, preço R$ 130");
  assert.deepEqual(
    (({ tablePrice, unitPrice, total, priceDiffPercent }) => ({ tablePrice, unitPrice, total, priceDiffPercent }))(below.items[0].candidates[0]),
    { tablePrice: 140, unitPrice: 130, total: 13000, priceDiffPercent: -7.1 }
  );
  assert.deepEqual(codes(below), ["price_differs"]);
  assert.match(below.warnings[0].message, /7,1% abaixo do preço da Tabela 1/);
  assert(!below.pendingFields.some((field: string) => field.includes("unitPrice")), "preço diferente não fica pendente");
  const above = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 quilos, 100 sacas, preço R$ 150,00");
  assert.equal(above.items[0].candidates[0].priceDiffPercent, 7.1);
  assert.match(above.warnings[0].message, /7,1% acima/);
  const samePrice = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 quilos, 100 sacas, preço R$ 140");
  assert.equal(samePrice.items[0].candidates[0].priceDiffPercent, 0);
  assert.deepEqual(codes(samePrice), []);

  // 6. Dois produtos: lista de itens e valor pela soma.
  const twoProducts = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 quilos, 100 sacas, preço cadastrado. Produto capim Boreal, Marca Teste, 20 kg, 30 sacas, preço R$ 95,50");
  assert.equal(twoProducts.items.length, 2);
  assert.equal(twoProducts.items[0].candidates[0].productId, "p-aurora-10");
  // "marca" ~ "marandu" (3 letras iguais) entra como candidato fraco, depois do produto certo.
  assert.equal(twoProducts.items[1].candidates[0].productId, "p-boreal");
  assert.equal(twoProducts.items[1].candidates[0].priceDiffPercent, -4.5);
  assert.deepEqual(twoProducts.value, { amount: 16865, source: "items" });
  assert.deepEqual(twoProducts.pendingFields, ["clientId", "items.0.productId", "items.1.productId"]);

  // 7. Sem produto, com valor falado.
  const valueOnly = await parse("Nova oportunidade de R$ 50 mil, cliente Agro Teste Beta");
  assert.deepEqual(valueOnly.value, { amount: 50000, source: "spoken" });
  assert.equal(valueOnly.title, "Nova oportunidade – Agro Teste Beta");
  assert.equal(valueOnly.client.candidates[0].id, "c-beta");
  assert.deepEqual(valueOnly.items, []);
  const noValue = await parse("Cliente Agro Teste Beta. Etapa proposta");
  assert.deepEqual(noValue.value, { amount: null, source: null });
  assert(noValue.pendingFields.includes("value"));
  assert(codes(noValue).includes("value_missing"));
  assert.equal(aiCalls.length, 0, "frase no padrão sem produto e sem valor não chama a IA (não há o que ela achar)");

  // 8. Etapa "ganho" recusada com aviso; fica Prospecção.
  const won = await parse("Cliente Agro Teste Alfa. Etapa ganho. Valor R$ 10 mil");
  assert.deepEqual(won.stage, { value: "prospeccao", label: "Prospecção" });
  assert.equal(won.probability, 20);
  assert.deepEqual(codes(won), ["stage_refused"]);
  assert.match(won.warnings[0].message, /Ganho/);

  // 9. Data na observação vira o retorno sugerido; data passada é ignorada com aviso.
  const friday = parseObservationDate("sexta", today);
  assert(friday?.kind === "date");
  const withDate = await parse("Cliente Agro Teste Alfa. Valor R$ 10 mil. Observação: me ligue sexta");
  assert.deepEqual(withDate.followUp, { date: friday.date, source: "observation", suggestedByAi: true });
  assert.equal(withDate.notes, "me ligue sexta");
  assert.equal(aiCalls.length, 0, "data entendida pelas regras não chama a IA");
  const pastDate = await parse("Cliente Agro Teste Alfa. Valor R$ 10 mil. Observação: combinado em 05/01/2020");
  assert.deepEqual(pastDate.followUp, { date: defaultFollowUpDate(today), source: "default", suggestedByAi: false });
  assert.deepEqual(codes(pastDate), ["followup_past_ignored"]);

  // 10. Cliente ambíguo: até 5 candidatos, nunca escolha automática.
  const ambiguous = await parse("Cliente Alfa. Valor R$ 10 mil");
  assert.deepEqual(ambiguous.client.candidates.map((candidate: Row) => candidate.id).sort(), ["c-alfa", "c-alfa-filial", "c-alfa-sementes"]);
  assert(ambiguous.pendingFields.includes("clientId"));
  const unknownClient = await parse("Cliente Fazenda Inexistente. Valor R$ 10 mil");
  assert.deepEqual(unknownClient.client.candidates, []);
  assert.equal(unknownClient.title, "Nova oportunidade – Fazenda Inexistente");
  assert(codes(unknownClient).includes("client_not_found"));

  // 11. Produto não encontrado.
  const noProduct = await parse("Cliente Agro Teste Alfa. Produto milho imaginario, 10 sacas");
  assert.deepEqual(noProduct.items[0].candidates, []);
  assert(codes(noProduct).includes("product_not_found"));
  assert(noProduct.pendingFields.includes("items.0.productId"));
  assert(noProduct.pendingFields.includes("value"));
  const noQuantity = await parse("Cliente Agro Teste Alfa. Produto braquiária Aurora 10 kg");
  assert(codes(noQuantity).includes("quantity_missing"));
  assert.equal(noQuantity.items[0].candidates[0].total, null);

  // 11b. Ditado do teclado (frase de teste no celular, com cliente fictício): sem "cliente", sem "etapa", "sem sacas" =
  // 100 sacas, produto com o nome errado ("maru vital sides") casado por prefixo, consoantes e kg.
  const dictated = await parse("Bonvita Toledo produto Maru Vital Sides 10 quilo sem sacas prospecção");
  assert.equal(dictated.client.spokenName, "Bonvita");
  assert.equal(dictated.client.spokenCity, "Toledo");
  assert.deepEqual(dictated.client.candidates.map((candidate: Row) => candidate.id), ["c-bonvita", "c-bonvita-filial"], "cidade pesa; o vendedor ainda escolhe");
  assert(dictated.pendingFields.includes("clientId"));
  assert.deepEqual(dictated.stage, { value: "prospeccao", label: "Prospecção" });
  assert.equal(dictated.items.length, 1);
  assert.equal(dictated.items[0].spokenName, "Maru Vital Sides");
  assert.equal(dictated.items[0].kg, 10);
  assert.equal(dictated.items[0].quantity, 100);
  assert.deepEqual(dictated.items[0].candidates.map((candidate: Row) => candidate.productId), ["p-marandu-10", "p-mombaca-10", "p-marandu-20", "p-boreal"], "kg igual pesa mais; \"maru\" ~ \"marca\" entra por último");
  assert.deepEqual(dictated.items[0].candidates.map((candidate: Row) => candidate.score), [9, 8, 5, 1]);
  assert.equal(dictated.items[0].candidates[0].total, 20000);
  assert.equal(dictated.title, "Nova oportunidade – Bonvita");
  assert.deepEqual(dictated.aiFields, [], "frase ditada lida só pelas regras");
  const dictatedWords = await parse("Bonvita, Toledo. Produto marandu vital seed dez quilos duzentas sacas preço cento e noventa reais, cotação");
  assert.equal(dictatedWords.client.candidates[0].id, "c-bonvita");
  assert.deepEqual(dictatedWords.stage, { value: "proposta", label: "Proposta" });
  assert.equal(dictatedWords.items[0].candidates[0].productId, "p-marandu-10");
  assert.deepEqual(
    (({ unitPrice, total, priceDiffPercent }) => ({ unitPrice, total, priceDiffPercent }))(dictatedWords.items[0].candidates[0]),
    { unitPrice: 190, total: 38000, priceDiffPercent: -5 }
  );
  // Nenhuma palavra bate: só pelo kg dito, na mesma tabela.
  const byKg = await parse("Cliente Bonvita. Produto xyzw 10 kg 5 sacas");
  assert.deepEqual(byKg.items[0].candidates.map((candidate: Row) => candidate.productId).sort(), ["p-aurora-10", "p-marandu-10", "p-mombaca-10"]);
  assert(byKg.items[0].candidates.every((candidate: Row) => candidate.weightKg === 10));
  assert.match(unknownClient.warnings.find((warning: Row) => warning.code === "client_not_found").message, /Comece com 'Cliente <nome>, <cidade>'\./);

  // 12. Gerente: responsável sugerido é o vendedor dono do cliente; dono inativo deixa o responsável pendente.
  const manager = await parse("Cliente Agro Teste. Valor R$ 10 mil", "manager-a");
  assert.deepEqual(manager.owner, { mode: "client_owner" });
  assert(manager.pendingFields.includes("ownerSellerId"));
  const byId = Object.fromEntries(manager.client.candidates.map((candidate: Row) => [candidate.id, candidate]));
  assert.deepEqual(byId["c-alfa-norte"].suggestedOwner, { id: "seller-b", name: "Vendedor Ficticio B" }, "gerente vê a carteira do tenant");
  assert.equal(byId["c-alfa-norte"].ownerPending, false);
  assert.equal(byId["c-delta"].suggestedOwner, null);
  assert.equal(byId["c-delta"].ownerPending, true);
  assert(codes(manager).includes("owner_pending"));
  assert(!byId["c-alfa-arquivada"] && !byId["c-alfa-outro-tenant"]);
  assert.deepEqual(clientQueries.at(-1)!.AND[1], {}, "gerente sem filtro de vendedor");

  // 13. Frase fora do padrão: a IA recebe só a frase (até 300 caracteres) e preenche o que faltou.
  aiReply = JSON.stringify({ clientName: "Agro Teste Beta", city: null, stage: "negociacao", priceTable: null, products: [{ name: "braquiaria aurora", kg: 10, sacks: 20, price: null }], value: null, followUpDate: null });
  const freeText = "quero vender vinte sacas de aurora de dez quilos pro pessoal da agro teste beta, estamos negociando";
  const fromAi = await parse(freeText);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].content, freeText, "só a frase vai para a IA");
  assert.equal(aiCalls[0].userId, "seller-a", "cota de quem pediu");
  assert(!/c-alfa|p-aurora|VILA SERENA|SEMENTES EXEMPLO/.test(aiCalls[0].system + aiCalls[0].content), "nenhum dado do banco vai para a IA");
  assert.deepEqual(fromAi.aiFields, ["clientName", "items"], "etapa dita sem a palavra \"etapa\" já sai das regras");
  assert.equal(fromAi.source, "ai");
  assert.equal(fromAi.client.candidates[0].id, "c-beta");
  assert.deepEqual(fromAi.stage, { value: "negociacao", label: "Negociação" });
  assert.deepEqual(fromAi.items[0].candidates.map((candidate: Row) => candidate.productId), ["p-aurora-10", "p-aurora-20"]);
  assert.deepEqual(fromAi.value, { amount: 2800, source: "items" });

  // Cliente pelas regras, sacas sem a palavra "produto": a IA só completa os itens.
  aiReply = JSON.stringify({ clientName: "Outro Nome", products: [{ name: "aurora", kg: 10, sacks: 20 }] });
  const partial = await parse("Cliente Agro Teste Beta. Quer 20 sacas de aurora de 10 kg");
  assert.deepEqual(partial.aiFields, ["items"], "o que as regras acharam não é trocado pela IA");
  assert.equal(partial.client.spokenName, "Agro Teste Beta");
  assert.equal(partial.items[0].candidates[0].productId, "p-aurora-10");

  const longText = `cliente ${"x".repeat(400)}`;
  aiReply = null;
  await parse(longText.replace("cliente ", "falar com "));
  assert.equal(aiCalls.at(-1)!.content.length, 300, "corte de 300 caracteres");

  // IA desligada ou resposta fora do formato: segue com as regras fixas e avisa.
  const aiOff = await parse("quero falar com a agro teste beta");
  assert.deepEqual(codes(aiOff), ["ai_unavailable", "client_not_found", "value_missing"]);
  assert.equal(aiOff.source, "deterministic");
  aiReply = JSON.stringify({ clientName: "Agro Teste Beta", stage: "fechamento" });
  const aiInvalid = await parse("quero falar com a agro teste beta");
  assert.deepEqual(aiInvalid.aiFields, []);
  assert(codes(aiInvalid).includes("ai_unavailable"));
  aiReply = "isso não é json";
  assert(codes(await parse("quero falar com a agro teste beta")).includes("ai_unavailable"));

  // IA devolvendo "ganho" passa pela mesma recusa.
  aiReply = JSON.stringify({ clientName: "Agro Teste Beta", stage: "ganho", value: 5000 });
  const aiWon = await parse("fechei com a agro teste beta cinco mil");
  assert.deepEqual(aiWon.stage, { value: "prospeccao", label: "Prospecção" });
  assert(codes(aiWon).includes("stage_refused"));
  assert.deepEqual(aiWon.value, { amount: 5000, source: "spoken" });

  // 14. Data da observação que as regras não entendem: a IA recebe só a observação.
  const nextWeek = shiftDayKey(today, 7);
  aiReply = JSON.stringify({ followUpDate: nextWeek });
  const callsBefore = aiCalls.length;
  const aiDate = await parse("Cliente Agro Teste Alfa. Valor R$ 10 mil. Observação: retorno na semana que vem");
  assert.equal(aiCalls.length, callsBefore + 1);
  assert.equal(aiCalls.at(-1)!.content, "retorno na semana que vem");
  assert.deepEqual(aiDate.followUp, { date: nextWeek, source: "observation", suggestedByAi: true });
  assert.deepEqual(aiDate.aiFields, ["followUpDate"]);
  aiReply = JSON.stringify({ followUpDate: "2020-01-05" });
  const aiPast = await parse("Cliente Agro Teste Alfa. Valor R$ 10 mil. Observação: retorno na semana que vem");
  assert.deepEqual(aiPast.followUp, { date: defaultFollowUpDate(today), source: "default", suggestedByAi: false });
  assert(codes(aiPast).includes("followup_past_ignored"));
  aiReply = null;

  // 15. Autenticação, validação e tenant.
  assert.equal((await call(null, { text: MODEL_PHRASE })).status, 401);
  assert.equal((await call("seller-a", { text: "" })).status, 400);
  assert.equal((await call("seller-a", { text: "x".repeat(1001) })).status, 400);
  assert.equal((await call("seller-a", { text: MODEL_PHRASE, extra: true })).status, 400);
  assert.equal((await call("seller-no-tenant", { text: MODEL_PHRASE })).status, 403);
  assert.equal((await call("seller-off", { text: MODEL_PHRASE })).status, 401, "usuário inativo");

  // 16. Nada foi gravado.
  assert.deepEqual(writes, []);

  console.info = originalInfo;
  console.log("opportunity draft parse route: PASS");
} finally {
  console.info = originalInfo;
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}
