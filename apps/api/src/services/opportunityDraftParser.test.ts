import assert from "node:assert/strict";
import { defaultFollowUpDate, parseDraftText, parseObservationDate, parseSpokenNumber } from "./opportunityDraftParser.js";

// Leitura da frase do rascunho de oportunidade só com regras fixas. Frases e nomes fictícios; data fixa
// (2026-10-28 é uma quarta-feira).
const WEDNESDAY = "2026-10-28";
const FRIDAY = "2026-10-30";

// Frase-modelo.
const model = parseDraftText(
  "Nova oportunidade. Cliente Agro Teste Alfa, Vila Serena. Etapa proposta. Tabela revenda. Produto semente de braquiária Aurora, Sementes Exemplo, 10 quilos, 100 sacas, preço cadastrado. Observação: cliente pediu visita técnica.",
  WEDNESDAY
);
assert.equal(model.clientName, "Agro Teste Alfa");
assert.equal(model.clientCity, "Vila Serena");
assert.equal(model.stage, "proposta");
assert.equal(model.priceTable, "1");
assert.equal(model.items.length, 1);
assert.equal(model.items[0].spokenName, "braquiária Aurora Sementes Exemplo");
assert.deepEqual(model.items[0].words, ["braquiaria", "aurora", "sementes", "exemplo"]);
assert.equal(model.items[0].kg, 10);
assert.equal(model.items[0].quantity, 100);
assert.deepEqual(model.items[0].price, { mode: "registered" });
assert.equal(model.value, null);
assert.equal(model.notes, "cliente pediu visita técnica");
assert.equal(model.observationDate, null);
assert.equal(model.observationHasDateHint, false);

// Ordem trocada e sem pontuação (como sai do reconhecimento de voz).
const reordered = parseDraftText(
  "produto braquiaria Aurora 10 kg 100 sacas preço cadastrado etapa negociação tabela consumidor final cliente Agro Teste Alfa cidade Vila Serena",
  WEDNESDAY
);
assert.equal(reordered.clientName, "Agro Teste Alfa");
assert.equal(reordered.clientCity, "Vila Serena");
assert.equal(reordered.stage, "negociacao");
assert.equal(reordered.priceTable, "2");
assert.equal(reordered.items[0].kg, 10);
assert.equal(reordered.items[0].quantity, 100);

// Sem tabela: nada falado (o serviço usa a Tabela 1). Tabela 2 por número; tabela desconhecida vira aviso.
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Produto braquiária Aurora, 50 sacas", WEDNESDAY).priceTable, null);
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Tabela 2. Produto braquiária Aurora, 50 sacas", WEDNESDAY).priceTable, "2");
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Tabela especial. Produto braquiária Aurora", WEDNESDAY).priceTableUnrecognized, true);

// "Preço da tabela" é preço cadastrado, não a palavra-chave tabela.
const tablePrice = parseDraftText("Cliente Agro Teste Alfa. Produto braquiária Aurora 20 sacas preço da tabela", WEDNESDAY);
assert.deepEqual(tablePrice.items[0].price, { mode: "registered" });
assert.equal(tablePrice.priceTable, null);

// Preço informado.
const informed = parseDraftText("Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 kg, 100 sacas, preço R$ 130", WEDNESDAY);
assert.deepEqual(informed.items[0].price, { mode: "informed", amount: 130 });
assert.deepEqual(parseDraftText("Cliente Agro Teste Alfa. Produto braquiária Aurora, preço R$ 1.500,50, 10 sacas", WEDNESDAY).items[0], {
  spokenName: "braquiária Aurora",
  words: ["braquiaria", "aurora"],
  kg: null,
  quantity: 10,
  price: { mode: "informed", amount: 1500.5 }
});

// Dois produtos na mesma frase.
const twoProducts = parseDraftText(
  "Cliente Agro Teste Alfa. Produto braquiária Aurora, 10 quilos, 100 sacas, preço cadastrado. Produto capim Boreal, Marca Teste, 20 kg, 30 sacas, preço R$ 95,50",
  WEDNESDAY
);
assert.equal(twoProducts.items.length, 2);
assert.deepEqual(twoProducts.items.map((item) => [item.spokenName, item.kg, item.quantity]), [["braquiária Aurora", 10, 100], ["capim Boreal Marca Teste", 20, 30]]);
assert.deepEqual(twoProducts.items[1].price, { mode: "informed", amount: 95.5 });

// Sem produto, com valor falado.
const valueOnly = parseDraftText("Nova oportunidade de R$ 50 mil, cliente Agro Teste Beta", WEDNESDAY);
assert.equal(valueOnly.value, 50000);
assert.equal(valueOnly.items.length, 0);
assert.equal(parseDraftText("Cliente Agro Teste Beta. Valor 12.500", WEDNESDAY).value, 12500);

// Sinal de frase fora do padrão: falou de sacas/dinheiro sem a palavra-chave produto ou valor.
assert.equal(parseDraftText("Cliente Agro Teste Beta. Etapa proposta", WEDNESDAY).productOrValueHint, false);
const hinted = parseDraftText("Cliente Agro Teste Beta. Quer 20 sacas de aurora", WEDNESDAY);
assert.equal(hinted.productOrValueHint, true);
assert.equal(hinted.clientName, "Agro Teste Beta", "o nome do cliente termina no fim da sentença");

// Etapa "ganho"/"perdido" é recusada; etapa com apelido é aceita; etapa desconhecida vira aviso.
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Etapa ganho", WEDNESDAY).refusedStage, "ganho");
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Etapa perdida", WEDNESDAY).refusedStage, "perdido");
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Etapa prospectando", WEDNESDAY).stage, "prospeccao");
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Etapa orçamento", WEDNESDAY).stage, "proposta");
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Etapa qualquer", WEDNESDAY).stageUnrecognized, true);

// Data na observação.
const withDate = parseDraftText("Cliente Agro Teste Alfa. Observação: me ligue sexta para fechar", WEDNESDAY);
assert.equal(withDate.notes, "me ligue sexta para fechar");
assert.deepEqual(withDate.observationDate, { kind: "date", date: "2026-10-30" });
assert.deepEqual(parseObservationDate("me ligue sexta", FRIDAY), { kind: "date", date: "2026-11-06" }, "sexta dita numa sexta é a seguinte");
assert.deepEqual(parseObservationDate("volto a falar dia 5", WEDNESDAY), { kind: "date", date: "2026-11-05" });
assert.deepEqual(parseObservationDate("volto a falar dia 28", WEDNESDAY), { kind: "date", date: "2026-10-28" });
assert.deepEqual(parseObservationDate("retorno em 10/11", WEDNESDAY), { kind: "date", date: "2026-11-10" });
assert.deepEqual(parseObservationDate("retorno dia 3 de dezembro", WEDNESDAY), { kind: "date", date: "2026-12-03" });
assert.deepEqual(parseObservationDate("ligar amanhã", WEDNESDAY), { kind: "date", date: "2026-10-29" });
assert.deepEqual(parseObservationDate("ligar depois de amanhã", WEDNESDAY), { kind: "date", date: "2026-10-30" });
assert.deepEqual(parseObservationDate("combinado em 01/10", WEDNESDAY), { kind: "past", date: "2026-10-01" });
assert.equal(parseObservationDate("quer amostra", WEDNESDAY), null);
assert.equal(parseDraftText("Cliente Agro Teste Alfa. Obs: retorno na semana que vem", WEDNESDAY).observationHasDateHint, true);

// Retorno padrão: hoje + 3 dias; fim de semana vai para a segunda.
assert.equal(defaultFollowUpDate("2026-10-27"), "2026-10-30");
assert.equal(defaultFollowUpDate(WEDNESDAY), "2026-11-02", "cai no sábado");
assert.equal(defaultFollowUpDate("2026-10-29"), "2026-11-02", "cai no domingo");

// Números falados.
assert.equal(parseSpokenNumber("130"), 130);
assert.equal(parseSpokenNumber("130,50"), 130.5);
assert.equal(parseSpokenNumber("50.000"), 50000);
assert.equal(parseSpokenNumber("130.5"), 130.5);

console.log("opportunity draft parser: PASS");
